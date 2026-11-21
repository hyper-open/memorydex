/**
 * Import orchestration across platform adapters + a registry of built-ins.
 *
 * Records written here carry `metadata.platform` and `metadata.file`, and a
 * `source` key of `<location>#<slug>` — the same stable key used by file sync, so
 * file-based platforms remain two-way syncable.
 */
import type { MemoryService } from '../core/memory.ts'
import type { MemoryKind } from '../core/types.ts'
import { contentHash } from '../import/markdown.ts'
import { claudeAdapter, codexAdapter, MarkdownAdapter } from './md-adapter.ts'
import { CodebuddyAdapter, WorkbuddyAdapter } from './codebuddy-workbuddy.ts'
import type { PlatformAdapter, PlatformImportResult } from './types.ts'
export type { PlatformAdapter, PlatformSection, PlatformImportResult } from './types.ts'

/**
 * Import one location from an adapter into memory (idempotent by source key).
 * @param service - memory service.
 * @param adapter - the platform adapter.
 * @param location - a discovered location (file path).
 */
export async function importPlatformLocation(service: MemoryService, adapter: PlatformAdapter, location: string): Promise<PlatformImportResult> {
  const sections = await adapter.read(location)
  const existing = await service.allRecords()
  const bySource = new Map<string, (typeof existing)[number]>()
  for (const r of existing) if (r.source !== undefined) bySource.set(r.source, r)

  let imported = 0, updated = 0, unchanged = 0
  for (const sec of sections) {
    const source = `${location}#${sec.slug}`
    const kind: MemoryKind = sec.kind ?? 'semantic'
    const hash = contentHash(sec.content)
    const prev = bySource.get(source)
    if (prev !== undefined && contentHash(prev.content) === hash && prev.title === sec.title) { unchanged += 1; continue }
    const metadata = { platform: adapter.platform, file: location, slug: sec.slug }
    if (prev !== undefined) {
      await service.update(prev.id, { title: sec.title, content: sec.content, kind, source, metadata })
      updated += 1
    } else {
      await service.create({ kind, title: sec.title, content: sec.content, origin: 'import', source, metadata })
      imported += 1
    }
  }
  return { platform: adapter.platform, location, imported, updated, unchanged }
}

/**
 * Import all discovered locations of an adapter (or an explicit file list).
 * @returns one result per location.
 */
export async function importPlatform(service: MemoryService, adapter: PlatformAdapter, files?: readonly string[]): Promise<PlatformImportResult[]> {
  const locations = files ?? (await adapter.discover())
  const out: PlatformImportResult[] = []
  for (const loc of locations) out.push(await importPlatformLocation(service, adapter, loc))
  return out
}

/** Registry of built-in platform adapters. */
export interface AdapterRegistry {
  /** All registered adapters. */
  list(): PlatformAdapter[]
  /** Find an adapter by platform id. */
  get(platform: string): PlatformAdapter | undefined
}

/**
 * Build the default adapter registry for a home directory.
 * @param home - user home (defaults to os.homedir()).
 */
export function defaultAdapters(home: string): AdapterRegistry {
  const adapters: PlatformAdapter[] = [
    claudeAdapter(home),
    codexAdapter(home),
    new MarkdownAdapter('md', ['AGENTS.md', 'CLAUDE.md'], [home]),
    new CodebuddyAdapter(home),
    new WorkbuddyAdapter(home),
  ]
  return {
    list: () => adapters,
    get: (p) => adapters.find(a => a.platform === p),
  }
}
