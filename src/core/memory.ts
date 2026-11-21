/**
 * Memory service: CRUD + retrieval over a {@link MemoryStore}.
 *
 * Retrieval is lexical (no embeddings), so it works identically across every
 * backend without extra services. Score blends: term overlap in title/content,
 * tag matches, importance, and recency — enough for a useful default, and easy
 * to swap for vector search later.
 */
import { randomUUID, createHash } from 'node:crypto'
import type { MemoryStore, AuditEntry } from '../db/adapter.ts'
import { cosine, HashingEmbedder, type Embedder } from './embedder.ts'
import {
  MEMORY_KINDS,
  type MemoryCreateInput,
  type MemoryFilter,
  type MemoryKind,
  type MemoryOrigin,
  type MemoryRecord,
  type MemorySearchHit,
  type MemoryUpdateInput,
} from './types.ts'

/** Default page size for list/search when the caller gives no limit. */
export const DEFAULT_LIMIT = 100
/** Hard cap on any single list/search page (protects memory under large stores). */
export const MAX_LIMIT = 1000

/** Clamp a caller limit into [1, MAX_LIMIT], defaulting when undefined. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

/** Mint a short, sortable, collision-safe memory id. */
function mintId(): string {
  const t = Date.now().toString(36)
  return `m-${t}-${randomUUID().slice(0, 8)}`
}

/** Coerce importance into [0,1]; default 0.5. */
function clampImportance(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0.5
  return Math.max(0, Math.min(1, v))
}

/** Normalised content fingerprint for dedupe (order-insensitive on whitespace). */
export function fingerprint(title: string, content: string): string {
  const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(norm(title) + '\u0000' + norm(content)).digest('hex').slice(0, 24)
}

/** Tokenise text into lowercase word terms. */
function terms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Drop expired working-memory records. */
function isExpired(record: MemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now
}

/** The memory service. */
export class MemoryService {
  /**
   * @param store - the backing store adapter.
   */
  private readonly embedder: Embedder | undefined
  /** Whether create() dedupes by default (source key / content fingerprint). */
  readonly dedupeByDefault: boolean

  /**
   * @param store - the backing store adapter.
   * @param embedder - optional embedder for semantic retrieval; defaults to a
   *   zero-dependency {@link HashingEmbedder} so vector recall works out of the box.
   *   Pass `null` to disable embeddings (pure lexical).
   */
  constructor(private readonly store: MemoryStore, embedder: Embedder | null = new HashingEmbedder(), options: { dedupe?: boolean } = {}) {
    this.embedder = embedder ?? undefined
    this.dedupeByDefault = options.dedupe !== false
  }

  /** Compute an embedding for a record's text, or undefined when disabled. */
  private async embedText(title: string, content: string, tags: readonly string[]): Promise<number[] | undefined> {
    if (this.embedder === undefined) return undefined
    try {
      return await this.embedder.embed(`${title}\n${content}\n${tags.join(' ')}`)
    } catch {
      // Degrade gracefully: a dead embedding server must not fail writes.
      return undefined
    }
  }

  /** Create and persist a new memory record. */
  /**
   * Find an existing record equivalent to the input: same non-empty `source`,
   * else same content fingerprint within the same kind.
   */
  async findDuplicate(input: MemoryCreateInput): Promise<MemoryRecord | undefined> {
    const all = await this.store.all()
    if (input.source !== undefined && input.source !== '') {
      const bySource = all.find(r => r.source === input.source)
      if (bySource !== undefined) return bySource
    }
    const fp = fingerprint(input.title, input.content)
    return all.find(r => r.kind === input.kind && fingerprint(r.title, r.content) === fp)
  }

