/**
 * Auto-import platform memory files as they change.
 *
 * Rather than one fs watcher per file (Codebuddy alone can have ~80 memory files
 * across many project dirs), this polls: periodically re-discover each adapter's
 * files and re-import any whose content hash changed since the last scan. Cheap,
 * robust to new/removed files, and works across platforms uniformly.
 *
 * Re-import is idempotent (importPlatformLocation + write dedupe), so unchanged
 * files are effectively no-ops beyond a hash read.
 */
import { readFile } from 'node:fs/promises'
import type { MemoryService } from '../core/memory.ts'
import { contentHash } from '../import/markdown.ts'
import { importPlatformLocation, type AdapterRegistry } from './index.ts'

/** Options for {@link watchPlatforms}. */
export interface PlatformWatchOptions {
  /** Poll interval in ms (default 15000). */
  readonly intervalMs?: number
  /** Called after a file is (re)imported with a change. */
  readonly onChange?: (platform: string, file: string, imported: number, updated: number) => void
  /** Called on per-file errors. */
  readonly onError?: (platform: string, file: string, error: unknown) => void
}

/** A running platform watch. */
export interface PlatformWatchHandle {
  /** Stop polling. */
  close(): void
  /** Run one scan immediately (returns number of files that changed). */
  scanNow(): Promise<number>
}

/**
 * Poll platform files and re-import changes into memory.
 * @param service - memory service.
 * @param registry - adapter registry.
 * @param options - interval + callbacks.
 */
export function watchPlatforms(service: MemoryService, registry: AdapterRegistry, options: PlatformWatchOptions = {}): PlatformWatchHandle {
  const intervalMs = options.intervalMs ?? 15_000
  const seen = new Map<string, string>() // file -> last content hash
  let inflight: Promise<number> | undefined

  const runScan = async (): Promise<number> => {
    let changed = 0
    try {
      for (const adapter of registry.list()) {
        let files: string[]
        try { files = await adapter.discover() } catch { continue }
        for (const file of files) {
          let text: string
          try { text = await readFile(file, 'utf8') } catch { seen.delete(file); continue }
          const hash = contentHash(text)
          if (seen.get(file) === hash) continue
          try {
            const r = await importPlatformLocation(service, adapter, file)
            seen.set(file, hash)
            if (r.imported + r.updated > 0) { changed += 1; options.onChange?.(adapter.platform, file, r.imported, r.updated) }
          } catch (error) {
            options.onError?.(adapter.platform, file, error)
          }
        }
      }
    } finally {
      // no-op
    }
    return changed
  }

  const scan = (): Promise<number> => {
    if (inflight !== undefined) return inflight
    inflight = runScan().finally(() => { inflight = undefined })
    return inflight
  }

  const timer = setInterval(() => { void scan() }, intervalMs)
  timer.unref?.()
  void scan() // initial baseline
  return {
    scanNow: scan,
    close: () => { clearInterval(timer) },
  }
}
