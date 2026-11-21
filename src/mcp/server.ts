/**
 * MCP server exposing the memory service as tools.
 *
 * Tools (stable MCP v1 SDK): memory_write, memory_search, memory_list,
 * memory_get, memory_update, memory_delete, memory_stats, memory_import,
 * memory_sync. Any MCP-capable agent (DSH, Claude, Cursor, …) can connect over
 * stdio and use these.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { MemoryService } from '../core/memory.ts'
import { MEMORY_KINDS, type MemoryKind } from '../core/types.ts'
import { importFiles } from '../import/markdown.ts'
import { pullFile, pushFile, reconcileFile, trackedFiles } from '../sync/files.ts'

const kindEnum = z.enum(['working', 'episodic', 'semantic', 'procedural'])

/** Wrap any tool result value as MCP text content. */
function ok(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

/**
 * Build an MCP server bound to a memory service.
 * @param service - the memory service to expose.
 */
export function buildMcpServer(service: MemoryService): McpServer {
  const server = new McpServer({ name: 'memorydex', version: '0.1.0' })

  server.registerTool(
    'memory_write',
    {
      title: 'Write a memory',
      description: 'Create a memory record. kind is one of working/episodic/semantic/procedural.',
      inputSchema: {
        kind: kindEnum,
        title: z.string().describe('Short title'),
        content: z.string().describe('Body text (Markdown allowed)'),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        expiresAt: z.number().int().optional().describe('epoch millis for working memory TTL'),
        links: z.array(z.string()).optional().describe('related memory ids'),
        pinned: z.boolean().optional(),
      },
    },
    async (args) => ok(await service.create({ ...args, kind: args.kind as MemoryKind, origin: 'agent' })),
  )

  server.registerTool(
    'memory_search',
    {
      title: 'Search memory',
      description: 'Relevance-search memory across title/content/tags, optionally filtered by kind/tags/source.',
      inputSchema: {
        query: z.string().default(''),
        kind: kindEnum.optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => ok(await service.search(args.query ?? '', { kind: args.kind, tags: args.tags, source: args.source, limit: args.limit ?? 20 })),
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List memory',
      description: 'List memories filtered by kind/tags/source/origin, most-recently updated first.',
      inputSchema: {
        kind: kindEnum.optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        includeExpired: z.boolean().optional(),
      },
    },
    async (args) => ok(await service.list(args)),
  )

  server.registerTool(
    'memory_get',
    { title: 'Get a memory', description: 'Fetch one memory record by id.', inputSchema: { id: z.string() } },
    async (args) => ok(await service.get(args.id) ?? { error: 'not found', id: args.id }),
  )

  server.registerTool(
    'memory_update',
    {
      title: 'Update a memory',
      description: 'Partially update a memory record by id.',
      inputSchema: {
        id: z.string(),
        kind: kindEnum.optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        expiresAt: z.number().int().nullable().optional(),
        links: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
      },
    },
    async ({ id, ...patch }) => ok(await service.update(id, patch) ?? { error: 'not found', id }),
  )

  server.registerTool(
    'memory_delete',
    { title: 'Delete a memory', description: 'Delete a memory record by id.', inputSchema: { id: z.string() } },
    async (args) => ok({ deleted: await service.delete(args.id), id: args.id }),
  )

  server.registerTool(
    'memory_touch',
    { title: 'Touch a memory', description: 'Bump a memory access count (call when you actually use a hit).', inputSchema: { id: z.string() } },
    async (args) => { await service.touch(args.id); return ok({ touched: true, id: args.id }) },
  )

  server.registerTool(
    'memory_pin',
    { title: 'Pin/unpin a memory', description: 'Pinned memories rank above unpinned in search.', inputSchema: { id: z.string(), pinned: z.boolean().default(true) } },
    async (args) => ok(await service.update(args.id, { pinned: args.pinned }) ?? { error: 'not found', id: args.id }),
  )

  server.registerTool(
    'memory_stats',
    { title: 'Memory stats', description: 'Counts by memory kind.' },
    async () => ok(await service.stats()),
  )

  server.registerTool(
    'memory_import',
    {
      title: 'Import memory files',
      description: 'One-click import of local Markdown memory files (AGENTS.md / CLAUDE.md / any .md) into memory.',
      inputSchema: { files: z.array(z.string()).min(1) },
    },
    async (args) => ok(await importFiles(service, args.files)),
  )

  server.registerTool(
    'memory_sync',
    {
      title: 'Sync memory with files',
      description: 'Two-way sync between tracked files and memory. direction=pull (file→memory), push (memory→file), or reconcile.',
      inputSchema: {
        file: z.string().optional(),
        direction: z.enum(['pull', 'push', 'reconcile']).default('pull'),
      },
    },
    async (args) => {
      if (args.file === undefined) {
        const files = await trackedFiles(service)
        const out = []
        for (const f of files) out.push(args.direction === 'push' ? await pushFile(service, f) : await pullFile(service, f))
        return ok(out)
      }
      if (args.direction === 'push') return ok(await pushFile(service, args.file))
      if (args.direction === 'reconcile') return ok((await reconcileFile(service, args.file)).result)
      return ok(await pullFile(service, args.file))
    },
  )

  return server
}

/**
 * Serve the memory service over MCP stdio (blocks until the transport closes).
 * @param service - the memory service.
 */
export async function serveMcpStdio(service: MemoryService): Promise<void> {
  const server = buildMcpServer(service)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export { MEMORY_KINDS }
