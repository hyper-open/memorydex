#!/usr/bin/env node
/**
 * memorydex CLI.
 *
 *   memorydex mcp             # run the MCP stdio server (for DSH/Claude/Cursor…)
 *   memorydex serve           # run the HTTP REST API + web UI
 *   memorydex write ...       # quick write
 *   memorydex search "..."    # quick search
 *   memorydex list [--kind k] # list
 *   memorydex import <files..># one-click import AGENTS.md/CLAUDE.md
 *   memorydex sync [--push] [file]  # two-way sync
 *   memorydex stats
 * Common flags: --db <sqlite|pg|mysql> --db-path <path> --db-url <url> --config <file>
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryService } from './core/memory.ts'
import { MEMORY_KINDS, type MemoryKind } from './core/types.ts'
import { loadConfig } from './config.ts'
import { openStore } from './db/index.ts'
import { importFiles } from './import/markdown.ts'
import { serveMcpStdio } from './mcp/server.ts'
import { startHttpServer } from './http/server.ts'
import { pullFile, pushFile, reconcileFile } from './sync/files.ts'

/** Parse argv into { cmd, positionals, flags }. */
function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv
  const pos: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = true
    } else pos.push(a)
  }
  return { cmd, pos, flags }
}

/** Open the service from CLI flags/config. */
async function openService(flags: Record<string, string | boolean>): Promise<{ service: MemoryService; close: () => Promise<void> }> {
  const config = loadConfig(typeof flags.config === 'string' ? flags.config : undefined)
  const db = { ...config.db }
  if (typeof flags.db === 'string') (db as { kind: string }).kind = flags.db
  if (typeof flags['db-path'] === 'string') (db as { path: string }).path = flags['db-path']
  if (typeof flags['db-url'] === 'string') (db as { url: string }).url = flags['db-url']
  if (db.kind === 'sqlite' && db.path !== ':memory:') await mkdir(dirname(db.path!), { recursive: true })
  const store = await openStore(db)
  const service = new MemoryService(store)
  return { service, close: () => store.close() }
}

function printHelp(): void {
  process.stdout.write(`memorydex — general-purpose AI memory

Usage:
  memorydex mcp                       Run the MCP stdio server
  memorydex serve [--port N]          Run HTTP REST API + web UI
  memorydex write --kind K --title T [--content C] [--tags a,b]
  memorydex search "query" [--kind K]
  memorydex list [--kind K] [--tags a,b]
  memorydex import <file...>          Import AGENTS.md/CLAUDE.md/any .md
  memorydex sync [--push|--pull] [file]
  memorydex stats

Flags: --db <sqlite|pg|mysql>  --db-path <sqlite file>  --db-url <pg/mysql url>  --config <file>
Kinds: ${MEMORY_KINDS.join(', ')}
`)
}

const { cmd, pos, flags } = parseArgs(process.argv.slice(2))

if (cmd === 'mcp') {
  const { service } = await openService(flags)
  await serveMcpStdio(service)
} else if (cmd === 'serve') {
  const config = loadConfig(typeof flags.config === 'string' ? flags.config : undefined)
  const { service } = await openService(flags)
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const port = typeof flags.port === 'string' ? Number(flags.port) : config.port
  startHttpServer(service, webDir, config.host, port)
  process.stdout.write(`memorydex UI + API on http://${config.host}:${port}\n`)
} else {
  const { service, close } = await openService(flags)
  try {
    if (cmd === 'write') {
      const kind = (typeof flags.kind === 'string' ? flags.kind : 'semantic') as MemoryKind
      const title = typeof flags.title === 'string' ? flags.title : (pos[0] ?? '')
      const content = typeof flags.content === 'string' ? flags.content : (pos.slice(1).join(' ') || title)
      const tags = typeof flags.tags === 'string' ? flags.tags.split(',').map(t => t.trim()).filter(Boolean) : []
      const rec = await service.create({ kind, title, content, tags })
      process.stdout.write(JSON.stringify(rec, null, 2) + '\n')
    } else if (cmd === 'search') {
      const query = pos.join(' ')
      const kind = typeof flags.kind === 'string' ? (flags.kind as MemoryKind) : undefined
      const hits = await service.search(query, kind === undefined ? {} : { kind })
      process.stdout.write(JSON.stringify(hits.map(h => ({ score: Number(h.score.toFixed(2)), ...h.record })), null, 2) + '\n')
    } else if (cmd === 'list') {
      const kind = typeof flags.kind === 'string' ? (flags.kind as MemoryKind) : undefined
      process.stdout.write(JSON.stringify(await service.list(kind === undefined ? {} : { kind }), null, 2) + '\n')
    } else if (cmd === 'import') {
      if (pos.length === 0) { process.stderr.write('import needs at least one file\n'); process.exit(1) }
      const res = await importFiles(service, pos)
      process.stdout.write(JSON.stringify(res.map(r => ({ file: r.file, imported: r.imported, updated: r.updated, unchanged: r.unchanged })), null, 2) + '\n')
    } else if (cmd === 'sync') {
      const dir = flags.push === true ? 'push' : 'pull'
      if (pos[0] !== undefined) {
        process.stdout.write(JSON.stringify(dir === 'push' ? await pushFile(service, pos[0]) : await pullFile(service, pos[0]), null, 2) + '\n')
      } else {
        const files = await service.list({ limit: Number.POSITIVE_INFINITY }).then(rs => [...new Set(rs.map(r => r.source?.split('#')[0]).filter((x): x is string => !!x))])
        for (const f of files) process.stdout.write(JSON.stringify(dir === 'push' ? await pushFile(service, f) : await reconcileFile(service, f).then(r => r.result)) + '\n')
      }
    } else if (cmd === 'stats') {
      process.stdout.write(JSON.stringify(await service.stats(), null, 2) + '\n')
    } else {
      printHelp()
    }
  } finally {
    await close()
  }
}
