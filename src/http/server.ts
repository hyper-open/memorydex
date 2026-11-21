/**
 * HTTP server: REST API for the memory service + a static web UI.
 *
 * Endpoints (all under /api):
 *   GET  /api/state                  -> { stats, kinds }
 *   GET  /api/memories?kind&q&tags   -> search/list
 *   POST /api/memories               -> create
 *   GET  /api/memories/:id           -> get
 *   PATCH /api/memories/:id          -> update
 *   DELETE /api/memories/:id         -> delete
 *   POST /api/import  { files }      -> import
 *   POST /api/sync    { file?, direction } -> sync
 * UI at / serves web/ (index.html + assets).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { MemoryService } from '../core/memory.ts'
import type { MemoryFilter, MemoryKind, MemoryUpdateInput } from '../core/types.ts'
import { MEMORY_KINDS } from '../core/types.ts'
import { importFiles } from '../import/markdown.ts'
import { pullFile, pushFile, trackedFiles } from '../sync/files.ts'
import { defaultAdapters, importPlatform } from '../adapters/index.ts'
import { homedir } from 'node:os'

/** Read a JSON body (bounded). */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 4 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return (text.trim() === '' ? {} : JSON.parse(text)) as T
}

/** Send JSON. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(data)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

/**
 * Start the HTTP server.
 * @param service - memory service.
 * @param webDir - directory holding the static UI.
 * @param host/port - bind target.
 * @returns the http server.
 */
export function startHttpServer(service: MemoryService, webDir: string, host: string, port: number) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname
      if (path.startsWith('/api/')) return await handleApi(service, req, res, url)
      return await serveStatic(webDir, path, res)
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.listen(port, host)
  return server
}

async function handleApi(service: MemoryService, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const segments = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const rest = segments.slice(1)

  if (rest[0] === 'state' && method === 'GET') {
    json(res, 200, { stats: await service.stats(), kinds: MEMORY_KINDS })
    return
  }
  if (rest[0] === 'memories' && rest[1] === undefined) {
    if (method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const filter = parseFilter(url)
      const result = q.trim() === '' ? await service.list(filter) : (await service.search(q, filter)).map(h => h.record)
      json(res, 200, { memories: result })
      return
    }
    if (method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req)
      json(res, 200, await service.create(body as never))
      return
    }
  }
  if (rest[0] === 'memories' && rest[1] !== undefined) {
    const id = decodeURIComponent(rest[1])
    if (method === 'GET') { json(res, 200, await service.get(id) ?? { error: 'not found' }); return }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson<MemoryUpdateInput>(req)
      json(res, 200, await service.update(id, body) ?? { error: 'not found' })
      return
    }
    if (method === 'DELETE') { json(res, 200, { deleted: await service.delete(id) }); return }
  }
  if (rest[0] === 'import' && method === 'POST') {
    const body = await readJson<{ files: string[] }>(req)
    if (!Array.isArray(body.files) || body.files.length === 0) { json(res, 400, { error: 'files[] required' }); return }
    json(res, 200, await importFiles(service, body.files))
    return
  }
  if (rest[0] === 'sync' && method === 'POST') {
    const body = await readJson<{ file?: string; direction?: 'pull' | 'push' | 'reconcile' }>(req)
    const direction = body.direction ?? 'pull'
    if (body.file === undefined) {
      const files = await trackedFiles(service)
      const out = []
      for (const f of files) out.push(direction === 'push' ? await pushFile(service, f) : await pullFile(service, f))
      json(res, 200, out)
      return
    }
    if (direction === 'push') { json(res, 200, await pushFile(service, body.file)); return }
    json(res, 200, await pullFile(service, body.file))
    return
  }
  if (rest[0] === 'audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '200')
    json(res, 200, { events: await service.audit_events(Number.isFinite(limit) ? limit : 200) })
    return
  }
  if (rest[0] === 'platforms' && method === 'GET') {
    const reg = defaultAdapters(homedir())
    const out: Record<string, { writable: boolean; files: string[] }> = {}
    for (const a of reg.list()) {
      let files: string[] = []
      try { files = await a.discover() } catch { files = [] }
      out[a.platform] = { writable: a.writable, files }
    }
    json(res, 200, out)
    return
  }
  if (rest[0] === 'import-platform' && method === 'POST') {
    const body = await readJson<{ platform?: string; files?: string[] }>(req)
    const reg = defaultAdapters(homedir())
    const adapter = body.platform === undefined ? undefined : reg.get(body.platform)
    if (adapter === undefined) { json(res, 400, { error: 'unknown platform', have: reg.list().map(a => a.platform) }); return }
    json(res, 200, await importPlatform(service, adapter, body.files))
    return
  }
  if (rest[0] === 'tracked' && method === 'GET') {
    json(res, 200, { files: await trackedFiles(service) })
    return
  }
  json(res, 404, { error: 'not found', path: url.pathname })
}

function parseFilter(url: URL): MemoryFilter {
  const kind = url.searchParams.get('kind')
  const tags = url.searchParams.get('tags')
  const filter: MemoryFilter = {}
  if (kind !== null && MEMORY_KINDS.includes(kind as MemoryKind)) (filter as { kind?: MemoryKind }).kind = kind as MemoryKind
  if (tags !== null) (filter as { tags?: string[] }).tags = tags.split(',').map(t => t.trim()).filter(Boolean)
  const source = url.searchParams.get('source')
  if (source !== null) (filter as { source?: string }).source = source
  const limit = url.searchParams.get('limit')
  if (limit !== null) (filter as { limit?: number }).limit = Number(limit)
  return filter
}

async function serveStatic(webDir: string, path: string, res: ServerResponse): Promise<void> {
  const rel = path === '/' ? '/index.html' : path
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  const file = join(webDir, safe)
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
  }
}
