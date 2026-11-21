/**
 * Database backend selection from configuration.
 *
 * Supported today: `sqlite` (bundled, zero-dependency via `node:sqlite`).
 * `pg` / `mysql` are recognised config targets that resolve to an adapter loaded
 * lazily so the core stays dependency-light when only SQLite is used. To enable
 * one, install its driver (e.g. `pg` or `mysql2`) and provide a connection.
 */
import { SqliteStore } from './sqlite.ts'
import type { MemoryStore } from './adapter.ts'

/** Configuration for an SQL-family backend. */
export interface DbConfig {
  /** Backend kind. */
  readonly kind: 'sqlite' | 'pg' | 'mysql'
  /** SQLite: file path or ':memory:'. SQL: ignored (use url). */
  readonly path?: string
  /** SQL (pg/mysql): connection URL, e.g. postgres://user:pass@host/db. */
  readonly url?: string
  /** Table name (SQL backends). */
  readonly table?: string
}

/** The default config (an in-process SQLite file). */
export const DEFAULT_DB: DbConfig = { kind: 'sqlite', path: 'memorydex.db' }

/**
 * Open a memory store for the given config.
 * @param config - backend selection.
 * @returns an initialised store.
 */
export async function openStore(config: DbConfig = DEFAULT_DB): Promise<MemoryStore> {
  let store: MemoryStore
  switch (config.kind) {
    case 'sqlite': {
      store = new SqliteStore(config.path ?? ':memory:')
      break
    }
    case 'pg':
    case 'mysql': {
      // Lazy, optional adapters. Kept out of the default dependency set.
      const mod = await import(`./${config.kind}.ts`).catch(() => undefined)
      if (mod === undefined) {
        throw new Error(`The "${config.kind}" backend is not available in this build. Install its driver and adapter, or use sqlite.`)
      }
      const Ctor = (mod as { [k: string]: unknown })[config.kind === 'pg' ? 'PgStore' : 'MysqlStore'] as
        | (new (url: string, table?: string) => MemoryStore)
        | undefined
      if (Ctor === undefined) throw new Error(`Adapter for "${config.kind}" missing an exported store class.`)
      store = new Ctor(config.url ?? '', config.table)
      break
    }
    default: {
      const exhaustive: never = config.kind
      throw new Error(`Unknown db backend: ${String(exhaustive)}`)
    }
  }
  await store.init()
  return store
}
