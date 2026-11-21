/**
 * PostgreSQL storage backend.
 *
 * Optional: requires the `pg` driver to be installed (`npm i pg`). Selected via
 * config `{ kind: 'pg', url: 'postgres://...' }`. Mirrors the SQLite schema:
 * one `memories` table with hot columns plus a JSON `doc` blob.
 */
import type { MemoryRecord } from '../core/types.ts'
import type { MemoryStore } from './adapter.ts'

/** Minimal shape of the `pg` Pool we use (avoids a hard type dependency). */
interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
}

/** PostgreSQL-backed memory store. */
export class PgStore implements MemoryStore {
  readonly backend = 'pg'
  private pool: PgPool | undefined

  /**
   * @param url - connection string, e.g. postgres://user:pass@host:5432/db.
   * @param table - table name (default `memories`).
   */
  constructor(private readonly url: string, private readonly table = 'memories') {}

  private async pool_(): Promise<PgPool> {
    if (this.pool !== undefined) return this.pool
    let pg: { default?: { Pool: new (cfg: { connectionString: string }) => PgPool }; Pool?: new (cfg: { connectionString: string }) => PgPool }
    try {
      // Variable specifier keeps the optional dependency out of static type resolution.
      pg = (await import('pg' as string)) as typeof pg
    } catch {
      throw new Error('The "pg" backend requires the "pg" package. Install it with: npm i pg')
    }
    const PoolCtor = pg.Pool ?? pg.default?.Pool
    if (PoolCtor === undefined) throw new Error('pg package did not expose a Pool constructor.')
    this.pool = new PoolCtor({ connectionString: this.url })
    return this.pool
  }

  async init(): Promise<void> {
    const pool = await this.pool_()
    const t = this.table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        source TEXT,
        importance DOUBLE PRECISION NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT,
        doc JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${t}_kind ON ${t}(kind);
      CREATE INDEX IF NOT EXISTS idx_${t}_source ON ${t}(source);
      CREATE INDEX IF NOT EXISTS idx_${t}_updated ON ${t}(updated_at);
    `)
  }

  async put(record: MemoryRecord): Promise<void> {
    const pool = await this.pool_()
    await pool.query(
      `INSERT INTO ${this.table} (id, kind, origin, source, importance, created_at, updated_at, expires_at, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         kind=EXCLUDED.kind, origin=EXCLUDED.origin, source=EXCLUDED.source,
         importance=EXCLUDED.importance, created_at=EXCLUDED.created_at,
         updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at, doc=EXCLUDED.doc`,
      [
        record.id, record.kind, record.origin, record.source ?? null, record.importance,
        record.createdAt, record.updatedAt, record.expiresAt ?? null, JSON.stringify(record),
      ],
    )
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const pool = await this.pool_()
    const res = await pool.query(`SELECT doc FROM ${this.table} WHERE id = $1`, [id])
    const row = res.rows[0]
    return row === undefined ? undefined : (row.doc as MemoryRecord)
  }

  async delete(id: string): Promise<boolean> {
    const pool = await this.pool_()
    const res = await pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id])
    return (res.rowCount ?? 0) > 0
  }

  async all(): Promise<MemoryRecord[]> {
    const pool = await this.pool_()
    const res = await pool.query(`SELECT doc FROM ${this.table}`)
    return res.rows.map(row => row.doc as MemoryRecord)
  }

  async close(): Promise<void> {
    await this.pool?.end()
  }
}
