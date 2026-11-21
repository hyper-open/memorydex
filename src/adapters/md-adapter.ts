/**
 * Markdown-backed platform adapter (Claude Code `CLAUDE.md`, Codex `AGENTS.md`,
 * and any generic `.md`). Fully readable and writable.
 */
import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { PlatformAdapter, PlatformSection } from './types.ts'
import { parseMarkdownSections } from '../import/markdown.ts'

/** Keywords that mark a section as procedural (how-to). */
const PROCEDURAL_HINTS = /(command|install|build|test|run|usage|setup|quick ?start|deploy|命令|安装|构建|测试|运行|使用|部署|步骤|流程|规范)/i

/** A Markdown-file adapter with a fixed platform label and candidate filenames. */
export class MarkdownAdapter implements PlatformAdapter {
  readonly writable = true

  /**
   * @param platform - platform id to tag records with.
   * @param candidates - filenames to look for in a directory (e.g. ['CLAUDE.md']).
   * @param roots - directories to search on discover() (defaults to none; caller passes files).
   */
  constructor(
    readonly platform: string,
    private readonly candidates: readonly string[],
    private readonly roots: readonly string[] = [],
  ) {}

  async discover(): Promise<string[]> {
    const out: string[] = []
    for (const root of this.roots) {
      for (const name of this.candidates) {
        const file = root.endsWith('/') ? root + name : `${root}/${name}`
        try { await access(file, constants.R_OK); out.push(file) } catch { /* missing */ }
      }
    }
    return out
  }

  async read(location: string): Promise<PlatformSection[]> {
    const md = await readFile(location, 'utf8')
    return parseMarkdownSections(md)
      .filter(s => s.heading !== '' || s.body !== '')
      .map(s => ({
        slug: s.slug,
        title: s.heading === '' ? `${basename(location)}（前言）` : s.heading,
        content: s.body === '' ? s.heading : s.body,
        kind: PROCEDURAL_HINTS.test(`${s.heading} ${s.body.slice(0, 200)}`) ? 'procedural' : 'semantic',
      }))
  }
}

/** Basename of a path. */
function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Built-in Claude Code adapter (project CLAUDE.md + user ~/.claude/CLAUDE.md). */
export function claudeAdapter(home: string): MarkdownAdapter {
  return new MarkdownAdapter('claude', ['CLAUDE.md', 'CLAUDE.local.md'], [`${home}/.claude`, '.'])
}

/** Built-in Codex adapter (AGENTS.md). */
export function codexAdapter(home: string): MarkdownAdapter {
  return new MarkdownAdapter('codex', ['AGENTS.md', 'AGENTS.local.md'], ['.'])
}
