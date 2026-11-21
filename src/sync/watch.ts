/**
 * File-watch auto-sync: watch tracked memory files and pull their changes into
 * memory automatically (debounced). Uses `node:fs.watch` — no dependencies.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import type { MemoryService } from '../core/memory.ts'
import { pullFile, trackedFiles } from './files.ts'

/** Options for {@link watchFiles}. */
export interface WatchOptions {
  /** Debounce window in ms (default 400). */
  readonly debounceMs?: number
  /** Called after each file is synced. */
  readonly onSync?: (file: string, added: number, updated: number, removed: number) => void
  /** Called on error for a file. */
  readonly onError?: (file: string, error: unknown) => void
}

/** A running watch handle. */
export interface WatchHandle {
  /** Stop watching and close watchers. */
  close(): void
  /** The files currently watched. */
  files(): string[]
}

/**
 * Watch the given files (or all tracked files) and pull changes into memory.
 * A file that cannot be watched directly (e.g. deleted) is watched via its
 * directory instead, so re-creation is still caught.
 * @param service - memory service.
 * @param files - explicit files, or undefined to use {@link trackedFiles}.
 * @param options - debounce + callbacks.
 */
export async function watchFiles(service: MemoryService, files: string[] | undefined, options: WatchOptions = {}): Promise<WatchHandle> {
  const targets = files ?? (await trackedFiles(service))
  const debounceMs = options.debounceMs ?? 400
  const watchers: FSWatcher[] = []
  const timers = new Map<string, NodeJS.Timeout>()

  const schedule = (file: string): void => {
    const existing = timers.get(file)
    if (existing !== undefined) clearTimeout(existing)
    timers.set(file, setTimeout(async () => {
      timers.delete(file)
      try {
        const r = await pullFile(service, file)
        options.onSync?.(file, r.added, r.updated, r.removed)
      } catch (error) {
        options.onError?.(file, error)
      }
    }, debounceMs))
  }

  for (const file of targets) {
    try {
      const w = fsWatch(file, () => schedule(file))
      watchers.push(w)
    } catch {
      // Fall back to watching the parent directory for (re)appearances.
      try {
        const w = fsWatch(dirOf(file), (_event, name) => {
          if (name !== null && dirOf(file) + '/' + name === file) schedule(file)
        })
        watchers.push(w)
      } catch (error) {
        options.onError?.(file, error)
      }
    }
  }

  return {
    files: () => [...targets],
    close: () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const w of watchers) w.close()
    },
  }
}

/** Posix-ish directory of a path. */
function dirOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/') || '.'
}
