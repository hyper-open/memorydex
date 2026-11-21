/**
 * Database adapter contract for memorydex.
 *
 * The store persists `MemoryRecord` rows. A richer adapter can use native SQL
 * columns/full-text search; the minimum contract is: create table, get/put/delete
 * one record, enumerate all, and run a bounded filtered scan. Higher layers
 * (retrieval, sync) build on `all()` + scoring so any backend works.
 */
import type { MemoryRecord } from '../core/types.ts'

/** A store adapter backed by a concrete database. */
export interface MemoryStore {
  /** Human label of the backend, e.g. 'sqlite' / 'pg'. */
  readonly backend: string
  /** Ensure the schema exists. */
  init(): Promise<void>
  /** Insert or replace one record. */
  put(record: MemoryRecord): Promise<void>
  /** Fetch one by id, or undefined. */
  get(id: string): Promise<MemoryRecord | undefined>
  /** Delete one by id; returns whether it existed. */
  delete(id: string): Promise<boolean>
  /** Enumerate all records (order unspecified). */
  all(): Promise<MemoryRecord[]>
  /** Close the connection/pool. */
  close(): Promise<void>
}
