/**
 * pgvector-backed store (mode=remote).
 *
 * Uses PostgreSQL + the `pgvector` extension. One table per collection holding:
 * id (text PK), kind, source, updated_at, doc (jsonb = full MemoryRecord), and
 * embedding (vector). A cosine HNSW/ivfflat index backs ANN search via `<=>`.
 *
 * Requires the `pg` driver and a Postgres with `CREATE EXTENSION vector`.
 * The store satisfies the full `MemoryStore` contract; `vectorSearch()` runs ANN.
 */
import type { MemoryRecord } from '../../core/types.ts'
import type { MemoryStore, AuditEntry } from '../adapter.ts'
import type { VectorStoreConfig } from './config.ts'

/** Minimal pg Pool shape. */
interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
}

/** pgvector-backed memory store. */
export class PgVectorStore implements MemoryStore {
  readonly backend = 'pgvector'
  private pool: PgPool | undefined
  private readonly url: string
  private readonly table: string
  private readonly dim: number
  private readonly audits: AuditEntry[] = []

  constructor(config: VectorStoreConfig) {
    if (config.url === undefined || config.url === '') throw new Error('pgvector requires remote.url (postgres://…)')
    this.url = config.url
    this.table = sanitizeIdent(config.collection ?? 'memorydex')
    this.dim = config.dim ?? 1024
  }

  private async pool_(): Promise<PgPool> {
    if (this.pool !== undefined) return this.pool
    let pg: { default?: { Pool: new (cfg: { connectionString: string }) => PgPool }; Pool?: new (cfg: { connectionString: string }) => PgPool }
    try { pg = (await import('pg' as string)) as typeof pg } catch { throw new Error('pgvector requires the "pg" package: npm i pg') }
    const PoolCtor = pg.Pool ?? pg.default?.Pool
    if (PoolCtor === undefined) throw new Error('pg package did not expose a Pool constructor.')
    this.pool = new PoolCtor({ connectionString: this.url })
    return this.pool
  }

  async init(): Promise<void> {
    const pool = await this.pool_()
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    const t = this.table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source TEXT,
        updated_at BIGINT NOT NULL,
        doc JSONB NOT NULL,
        embedding vector(${this.dim})
      );
      CREATE INDEX IF NOT EXISTS idx_${t}_updated ON ${t}(updated_at);
    `)
    // HNSW cosine index (works on pgvector >= 0.5). Best-effort.
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_${t}_emb ON ${t} USING hnsw (embedding vector_cosine_ops)`)
    } catch { /* older pgvector: skip ANN index, still correct */ }
  }

  private vecLiteral(emb: readonly number[] | undefined): string | null {
    if (emb === undefined) return null
    return `[${emb.map(v => Number(v)).join(',')}]`
  }

  async put(record: MemoryRecord): Promise<void> {
    const pool = await this.pool_()
    await pool.query(
      `INSERT INTO ${this.table} (id, kind, source, updated_at, doc, embedding)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, source=EXCLUDED.source,
         updated_at=EXCLUDED.updated_at, doc=EXCLUDED.doc, embedding=EXCLUDED.embedding`,
      [record.id, record.kind, record.source ?? null, record.updatedAt, JSON.stringify(record), this.vecLiteral(record.embedding)],
    )
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const pool = await this.pool_()
    const res = await pool.query(`SELECT doc FROM ${this.table} WHERE id = $1`, [id])
    return res.rows[0]?.doc as MemoryRecord | undefined
  }

  async delete(id: string): Promise<boolean> {
    const pool = await this.pool_()
    const res = await pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id])
    return (res.rowCount ?? 0) > 0
  }

  async all(): Promise<MemoryRecord[]> {
    const pool = await this.pool_()
    const res = await pool.query(`SELECT doc FROM ${this.table}`)
    return res.rows.map(r => r.doc as MemoryRecord)
  }

  /**
   * ANN cosine search.
   * @param vector - query embedding.
   * @param limit - max hits.
   */
  async vectorSearch(vector: readonly number[], limit = 20): Promise<{ record: MemoryRecord; score: number }[]> {
    const pool = await this.pool_()
    const res = await pool.query(
      `SELECT doc, 1 - (embedding <=> $1) AS score FROM ${this.table} WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT $2`,
      [this.vecLiteral(vector), limit],
    )
    return res.rows.map(r => ({ record: r.doc as MemoryRecord, score: Number(r.score) }))
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry); if (this.audits.length > 1000) this.audits.shift()
  }
  async listAudit(limit = 200): Promise<AuditEntry[]> { return [...this.audits].reverse().slice(0, limit) }

  async close(): Promise<void> { await this.pool?.end() }
}

/** Keep table identifiers safe. */
function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60) || 'memorydex'
}
