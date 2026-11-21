/**
 * Import local memory files (AGENTS.md / CLAUDE.md / arbitrary .md) into memory.
 *
 * Strategy: split a Markdown file into heading-delimited sections; each section
 * becomes one memory record. The record's `source` encodes `<file>#<slug>` so the
 * sync layer can diff file sections against stored records by that stable key.
 * Section kind is inferred from its heading (procedural for commands/how-to,
 * semantic by default; project "standing orders" read as procedural).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { MemoryService } from '../core/memory.ts'
import { type MemoryKind, type MemoryRecord } from '../core/types.ts'

/** One parsed section of a Markdown file. */
export interface MdSection {
  /** Heading text ('' for the preamble before the first heading). */
  readonly heading: string
  /** Heading level (0 for preamble). */
  readonly level: number
  /** Body text under the heading (trimmed). */
  readonly body: string
  /** Stable slug derived from the heading path. */
  readonly slug: string
}

/** Result of importing one file. */
export interface ImportResult {
  readonly file: string
  readonly imported: number
  readonly updated: number
  readonly unchanged: number
  readonly records: MemoryRecord[]
}

/** Keywords that suggest a procedural (how-to) section. */
const PROCEDURAL_HINTS = /(command|install|build|test|run|usage|setup|quick ?start|deploy|命令|安装|构建|测试|运行|使用|部署|步骤|流程|规范)/i

/**
 * Split Markdown into heading-delimited sections.
 * @param markdown - file contents.
 * @returns sections in order, with hierarchical slugs.
 */
export function parseMarkdownSections(markdown: string): MdSection[] {
  const lines = markdown.split(/\r?\n/)
  const sections: MdSection[] = []
  let cur: { heading: string; level: number; lines: string[]; path: string[] } = { heading: '', level: 0, lines: [], path: [] }
  const flush = (): void => {
    const body = cur.lines.join('\n').trim()
    if (cur.heading !== '' || body !== '') {
      sections.push({ heading: cur.heading, level: cur.level, body, slug: cur.path.length === 0 ? '_preamble' : slugify(cur.path.join('-')) })
    }
  }
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      const heading = m[2].trim()
      // maintain heading path stack
      cur = { heading, level, lines: [], path: cur.path.slice(0, level - 1).concat(heading) }
    } else {
      cur.lines.push(line)
    }
  }
  flush()
  return sections.filter(s => s.heading !== '' || s.body !== '')
}

/** Infer a memory kind for a section from its heading/body. */
function inferKind(section: MdSection): MemoryKind {
  const hay = `${section.heading} ${section.body.slice(0, 200)}`
  return PROCEDURAL_HINTS.test(hay) ? 'procedural' : 'semantic'
}

/** Import a single file into the memory service. */
export async function importFile(service: MemoryService, file: string, kind?: MemoryKind): Promise<ImportResult> {
  const markdown = await readFile(file, 'utf8')
  const sections = parseMarkdownSections(markdown)
  const existing = await service.allRecords()
  const bySource = new Map<string, MemoryRecord>()
  for (const r of existing) if (r.source !== undefined) bySource.set(r.source, r)

  let imported = 0
  let updated = 0
  let unchanged = 0
  const records: MemoryRecord[] = []
  for (const section of sections) {
    const source = `${file}#${section.slug}`
    const effectiveKind = kind ?? inferKind(section)
    const title = section.heading === '' ? `${basename(file)}（前言）` : section.heading
    const content = section.body === '' ? section.heading : section.body
    const hash = contentHash(content)
    const prev = bySource.get(source)
    if (prev !== undefined && contentHash(prev.content) === hash && prev.title === title && prev.kind === effectiveKind) {
      unchanged += 1
      records.push(prev)
      continue
    }
    if (prev !== undefined) {
      const next = await service.update(prev.id, { title, content, kind: effectiveKind, source })
      if (next !== undefined) { updated += 1; records.push(next) }
    } else {
      const rec = await service.create({ kind: effectiveKind, title, content, origin: 'import', source, metadata: { file, heading: section.heading } })
      imported += 1
      records.push(rec)
    }
  }
  return { file, imported, updated, unchanged, records }
}

/** Import several files. */
export async function importFiles(service: MemoryService, files: readonly string[]): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  for (const f of files) out.push(await importFile(service, f))
  return out
}

/** Stable content hash for change detection. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

/** Slugify a heading path for use in a source key. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section'
}

/** Basename of a path (works on posix + windows). */
function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}
