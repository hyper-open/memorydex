/** search() fast-path: uses store.vectorSearch when available. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import type { MemoryStore } from '../src/db/adapter.ts'
import type { MemoryRecord } from '../src/core/types.ts'

function rec(id: string, title: string, content: string, embedding: number[]): MemoryRecord {
  return { id, kind: 'semantic', title, content, tags: [], importance: 0.5, origin: 'manual', metadata: {}, createdAt: 1, updatedAt: 1, embedding }
}

/** A store whose all() throws to prove the ANN path does not scan everything. */
class AnnStore implements MemoryStore {
  backend = 'ann'
  constructor(private readonly records: MemoryRecord[]) {}
  async init() {}
  async put() {}
  async get() { return undefined }
  async delete() { return false }
  async all(): Promise<MemoryRecord[]> { throw new Error('all() must NOT be called when ANN is available') }
  async close() {}
  async vectorSearch(_v: number[], limit: number) { return this.records.slice(0, limit).map(r => ({ record: r, score: 1 })) }
}

async function embedderOf() {
  // hashing embedder, dim 256
  const { HashingEmbedder } = await import('../src/core/embedder.ts')
  return new HashingEmbedder(256)
}

test('search uses vectorSearch (ANN) and does not call all()', async () => {
  const e = await embedderOf()
  const a = rec('a', 'deploy', 'docker k8s', await e.embed('deploy docker k8s'))
  const b = rec('b', 'bake', 'flour yeast', await e.embed('bake flour yeast'))
  const s = new MemoryService(new AnnStore([a, b]), e)
  const hits = await s.search('docker deploy')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0]?.record.id, 'a')
})

test('search falls back to all() when no vectorSearch', async () => {
  const e = await embedderOf()
  const store = new SqliteStore(':memory:'); await store.init()
  const s = new MemoryService(store, e)
  await s.create({ kind: 'semantic', title: 'docker deploy', content: 'k8s' })
  const hits = await s.search('docker')
  assert.equal(hits.length, 1)
})
