/**
 * Whole-store bundle export/import (backup, migration, portability).
 *
 * The bundle is plain JSON: every record plus a small header. Import supports
 * `merge` (keep existing ids, add missing) and `replace` (wipe then load).
 */
import type { MemoryService } from './core/memory.ts'
import type { MemoryRecord } from './core/types.ts'

/** Bundle format version. */
export const BUNDLE_VERSION = 1

/** An exported memory bundle. */
export interface MemoryBundle {
  readonly format: 'memorydex-bundle'
  readonly version: number
  readonly exportedAt: number
  readonly count: number
  readonly records: readonly MemoryRecord[]
}

/**
 * Export all records as a portable bundle.
 * @param service - memory service.
 */
export async function exportBundle(service: MemoryService): Promise<MemoryBundle> {
  const records = await service.allRecords()
  return { format: 'memorydex-bundle', version: BUNDLE_VERSION, exportedAt: Date.now(), count: records.length, records }
}

/**
 * Import a bundle.
 * @param service - memory service.
 * @param bundle - parsed bundle.
 * @param mode - 'merge' (default) keeps existing ids and adds missing; 'replace' clears first.
 * @returns counts of inserted and skipped records.
 */
export async function importBundle(service: MemoryService, bundle: MemoryBundle, mode: 'merge' | 'replace' = 'merge'): Promise<{ inserted: number; skipped: number }> {
  if (bundle.format !== 'memorydex-bundle') throw new Error('not a memorydex bundle')
  if (mode === 'replace') {
    for (const r of await service.allRecords()) await service.delete(r.id)
  }
  let inserted = 0
  let skipped = 0
  for (const rec of bundle.records) {
    const existing = await service.get(rec.id)
    if (existing !== undefined && mode === 'merge') { skipped += 1; continue }
    // Preserve the original id and stored embedding (faithful restore).
    await service.restoreRecord(rec)
    inserted += 1
  }
  return { inserted, skipped }
}

/**
 * Recompute embeddings for all records with the service's current embedder
 * (useful after switching the embedding model/dimension).
 * @returns number of records re-embedded.
 */
export async function reembedAll(service: MemoryService): Promise<number> {
  const records = await service.allRecords()
  let n = 0
  for (const r of records) {
    // update() re-embeds when title/content/tags are provided.
    await service.update(r.id, { title: r.title, content: r.content, tags: r.tags })
    n += 1
  }
  return n
}
