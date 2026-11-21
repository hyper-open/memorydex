/**
 * Database backend selection from configuration.
 *
 * Supported today: `sqlite` (bundled, zero-dependency via `node:sqlite`).
 * `pg` / `mysql` are recognised config targets that resolve to an adapter loaded
 * lazily so the core stays dependency-light when only SQLite is used. To enable
 * one, install its driver (e.g. `pg` or `mysql2`) and provide a connection.
 */
import { SqliteStore } from './sqlite.ts'
import { PgStore } from './pg.ts'
import { MysqlStore } from './mysql.ts'
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
    case 'pg': {
      if (config.url === undefined || config.url === '') throw new Error('The "pg" backend requires db.url (postgres://…).')
      store = new PgStore(config.url, config.table)
      break
    }
    case 'mysql': {
      if (config.url === undefined || config.url === '') throw new Error('The "mysql" backend requires db.url (mysql://…).')
      store = new MysqlStore(config.url, config.table)
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
