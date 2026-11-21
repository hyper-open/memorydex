/**
 * Memory service: CRUD + retrieval over a {@link MemoryStore}.
 *
 * Retrieval is lexical (no embeddings), so it works identically across every
 * backend without extra services. Score blends: term overlap in title/content,
 * tag matches, importance, and recency — enough for a useful default, and easy
 * to swap for vector search later.
 */
import { randomUUID } from 'node:crypto'
import type { MemoryStore } from '../db/adapter.ts'
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
  constructor(private readonly store: MemoryStore) {}

  /** Create and persist a new memory record. */
  async create(input: MemoryCreateInput, now = Date.now()): Promise<MemoryRecord> {
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`Invalid memory kind: ${input.kind}`)
    if (input.title.trim() === '') throw new Error('Memory title must not be empty.')
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
    }
    await this.store.put(record)
    return record
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
      updatedAt: now,
    }
    // expiresAt: null explicitly clears; number sets; undefined leaves unchanged.
    const withExpiry: MemoryRecord = patch.expiresAt === undefined
      ? next
      : patch.expiresAt === null
        ? (() => { const { expiresAt: _drop, ...rest } = next; return rest as MemoryRecord })()
        : { ...next, expiresAt: patch.expiresAt }
    await this.store.put(withExpiry)
    return withExpiry
  }

  /** Delete one record; returns whether it existed. */
  async delete(id: string): Promise<boolean> {
    return this.store.delete(id)
  }

  /**
   * List records matching a filter (no relevance ranking).
   * @param filter - kind/tags/source/origin/time filters + paging.
   */
  async list(filter: MemoryFilter = {}, now = Date.now()): Promise<MemoryRecord[]> {
    let out = (await this.store.all()).filter(r => matchesFilter(r, filter, now))
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? Number.POSITIVE_INFINITY
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
    const candidates = (await this.store.all()).filter(r => matchesFilter(r, filter, now))
    const scored: MemorySearchHit[] = candidates.map(record => {
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
      const tagBonus = filter.tags === undefined ? 0 : 0 // structured match already required
      const recency = recencyBoost(record.updatedAt, now)
      const score = lexical + (q === '' ? 0 : 0) + record.importance * 0.5 + recency + tagBonus
      return { record, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? Number.POSITIVE_INFINITY
    return scored.slice(offset, offset + limit)
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
