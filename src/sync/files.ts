/**
 * Two-way sync between memory records and their source Markdown files.
 *
 * Each imported section owns a record whose `source` is `<file>#<slug>`. Sync
 * reconciles in both directions:
 * - File → memory: re-parse each tracked file; new/changed sections create or
 *   update records; removed sections delete their records.
 * - Memory → file: rewrite a file from its records (title as heading, content as
 *   body) so edits made in the UI persist back. Conflict policy is last-writer:
 *   the caller decides direction; `syncFile` detects drift and reports it.
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { MemoryService } from '../core/memory.ts'
import type { MemoryRecord } from '../core/types.ts'
import { contentHash, importFile, parseMarkdownSections } from '../import/markdown.ts'

/** Per-file sync outcome. */
export interface SyncResult {
  readonly file: string
  readonly added: number
  readonly updated: number
  readonly removed: number
  /** True when the file changed and memory was refreshed from it. */
  readonly fileChanged: boolean
}

/** List the distinct source files currently backing memory records. */
export async function trackedFiles(service: MemoryService): Promise<string[]> {
  const all = await service.list({ limit: Number.POSITIVE_INFINITY, includeExpired: true })
  const set = new Set<string>()
  for (const r of all) {
    if (r.source === undefined) continue
    const [file] = r.source.split('#')
    if (file !== undefined && file !== '') set.add(file)
  }
  return [...set].sort()
}

/**
 * Pull a file's current content into memory (file → memory).
 * Adds new sections, updates changed ones, removes records for deleted sections.
 */
export async function pullFile(service: MemoryService, file: string): Promise<SyncResult> {
  const before = await recordsForFile(service, file)
  const result = await importFile(service, file)
  // Remove records whose sections no longer exist in the file.
  const markdown = await readFile(file, 'utf8')
  const liveSlugs = new Set(parseMarkdownSections(markdown).map(s => `${file}#${s.slug}`))
  let removed = 0
  for (const rec of before) {
    if (rec.source !== undefined && !liveSlugs.has(rec.source)) {
      if (await service.delete(rec.id)) removed += 1
    }
  }
  return { file, added: result.imported, updated: result.updated, removed, fileChanged: result.imported + result.updated + removed > 0 }
}

/**
 * Push memory records back into their file (memory → file). Rewrites the whole
 * file from its records, ordered by creation. Use when the UI edits should land
 * on disk.
 */
export async function pushFile(service: MemoryService, file: string): Promise<SyncResult> {
  const records = (await recordsForFile(service, file)).sort((a, b) => a.createdAt - b.createdAt)
  const md = records.map(r => `# ${r.title}\n\n${r.content}\n`).join('\n')
  await writeFile(file, md, 'utf8')
  return { file, added: 0, updated: records.length, removed: 0, fileChanged: true }
}

/**
 * Reconcile one file in both directions using content hashes.
 * If the on-disk file hash differs from the last sync, pull from the file;
 * otherwise push memory edits to the file.
 * @param lastSyncedHash - hash stored from the previous sync, or undefined.
 */
export async function reconcileFile(service: MemoryService, file: string, lastSyncedHash?: string): Promise<{ result: SyncResult; hash: string; direction: 'pull' | 'push' }> {
  let diskHash: string
  try {
    diskHash = contentHash(await readFile(file, 'utf8'))
  } catch {
    // File missing: push memory back to recreate it if we have records.
    const records = await recordsForFile(service, file)
    if (records.length === 0) return { result: { file, added: 0, updated: 0, removed: 0, fileChanged: false }, hash: '', direction: 'push' }
    return { result: await pushFile(service, file), hash: contentHash(records.map(r => r.content).join('')), direction: 'push' }
  }
  if (lastSyncedHash === undefined || diskHash !== lastSyncedHash) {
    return { result: await pullFile(service, file), hash: diskHash, direction: 'pull' }
  }
  return { result: await pushFile(service, file), hash: diskHash, direction: 'push' }
}

/** All records whose source begins with `<file>#`. */
async function recordsForFile(service: MemoryService, file: string): Promise<MemoryRecord[]> {
  const all = await service.list({ limit: Number.POSITIVE_INFINITY, includeExpired: true })
  return all.filter(r => r.source !== undefined && r.source.startsWith(`${file}#`))
}
