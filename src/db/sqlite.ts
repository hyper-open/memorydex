/**
 * SQLite storage backend using Node's built-in `node:sqlite` (zero external deps).
 *
 * One `memories` table; each row stores the record id plus a JSON document and a
 * few hot columns (kind, updated_at) for cheap filtering. Retrieval scoring lives
 * one layer up, so correctness does not depend on SQL features.
 */
import { DatabaseSync } from 'node:sqlite'
import type { MemoryRecord } from '../core/types.ts'
import type { MemoryStore } from './adapter.ts'

/** SQLite-backed memory store. */
export class SqliteStore implements MemoryStore {
  readonly backend = 'sqlite'
  private readonly db: DatabaseSync

  /**
   * @param path - database file path, or ':memory:' for an ephemeral store.
   */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        source TEXT,
        importance REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    `)
  }

  async put(record: MemoryRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, kind, origin, source, importance, created_at, updated_at, expires_at, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, origin=excluded.origin, source=excluded.source,
        importance=excluded.importance, created_at=excluded.created_at,
        updated_at=excluded.updated_at, expires_at=excluded.expires_at, doc=excluded.doc
    `)
    stmt.run(
      record.id,
      record.kind,
      record.origin,
      record.source ?? null,
      record.importance,
      record.createdAt,
      record.updatedAt,
      record.expiresAt ?? null,
      JSON.stringify(record),
    )
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const row = this.db.prepare('SELECT doc FROM memories WHERE id = ?').get(id) as { doc?: string } | undefined
    return row?.doc === undefined ? undefined : (JSON.parse(row.doc) as MemoryRecord)
  }

  async delete(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return res.changes > 0
  }

  async all(): Promise<MemoryRecord[]> {
    const rows = this.db.prepare('SELECT doc FROM memories').all() as { doc: string }[]
    return rows.map(row => JSON.parse(row.doc) as MemoryRecord)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
