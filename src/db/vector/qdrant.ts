/**
 * Qdrant-backed store (mode=remote).
 *
 * Each memory is one Qdrant point: the point `id` is a UUID derived from the memory
 * id, the point `vector` is the record's embedding (required for remote mode), and
 * the point `payload` carries the full `MemoryRecord` JSON under key `record`.
 *
 * The store satisfies the full `MemoryStore` contract so the rest of the system is
 * unchanged: filtering/scoring still happens in the service layer over `all()`
 * (scroll), while `vectorSearch()` is available for ANN top-k.
 *
 * Requires a running Qdrant. Configure `remote.url` / `remote.collection`.
 */
import { createHash } from 'node:crypto'
import type { MemoryRecord } from '../../core/types.ts'
import type { MemoryStore, AuditEntry } from '../adapter.ts'
import type { VectorStoreConfig } from './config.ts'

/** Shape of a Qdrant point we store. */
interface QPoint {
  id: string
  vector: number[]
  payload: { record: MemoryRecord }
}

/** Minimal fetch-based Qdrant REST client + MemoryStore impl. */
export class QdrantStore implements MemoryStore {
  readonly backend = 'qdrant'
  private readonly base: string
  private readonly collection: string
  private readonly apiKey: string | undefined
  private readonly dim: number
  // Local audit mirror (Qdrant has no audit table); best-effort, in-memory.
  private readonly audits: AuditEntry[] = []

  constructor(config: VectorStoreConfig) {
    if (config.url === undefined || config.url === '') throw new Error('remote mode requires remote.url (e.g. http://127.0.0.1:6333)')
    this.base = config.url.replace(/\/+$/, '')
    this.collection = config.collection ?? 'memorydex'
    this.apiKey = config.apiKey
    this.dim = config.dim ?? 1024
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey === undefined ? {} : { 'api-key': this.apiKey }) }
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, { method, headers: this.headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    if (!res.ok) throw new Error(`qdrant ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 160)}`)
    return text.trim() === '' ? undefined : JSON.parse(text)
  }

  async init(): Promise<void> {
    // Create the collection if absent (ignore 409/conflict when it already exists).
    try {
      await this.req('GET', `/collections/${this.collection}`)
    } catch {
      await this.req('PUT', `/collections/${this.collection}`, { vectors: { size: this.dim, distance: 'Cosine' } })
    }
  }

  async put(record: MemoryRecord): Promise<void> {
    const vector = record.embedding === undefined ? new Array<number>(this.dim).fill(0) : [...record.embedding]
    const point: QPoint = { id: uuidFor(record.id), vector, payload: { record } }
    await this.req('PUT', `/collections/${this.collection}/points?wait=true`, { points: [point] })
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const res = await this.req('POST', `/collections/${this.collection}/points`, { ids: [uuidFor(id)], with_payload: true }) as { result?: QPoint[] }
    return res.result?.[0]?.payload?.record
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.get(id)
    if (before === undefined) return false
    await this.req('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: [uuidFor(id)] })
    return true
  }

  async all(): Promise<MemoryRecord[]> {
    // Scroll the whole collection (paginated).
    const out: MemoryRecord[] = []
    let next: unknown = undefined
    do {
      const body: Record<string, unknown> = { limit: 256, with_payload: true }
      if (next !== undefined) body.offset = next
      const res = await this.req('POST', `/collections/${this.collection}/points/scroll`, body) as { result?: { points?: QPoint[]; next_page_offset?: unknown } }
      for (const p of res.result?.points ?? []) if (p.payload?.record !== undefined) out.push(p.payload.record)
      next = res.result?.next_page_offset ?? undefined
    } while (next !== undefined && next !== null)
    return out
  }

  /**
   * ANN top-k over the collection.
   * @param vector - query embedding.
   * @param limit - max hits.
   * @returns records with cosine scores (higher is better).
   */
  async vectorSearch(vector: readonly number[], limit = 20): Promise<{ record: MemoryRecord; score: number }[]> {
    const res = await this.req('POST', `/collections/${this.collection}/points/search`, { vector: [...vector], limit, with_payload: true }) as { result?: { score: number; payload?: { record?: MemoryRecord } }[] }
    return (res.result ?? []).filter(h => h.payload?.record !== undefined).map(h => ({ record: h.payload!.record!, score: h.score }))
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry)
    if (this.audits.length > 1000) this.audits.shift()
  }

  async listAudit(limit = 200): Promise<AuditEntry[]> {
    return [...this.audits].reverse().slice(0, limit)
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to close.
  }
}

/** Deterministic UUIDv5-like point id from a memory id (stable across runs). */
function uuidFor(id: string): string {
  const h = createHash('sha1').update(id).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
