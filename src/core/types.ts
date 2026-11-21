/**
 * Core memory types for memorydex.
 *
 * Four cognitive memory kinds, loosely modelled on human memory:
 * - working:    short-lived, task/session-scoped scratch context.
 * - episodic:   specific events/experiences (what happened, when).
 * - semantic:   de-contextualised facts/knowledge (what is true).
 * - procedural: skills/how-to (how to do something).
 */

/** The four cognitive memory kinds. */
export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural'

/** All memory kinds in display order. */
export const MEMORY_KINDS: readonly MemoryKind[] = ['working', 'episodic', 'semantic', 'procedural']

/** How a memory record came to exist. */
export type MemoryOrigin = 'manual' | 'agent' | 'import' | 'sync'

/** One durable memory record. */
export interface MemoryRecord {
  /** Stable id. */
  readonly id: string
  /** Cognitive kind. */
  readonly kind: MemoryKind
  /** Short human title. */
  readonly title: string
  /** Full body text (Markdown allowed). */
  readonly content: string
  /** Freeform tags for filtering/retrieval. */
  readonly tags: readonly string[]
  /** 0..1 salience/importance; higher survives pruning. */
  readonly importance: number
  /** Where it came from. */
  readonly origin: MemoryOrigin
  /** Origin locator: a file path (import/sync), session id (agent), or undefined. */
  readonly source?: string
  /** Extra structured data (kind-specific). */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Epoch millis. */
  readonly createdAt: number
  /** Epoch millis. */
  readonly updatedAt: number
  /** Expiry for short-lived working memory (epoch millis); undefined = never. */
  readonly expiresAt?: number
  /** Ids of related memory records (a lightweight graph). */
  readonly links?: readonly string[]
  /** Pinned records always rank above unpinned in retrieval. */
  readonly pinned?: boolean
  /** How many times this record has been returned by search/get. */
  readonly accessCount?: number
  /** Epoch millis of the last access. */
  readonly lastAccessedAt?: number
  /** Optional precomputed embedding vector (set by an embedder). */
  readonly embedding?: readonly number[]
}

/** A record with its embedding-free text used for retrieval. */
export interface MemorySearchHit {
  readonly record: MemoryRecord
  /** Relevance score (higher = better). */
  readonly score: number
}

/** Input for creating a memory record. */
export interface MemoryCreateInput {
  readonly kind: MemoryKind
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly importance?: number
  readonly origin?: MemoryOrigin
  readonly source?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly expiresAt?: number
  readonly links?: readonly string[]
  readonly pinned?: boolean
}

/** Input for updating a memory record (partial). */
export interface MemoryUpdateInput {
  readonly kind?: MemoryKind
  readonly title?: string
  readonly content?: string
  readonly tags?: readonly string[]
  readonly importance?: number
  readonly source?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly expiresAt?: number | null
  readonly links?: readonly string[]
  readonly pinned?: boolean
}

/** Filter for listing/searching. */
export interface MemoryFilter {
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly source?: string
  readonly origin?: MemoryOrigin
  /** Only records updated at/after this epoch millis. */
  readonly updatedAfter?: number
  /** Include expired working memory (default false). */
  readonly includeExpired?: boolean
  /** Only pinned (true) / only unpinned (false) when set. */
  readonly pinned?: boolean
  /** Max results. */
  readonly limit?: number
  /** Offset for paging. */
  readonly offset?: number
}
