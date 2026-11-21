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
  memorydex export [file.json]      Export all memories to a JSON bundle
  memorydex restore <file.json> [--replace]  Restore a bundle (merge|replace)
  memorydex reembed                 Recompute embeddings (after switching models)
  memorydex scan                    Discover CLAUDE.md/AGENTS.md from known platforms
  memorydex import-platform --platform <claude|codex|md> [files...]
 * Common flags: --db <sqlite|pg|mysql> --db-path <path> --db-url <url> --config <file>
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryService } from './core/memory.ts'
import { MEMORY_KINDS, type MemoryKind } from './core/types.ts'
import { loadConfig } from './config.ts'
import { openStore } from './db/index.ts'
import { resolveEmbedder } from './embedder-config.ts'
import { importFiles } from './import/markdown.ts'
import { serveMcpStdio } from './mcp/server.ts'
import { startHttpServer } from './http/server.ts'
import { pullFile, pushFile, reconcileFile } from './sync/files.ts'
import { watchFiles } from './sync/watch.ts'
import { exportBundle, importBundle, reembedAll, type MemoryBundle } from './backup.ts'
import { defaultAdapters } from './adapters/index.ts'
import { importPlatform } from './adapters/index.ts'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'

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
  // Embedding config: env/config defaults, with CLI overrides.
  const emb = { ...config.embedding }
  if (flags['embed-off'] === true) (emb as { enabled?: boolean }).enabled = false
  if (typeof flags['embed-url'] === 'string') { (emb as { url?: string }).url = flags['embed-url']; (emb as { kind?: string }).kind = 'http' }
  if (typeof flags['embed-model'] === 'string') (emb as { model?: string }).model = flags['embed-model']
  if (typeof flags['embed-key'] === 'string') (emb as { apiKey?: string }).apiKey = flags['embed-key']
  if (flags['embed-hashing'] === true) (emb as { kind?: string }).kind = 'hashing'
  const resolved = await resolveEmbedder(emb)
  if (resolved.note !== undefined) process.stderr.write(`memorydex: ${resolved.note}\n`)
  const store = await openStore(db)
  const dedupe = flags['no-dedupe'] === true ? false : config.dedupe
  const service = new MemoryService(store, resolved.embedder ?? null, { dedupe })
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
  memorydex watch [file...]         Auto-sync file changes into memory
  memorydex stats
  memorydex export [file.json]      Export all memories to a JSON bundle
  memorydex restore <file.json> [--replace]  Restore a bundle (merge|replace)
  memorydex reembed                 Recompute embeddings (after switching models)
  memorydex scan                    Discover CLAUDE.md/AGENTS.md from known platforms
  memorydex import-platform --platform <claude|codex|md> [files...]

Flags: --db <sqlite|pg|mysql>  --db-path <sqlite file>  --db-url <pg/mysql url>  --config <file>
       --embed-url <url>  --embed-model <name>  --embed-key <key>  --embed-off  --embed-hashing
       --no-dedupe
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
} else if (cmd === 'watch') {
  const { service, close } = await openService(flags)
  const files = pos.length > 0 ? pos : undefined
  const handle = await watchFiles(service, files, {
    onSync: (f, a, u, r) => process.stdout.write(`synced ${f}: +${a} ~${u} -${r}\n`),
    onError: (f, e) => process.stderr.write(`watch error ${f}: ${String(e)}\n`),
  })
  process.stdout.write(`watching ${handle.files().length} file(s); Ctrl-C to stop\n`)
  // Keep the process alive; close cleanly on Ctrl-C.
  await new Promise<void>(resolve => {
    const stop = (): void => { handle.close(); void close().finally(() => resolve()) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
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
        const files = [...new Set((await service.allRecords()).map(r => r.source?.split('#')[0]).filter((x): x is string => !!x))]
        for (const f of files) process.stdout.write(JSON.stringify(dir === 'push' ? await pushFile(service, f) : await reconcileFile(service, f).then(r => r.result)) + '\n')
      }
    } else if (cmd === 'scan') {
      const reg = defaultAdapters(homedir())
      const out: Record<string, string[]> = {}
      for (const a of reg.list()) {
        try { out[a.platform] = await a.discover() } catch { out[a.platform] = [] }
      }
      process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    } else if (cmd === 'import-platform') {
      const platform = typeof flags.platform === 'string' ? flags.platform : pos.shift()
      if (platform === undefined) { process.stderr.write('import-platform needs --platform <claude|codex|md>\n'); process.exit(1) }
      const reg = defaultAdapters(homedir())
      const adapter = reg.get(platform)
      if (adapter === undefined) { process.stderr.write(`unknown platform: ${platform} (have: ${reg.list().map(a => a.platform).join(', ')})\n`); process.exit(1) }
      const files = pos.length > 0 ? pos : undefined
      const res = await importPlatform(service, adapter, files)
      process.stdout.write(JSON.stringify(res.map(r => ({ platform: r.platform, location: r.location, imported: r.imported, updated: r.updated, unchanged: r.unchanged })), null, 2) + '\n')
    } else if (cmd === 'stats') {
      process.stdout.write(JSON.stringify(await service.stats(), null, 2) + '\n')
    } else if (cmd === 'export') {
      const out = pos[0] ?? 'memorydex-backup.json'
      const bundle = await exportBundle(service)
      await writeFile(out, JSON.stringify(bundle, null, 2), 'utf8')
      process.stdout.write(`exported ${bundle.count} records -> ${out}\n`)
    } else if (cmd === 'restore') {
      const file = pos[0]
      if (file === undefined) { process.stderr.write('restore needs a bundle file\n'); process.exit(1) }
      const bundle = JSON.parse(await readFile(file, 'utf8')) as MemoryBundle
      const mode = flags.replace === true ? 'replace' : 'merge'
      const r = await importBundle(service, bundle, mode)
      process.stdout.write(`restored: inserted ${r.inserted}, skipped ${r.skipped} (mode ${mode})\n`)
    } else if (cmd === 'reembed') {
      const n = await reembedAll(service)
      process.stdout.write(`re-embedded ${n} records\n`)
    } else {
      printHelp()
    }
  } finally {
    await close()
  }
}