  /**
   * Create a memory, optionally merging into an equivalent existing one.
   * @param input - the record to create.
   * @param now - timestamp override.
   * @param opts - `dedupe` (default true): when a record with the same source-key
   *   or content fingerprint exists, merge into it instead of duplicating.
   */
  async create(input: MemoryCreateInput, now = Date.now(), opts: { dedupe?: boolean } = {}): Promise<MemoryRecord> {
    const dedupe = opts.dedupe ?? this.dedupeByDefault
    if (dedupe) {
      const existing = await this.findDuplicate(input)
      if (existing !== undefined) {
        const merged = await this.update(existing.id, {
          kind: input.kind,
          title: input.title,
          content: input.content,
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.importance === undefined ? {} : { importance: input.importance }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }, now)
        await this.audit('merge', existing.id, `merged write into existing (${input.kind})`)
        return merged ?? existing
      }
    }
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`Invalid memory kind: ${input.kind}`)
    if (input.title.trim() === '') throw new Error('Memory title must not be empty.')
    const emb = this.embedder === undefined ? undefined : await this.embedText(input.title, input.content, input.tags ?? [])
    const record: MemoryRecord = {
      id: mintId(),
      kind: input.kind,
      title: input.title.trim(),
      content: input.content,
      tags: dedupeTags(input.tags),
      importance: clampImportance(input.importance),
      origin: (input.origin ?? 'manual') as MemoryOrigin,
      ...(input.source === undefined ? {} : { source: input.source }),
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.links === undefined ? {} : { links: dedupeTags(input.links) }),
      ...(input.pinned === true ? { pinned: true } : {}),
      ...(emb === undefined ? {} : { embedding: emb }),
    }
    await this.store.put(record)
    await this.audit('create', record.id, `created ${record.kind}`)
    return record
  }

  /** Persist an exact record as-is (preserving id) — used by bundle restore/migration. */
  async restoreRecord(record: MemoryRecord): Promise<void> {
    await this.store.put(record)
  }

  /** All records, unfiltered and unpaged (internal: import/sync/stats). */
  async allRecords(now = Date.now(), includeExpired = true): Promise<MemoryRecord[]> {
    return (await this.store.all()).filter(r => includeExpired || !isExpired(r, now))
  }

  /** Get one record by id. */
  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.store.get(id)
  }

  /**
   * Update a record (partial). Bumps `updatedAt`.
   * @returns the updated record, or undefined if not found.
   */
  async update(id: string, patch: MemoryUpdateInput, now = Date.now()): Promise<MemoryRecord | undefined> {
    const current = await this.store.get(id)
    if (current === undefined) return undefined
    if (patch.kind !== undefined && !MEMORY_KINDS.includes(patch.kind)) throw new Error(`Invalid memory kind: ${patch.kind}`)
    const next: MemoryRecord = {
      ...current,
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.title === undefined ? {} : { title: patch.title.trim() || current.title }),
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.tags === undefined ? {} : { tags: dedupeTags(patch.tags) }),
      ...(patch.importance === undefined ? {} : { importance: clampImportance(patch.importance) }),
      ...(patch.source === undefined ? {} : { source: patch.source }),
      ...(patch.metadata === undefined ? {} : { metadata: { ...current.metadata, ...patch.metadata } }),
      ...(patch.links === undefined ? {} : { links: dedupeTags(patch.links) }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      updatedAt: now,
    }
    // Re-embed when title/content/tags changed.
    let withEmb: MemoryRecord = next
    if (this.embedder !== undefined && (patch.title !== undefined || patch.content !== undefined || patch.tags !== undefined)) {
      const emb = await this.embedText(next.title, next.content, next.tags)
      if (emb !== undefined) withEmb = { ...next, embedding: emb }
    }
    // expiresAt: null explicitly clears; number sets; undefined leaves unchanged.
    const withExpiry: MemoryRecord = patch.expiresAt === undefined
      ? withEmb
      : patch.expiresAt === null
        ? (() => { const { expiresAt: _drop, ...rest } = withEmb; return rest as MemoryRecord })()
        : { ...withEmb, expiresAt: patch.expiresAt }
    await this.store.put(withExpiry)
    await this.audit('update', withExpiry.id, `updated fields: ${Object.keys(patch).join(',') || '(none)'}`)
    return withExpiry
  }

  /** Delete one record; returns whether it existed. */
  async delete(id: string): Promise<boolean> {
    const ok = await this.store.delete(id)
    if (ok) await this.audit('delete', id, 'deleted')
    return ok
  }

  /**
   * List records matching a filter (no relevance ranking).
   * @param filter - kind/tags/source/origin/time filters + paging.
   */
  async list(filter: MemoryFilter = {}, now = Date.now()): Promise<MemoryRecord[]> {
    let out = (await this.store.all()).filter(r => matchesFilter(r, filter, now))
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    const offset = filter.offset ?? 0
    const limit = clampLimit(filter.limit)
    return out.slice(offset, offset + limit)
  }

  /**
   * Relevance search across title/content/tags, blended with importance and recency.
   * @param query - free text; empty string returns most-recent by importance.
   * @param filter - optional structural filters.
   */
  async search(query: string, filter: MemoryFilter = {}, now = Date.now()): Promise<MemorySearchHit[]> {
    const q = query.trim().toLowerCase()
    const qTerms = terms(q)
    const qVec = this.embedder !== undefined && q !== '' ? await this.embedText(query, '', []) : undefined
    const offset = filter.offset ?? 0
    const limit = clampLimit(filter.limit)

    // Remote vector stores: use ANN to fetch a candidate set, then re-rank with the
    // same blended score (lexical + importance + recency + pinned). This avoids
    // scrolling the whole collection into memory for the expensive part.
    if (qVec !== undefined && this.store.vectorSearch !== undefined && q !== '') {
      const pool = await this.store.vectorSearch(qVec, Math.max(limit * 4, 50))
      const candidates = pool.map(p => p.record).filter(r => matchesFilter(r, filter, now))
      const scored = candidates.map(record => ({ record, score: this.scoreRecord(record, q, qTerms, qVec, now) }))
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(offset, offset + limit)
    }

    // Local / lexical path: score every (filtered) record.
    const candidates = (await this.store.all()).filter(r => matchesFilter(r, filter, now))
    const scored: MemorySearchHit[] = candidates.map(record => ({ record, score: this.scoreRecord(record, q, qTerms, qVec, now) }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(offset, offset + limit)
  }

  /** Blended relevance score for one record (lexical + vector + importance + recency + access + pinned). */
  private scoreRecord(record: MemoryRecord, q: string, qTerms: string[], qVec: number[] | undefined, now: number): number {
    const hay = `${record.title} ${record.content} ${record.tags.join(' ')}`.toLowerCase()
    let lexical = 0
    if (q !== '') {
      if (record.title.toLowerCase().includes(q)) lexical += 3
      if (hay.includes(q)) lexical += 2
      const hayTerms = new Set(terms(hay))
      let hits = 0
      for (const t of qTerms) if (hayTerms.has(t)) hits += 1
      lexical += qTerms.length === 0 ? 0 : (hits / qTerms.length) * 2
    }
    let semantic = 0
    if (qVec !== undefined && record.embedding !== undefined && record.embedding.length === qVec.length) {
      semantic = Math.max(0, cosine(qVec, record.embedding)) * 4
    }
    const recency = recencyBoost(record.updatedAt, now)
    const access = Math.min(1, (record.accessCount ?? 0) / 10) * 0.3
    const pinned = record.pinned === true ? 100 : 0
    return lexical + semantic + record.importance * 0.5 + recency + access + pinned
  }

  /** Append an audit event if the store supports it (best-effort). */
  private async audit(action: AuditEntry['action'], recordId: string, summary?: string, platform?: string): Promise<void> {
    if (this.store.appendAudit === undefined) return
    try {
      await this.store.appendAudit({ id: mintId(), time: Date.now(), action, recordId, ...(platform === undefined ? {} : { platform }), ...(summary === undefined ? {} : { summary }) })
    } catch { /* audit must never break writes */ }
  }

  /** List recent audit events (newest first), if the store supports auditing. */
  async audit_events(limit = 200): Promise<AuditEntry[]> {
    return this.store.listAudit === undefined ? [] : this.store.listAudit(limit)
  }

  /** Record an access (bumps accessCount/lastAccessedAt) — call when a hit is used. */
  async touch(id: string, now = Date.now()): Promise<void> {
    const current = await this.store.get(id)
    if (current === undefined) return
    await this.store.put({ ...current, accessCount: (current.accessCount ?? 0) + 1, lastAccessedAt: now })
  }

  /** Aggregate counts by kind (and totals). */
  async stats(now = Date.now()): Promise<{ total: number; byKind: Record<MemoryKind, number> }> {
    const all = (await this.store.all()).filter(r => !isExpired(r, now))
    const byKind = { working: 0, episodic: 0, semantic: 0, procedural: 0 } as Record<MemoryKind, number>
    for (const r of all) byKind[r.kind] += 1
    return { total: all.length, byKind }
  }
}

/** Dedupe + normalise tags. */
function dedupeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim()
    if (t === '') continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Does a record satisfy the structural filter? */
function matchesFilter(r: MemoryRecord, filter: MemoryFilter, now: number): boolean {
  if (!filter.includeExpired && isExpired(r, now)) return false
  if (filter.kind !== undefined && r.kind !== filter.kind) return false
  if (filter.source !== undefined && r.source !== filter.source) return false
  if (filter.origin !== undefined && r.origin !== filter.origin) return false
  if (filter.updatedAfter !== undefined && r.updatedAt < filter.updatedAfter) return false
  if (filter.pinned !== undefined && (r.pinned === true) !== filter.pinned) return false
  if (filter.tags !== undefined && filter.tags.length > 0) {
    const lowered = new Set(r.tags.map(t => t.toLowerCase()))
    if (filter.tags.some(t => !lowered.has(t.toLowerCase()))) return false
  }
  return true
}

/** Recency boost in [0, 1] — half-life of ~14 days. */
function recencyBoost(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / 86_400_000
  return 1 / (1 + ageDays / 14)
}
