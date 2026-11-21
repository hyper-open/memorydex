/**
 * memorydex — a general-purpose AI memory system.
 *
 * Public API surface. Most users use the CLI (`memorydex mcp` / `memorydex serve`)
 * or connect an agent over MCP; programmatic consumers import from here.
 */
export * from './core/types.ts'
export { MemoryService } from './core/memory.ts'
export { HashingEmbedder, cosine, type Embedder } from './core/embedder.ts'
export { openByMode, type StorageMode } from './db/index.ts'
export { openVectorStore, QdrantStore, PgVectorStore, type VectorStoreConfig } from './db/vector/index.ts'
export { openStore, DEFAULT_DB, type DbConfig } from './db/index.ts'
export { SqliteStore } from './db/sqlite.ts'
export { PgStore } from './db/pg.ts'
export { MysqlStore } from './db/mysql.ts'
export type { MemoryStore } from './db/adapter.ts'
export { importFile, importFiles, parseMarkdownSections, type ImportResult, type MdSection } from './import/markdown.ts'
export { pullFile, pushFile, reconcileFile, trackedFiles, type SyncResult } from './sync/files.ts'
export { watchFiles, type WatchHandle, type WatchOptions } from './sync/watch.ts'
export { buildMcpServer, serveMcpStdio } from './mcp/server.ts'
export { startHttpServer } from './http/server.ts'
export { watchPlatforms, type PlatformWatchOptions, type PlatformWatchHandle } from './adapters/watch-platforms.ts'
export { defaultAdapters, importPlatform, importPlatformLocation, type PlatformAdapter, type PlatformSection, type AdapterRegistry } from './adapters/index.ts'
export { CodebuddyAdapter, WorkbuddyAdapter } from './adapters/codebuddy-workbuddy.ts'
export { exportBundle, importBundle, reembedAll, BUNDLE_VERSION, type MemoryBundle } from './backup.ts'
export { loadConfig, defaultConfig, type MemorydexConfig } from './config.ts'
