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

/** Full application config. */
export interface MemorydexConfig {
  /** Database backend selection. */
  readonly db: DbConfig
  /** HTTP server port (for `serve`/`ui`). */
  readonly port: number
  /** HTTP bind host. */
  readonly host: string
  /** Embedding/vector-retrieval config. */
  readonly embedding: EmbeddingConfig
}

/** Default config (SQLite in the user's home). */
export function defaultConfig(): MemorydexConfig {
  return {
    db: { kind: 'sqlite', path: join(homedir(), '.memorydex', 'memory.db') },
    port: 7567,
    host: '127.0.0.1',
    embedding: { enabled: true, kind: 'hashing', hashingDim: 256 },
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
  return {
    db,
    port: file.port ?? (process.env.MEMORYDEX_PORT === undefined ? base.port : Number(process.env.MEMORYDEX_PORT)),
    host: file.host ?? base.host,
    embedding,
  }
}
