/** Remote (vector store) backend factory. */
import type { MemoryStore } from '../adapter.ts'
import { QdrantStore } from './qdrant.ts'
import { PgVectorStore } from './pgvector.ts'
import type { VectorStoreConfig } from './config.ts'

/**
 * Open a remote vector store and initialise it.
 * @param config - vector store config.
 */
export async function openVectorStore(config: VectorStoreConfig): Promise<MemoryStore> {
  let store: MemoryStore
  switch (config.kind) {
    case 'qdrant': store = new QdrantStore(config); break
    case 'pgvector': store = new PgVectorStore(config); break
    default: {
      const exhaustive: never = config.kind
      throw new Error(`Unknown vector backend: ${String(exhaustive)}`)
    }
  }
  await store.init()
  return store
}

export { QdrantStore } from './qdrant.ts'
export { PgVectorStore } from './pgvector.ts'
export type { VectorStoreConfig } from './config.ts'
