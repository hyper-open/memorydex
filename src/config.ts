/**
 * Configuration loading for memorydex.
 *
 * Reads a JSON config (default `./memorydex.config.json`) or falls back to
 * environment/defaults. Supports multiple database backends (`db.kind`).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbConfig } from './db/index.ts'
import type { EmbeddingConfig } from './embedder-config.ts'
import type { VectorStoreConfig } from './db/vector/config.ts'

/** Operating mode: where memories are stored. */
export type MemorydexMode = 'local' | 'remote' | 'cloud'

/** Full application config. */
export interface MemorydexConfig {
  /** Storage mode: local (SQLite) / remote (external vector store) / cloud (platform API). */
  readonly mode: MemorydexMode
  /** Local-mode database backend selection. */
  readonly db: DbConfig
  /** Remote-mode vector store config (Qdrant). */
  readonly remote: VectorStoreConfig
  /** HTTP server port (for `serve`/`ui`). */
  readonly port: number
  /** HTTP bind host. */
  readonly host: string
  /** Embedding/vector-retrieval config. */
  readonly embedding: EmbeddingConfig
  /** Whether new writes dedupe by default (source key / content fingerprint). */
  readonly dedupe: boolean
}

/** Default config (SQLite in the user's home). */
export function defaultConfig(): MemorydexConfig {
  return {
    mode: 'local',
    db: { kind: 'sqlite', path: join(homedir(), '.memorydex', 'memory.db') },
    remote: { kind: 'qdrant', url: 'http://127.0.0.1:6333', collection: 'memorydex' },
    port: 7567,
    host: '127.0.0.1',
    embedding: { enabled: true, kind: 'hashing', hashingDim: 256 },
    dedupe: true,
  }
}

/**
 * Load config from a file path (if it exists) merged over defaults.
 * Env: MEMORYDEX_CONFIG, MEMORYDEX_DB (kind), MEMORYDEX_DB_PATH, MEMORYDEX_DB_URL, MEMORYDEX_PORT.
 */
export function loadConfig(explicitPath?: string): MemorydexConfig {
  const base = defaultConfig()
  const path = explicitPath ?? process.env.MEMORYDEX_CONFIG ?? 'memorydex.config.json'
  let file: Partial<MemorydexConfig> = {}
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemorydexConfig>
  } catch {
    // No file: use defaults + env.
  }
  const dbKind = process.env.MEMORYDEX_DB
  const db: DbConfig = {
    ...base.db,
    ...file.db,
    ...(dbKind === 'sqlite' || dbKind === 'pg' || dbKind === 'mysql' ? { kind: dbKind } : {}),
    ...(process.env.MEMORYDEX_DB_PATH === undefined ? {} : { path: process.env.MEMORYDEX_DB_PATH }),
    ...(process.env.MEMORYDEX_DB_URL === undefined ? {} : { url: process.env.MEMORYDEX_DB_URL }),
  }
  const embEnv: EmbeddingConfig = {}
  if (process.env.MEMORYDEX_EMBED_URL !== undefined) (embEnv as { url?: string }).url = process.env.MEMORYDEX_EMBED_URL
  if (process.env.MEMORYDEX_EMBED_MODEL !== undefined) (embEnv as { model?: string }).model = process.env.MEMORYDEX_EMBED_MODEL
  if (process.env.MEMORYDEX_EMBED_KEY !== undefined) (embEnv as { apiKey?: string }).apiKey = process.env.MEMORYDEX_EMBED_KEY
  if (process.env.MEMORYDEX_EMBED_OFF === '1') (embEnv as { enabled?: boolean }).enabled = false
  const embedding: EmbeddingConfig = { ...base.embedding, ...file.embedding, ...embEnv }
  const modeEnv = process.env.MEMORYDEX_MODE
  const mode: MemorydexMode = (modeEnv === 'local' || modeEnv === 'remote' || modeEnv === 'cloud') ? modeEnv : (file.mode ?? base.mode)
  const remoteEnv: Partial<VectorStoreConfig> = {}
  if (process.env.MEMORYDEX_VECTOR_URL !== undefined) (remoteEnv as { url?: string }).url = process.env.MEMORYDEX_VECTOR_URL
  if (process.env.MEMORYDEX_VECTOR_KEY !== undefined) (remoteEnv as { apiKey?: string }).apiKey = process.env.MEMORYDEX_VECTOR_KEY
  if (process.env.MEMORYDEX_VECTOR_COLLECTION !== undefined) (remoteEnv as { collection?: string }).collection = process.env.MEMORYDEX_VECTOR_COLLECTION
  const remote: VectorStoreConfig = { ...base.remote, ...file.remote, ...remoteEnv }
  return {
    mode,
    db,
    remote,
    port: file.port ?? (process.env.MEMORYDEX_PORT === undefined ? base.port : Number(process.env.MEMORYDEX_PORT)),
    host: file.host ?? base.host,
    embedding,
    dedupe: file.dedupe ?? (process.env.MEMORYDEX_DEDUPE === '0' ? false : base.dedupe),
  }
}
