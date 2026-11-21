/**
 * MySQL / MariaDB storage backend.
 *
 * Optional: requires the `mysql2` driver to be installed (`npm i mysql2`). Selected
 * via config `{ kind: 'mysql', url: 'mysql://user:pass@host/db' }`. Same schema
 * shape as the other backends: base columns plus a JSON `doc` column.
 */
import type { MemoryRecord } from '../core/types.ts'
import type { MemoryStore } from './adapter.ts'

/** Minimal shape of the mysql2 pool we use. */
interface MysqlPool {
  query(text: string, values?: unknown[]): Promise<[Record<string, unknown>[], unknown]>
  end(): Promise<void>
}

/** MySQL-backed memory store. */
export class MysqlStore implements MemoryStore {
  readonly backend = 'mysql'
  private pool: MysqlPool | undefined

  /**
   * @param url - connection string, e.g. mysql://user:pass@host:3306/db.
   * @param table - table name (default `memories`).
   */
  constructor(private readonly url: string, private readonly table = 'memories') {}

  private async pool_(): Promise<MysqlPool> {
    if (this.pool !== undefined) return this.pool
    let mod: { createPool?: (url: string) => MysqlPool; default?: { createPool?: (url: string) => MysqlPool } }
    try {
      mod = (await import('mysql2/promise' as string)) as typeof mod
    } catch {
      throw new Error('The "mysql" backend requires the "mysql2" package. Install it with: npm i mysql2')
    }
    const create = mod.createPool ?? mod.default?.createPool
    if (create === undefined) throw new Error('mysql2 package did not expose createPool.')
    this.pool = create(this.url)
    return this.pool
  }

  async init(): Promise<void> {
    const pool = await this.pool_()
    const t = this.table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id VARCHAR(64) PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        origin VARCHAR(16) NOT NULL,
        source VARCHAR(512),
        importance DOUBLE NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT,
        doc JSON NOT NULL,
        INDEX idx_${t}_kind (kind),
        INDEX idx_${t}_source (source),
        INDEX idx_${t}_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `)
  }

  async put(record: MemoryRecord): Promise<void> {
    const pool = await this.pool_()
    await pool.query(
      `INSERT INTO ${this.table} (id, kind, origin, source, importance, created_at, updated_at, expires_at, doc)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         kind=VALUES(kind), origin=VALUES(origin), source=VALUES(source),
         importance=VALUES(importance), created_at=VALUES(created_at),
         updated_at=VALUES(updated_at), expires_at=VALUES(expires_at), doc=VALUES(doc)`,
      [
        record.id, record.kind, record.origin, record.source ?? null, record.importance,
        record.createdAt, record.updatedAt, record.expiresAt ?? null, JSON.stringify(record),
      ],
    )
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const pool = await this.pool_()
    const [rows] = await pool.query(`SELECT doc FROM ${this.table} WHERE id = ?`, [id])
    const row = rows[0]
    if (row === undefined) return undefined
    return typeof row.doc === 'string' ? (JSON.parse(row.doc) as MemoryRecord) : (row.doc as MemoryRecord)
  }

  async delete(id: string): Promise<boolean> {
    const pool = await this.pool_()
    const [result] = await pool.query(`DELETE FROM ${this.table} WHERE id = ?`, [id])
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0
    return affected > 0
  }

  async all(): Promise<MemoryRecord[]> {
    const pool = await this.pool_()
    const [rows] = await pool.query(`SELECT doc FROM ${this.table}`)
    return rows.map(row => (typeof row.doc === 'string' ? (JSON.parse(row.doc) as MemoryRecord) : (row.doc as MemoryRecord)))
  }

  async close(): Promise<void> {
    await this.pool?.end()
  }
}
