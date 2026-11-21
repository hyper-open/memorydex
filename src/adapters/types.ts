/**
 * Platform adapters: read memories from the on-disk stores of various AI coding
 * tools (Claude Code, Codex, Codebuddy, WorkBuddy, …) and import them into the
 * memory service with a `platform` tag.
 *
 * File-based platforms (CLAUDE.md / AGENTS.md / any .md) are fully readable AND
 * writable. Proprietary runtime stores (Codebuddy `.info`, WorkBuddy sqlite) are
 * READ-ONLY at best and must be marked `writable:false`.
 */

/** One importable unit from a platform source. */
export interface PlatformSection {
  /** Stable slug within the source (used in the record source key). */
  readonly slug: string
  readonly title: string
  readonly content: string
  /** Optional inferred kind. */
  readonly kind?: 'semantic' | 'procedural' | 'episodic' | 'working'
}

/** A platform memory adapter. */
export interface PlatformAdapter {
  /** Stable platform id, e.g. 'claude' / 'codex' / 'codebuddy' / 'workbuddy' / 'md'. */
  readonly platform: string
  /** Whether this adapter can write changes back to the platform store. */
  readonly writable: boolean
  /** Discover source locations (file paths) for this platform. */
  discover(): Promise<string[]>
  /** Read one source location into sections. */
  read(location: string): Promise<PlatformSection[]>
}

/** Result of importing one location. */
export interface PlatformImportResult {
  readonly platform: string
  readonly location: string
  readonly imported: number
  readonly updated: number
  readonly unchanged: number
}
