/**
 * Codebuddy and WorkBuddy platform adapters.
 *
 * Both store memories as Markdown on disk (verified by on-machine inspection):
 * - Codebuddy: `~/.codebuddy/projects/<proj>/memory/*.md` with YAML frontmatter
 *   (`name`/`description`/`type: feedback|project|user|reference`). Writable.
 * - WorkBuddy: root `SOUL.md`/`USER.md`/`IDENTITY.md`/`MEMORY.md`/`BOOTSTRAP.md`
 *   (writable) and `memory/<uid>_memory.md` (runtime-maintained; read-only here).
 *
 * These adapters are READ-capable; `writable` reflects whether the source is a
 * plain file we can safely write back. Headings/frontmatter are mapped to memory
 * sections; the platform tag comes from the adapter id.
 */
import { readFile, readdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import type { PlatformAdapter, PlatformSection } from './types.ts'

/** Parse YAML-ish frontmatter (only top-level scalar `key: value` lines). */
function parseFrontmatter(text: string): { attrs: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m === null) return { attrs: {}, body: text }
  const attrs: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) attrs[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return { attrs, body: text.slice(m[0].length) }
}

/** Map a codebuddy frontmatter `type` to a memory kind. */
function kindFromType(type: string | undefined): 'semantic' | 'procedural' | 'episodic' {
  switch (type) {
    case 'feedback': return 'procedural'   // how-to / preferences to apply
    case 'project': return 'semantic'       // project facts
    case 'user': return 'semantic'          // user facts
    case 'reference': return 'semantic'
    default: return 'semantic'
  }
}

/** Codebuddy adapter: `~/.codebuddy/projects/<proj>/memory/*.md`. */
export class CodebuddyAdapter implements PlatformAdapter {
  readonly platform = 'codebuddy'
  readonly writable = true
  constructor(private readonly home = homedir()) {}

  async discover(): Promise<string[]> {
    const root = `${this.home}/.codebuddy/projects`
    const out: string[] = []
    let projs: string[] = []
    try { projs = await readdir(root) } catch { return out }
    for (const proj of projs) {
      const memDir = `${root}/${proj}/memory`
      try {
        const files = await readdir(memDir)
        for (const f of files) if (f.endsWith('.md')) out.push(`${memDir}/${f}`)
      } catch { /* no memory dir */ }
    }
    return out
  }

  async read(location: string): Promise<PlatformSection[]> {
    const text = await readFile(location, 'utf8')
    const { attrs, body } = parseFrontmatter(text)
    const title = attrs.name ?? firstHeading(body) ?? basename(location)
    const content = (attrs.description !== undefined ? `${attrs.description}\n\n` : '') + body.trim()
    // one record per file (these files are already atomic memories)
    return [{ slug: slugify(basename(location)), title, content, kind: kindFromType(attrs.type) }]
  }
}

/** WorkBuddy adapter: root persona/memory md + `memory/<uid>_memory.md`. */
export class WorkbuddyAdapter implements PlatformAdapter {
  readonly platform = 'workbuddy'
  // Root files are plain writable files; <uid>_memory.md is runtime-owned.
  readonly writable = true
  constructor(private readonly home = homedir()) {}

  private readonly rootFiles = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md', 'BOOTSTRAP.md']

  async discover(): Promise<string[]> {
    const base = `${this.home}/.workbuddy`
    const out: string[] = []
    for (const f of this.rootFiles) {
      const p = `${base}/${f}`
      try { await access(p, constants.R_OK); out.push(p) } catch { /* missing */ }
    }
    // user memory profiles (read-only in practice — flagged via slug prefix)
    try {
      const mem = await readdir(`${base}/memory`)
      for (const f of mem) if (f.endsWith('_memory.md')) out.push(`${base}/memory/${f}`)
    } catch { /* none */ }
    return out
  }

  async read(location: string): Promise<PlatformSection[]> {
    const text = await readFile(location, 'utf8')
    const isUserMemory = /_memory\.md$/.test(location)
    if (isUserMemory) {
      // Extract the embedded RAW_JSON memoryBlock if present.
      const block = extractMemoryBlock(text)
      const title = 'User Memory Profile'
      return [{ slug: slugify(basename(location)), title, content: block ?? (stripJsonBlock(text).trim() || text.trim()), kind: 'semantic' }]
    }
    const title = firstHeading(text) ?? basename(location)
    return [{ slug: slugify(basename(location)), title, content: text.trim(), kind: /USER|MEMORY/i.test(basename(location)) ? 'semantic' : 'semantic' }]
  }
}

/** Extract a `memoryBlock` string from an embedded RAW_JSON block, if any. */
function extractMemoryBlock(text: string): string | undefined {
  const m = /<!--\s*RAW_JSON_START([\s\S]*?)RAW_JSON_END\s*-->/.exec(text)
  if (m === null) return undefined
  try {
    const obj = JSON.parse(m[1]!.trim()) as { memoryBlock?: unknown }
    if (typeof obj.memoryBlock === 'string' && obj.memoryBlock.trim() !== '') return obj.memoryBlock.trim()
    return undefined
  } catch {
    return undefined
  }
}

/** Remove the RAW_JSON block from text (for the readable fallback). */
function stripJsonBlock(text: string): string {
  return text.replace(/<!--\s*RAW_JSON_START[\s\S]*?RAW_JSON_END\s*-->/g, '')
}

function firstHeading(text: string): string | undefined {
  const m = /^#{1,6}\s+(.+)$/m.exec(text)
  return m?.[1]?.trim()
}
function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean); return parts[parts.length - 1] ?? p
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item'
}
