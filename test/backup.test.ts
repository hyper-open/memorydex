/** Backup export/import + limit clamp tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryService, DEFAULT_LIMIT } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { exportBundle, importBundle } from '../src/backup.ts'

async function svc(): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s)
}

test('export then import into fresh store (merge)', async () => {
  const a = await svc()
  await a.create({ kind: 'semantic', title: 'A', content: 'a', tags: ['x'] })
  await a.create({ kind: 'procedural', title: 'B', content: 'b' })
  const bundle = await exportBundle(a)
  assert.equal(bundle.count, 2)
  const b = await svc()
  const r = await importBundle(b, bundle)
  assert.equal(r.inserted, 2)
  assert.equal((await b.allRecords()).length, 2)
  // merge again -> all skipped
  const r2 = await importBundle(b, bundle)
  assert.equal(r2.skipped, 2)
})

test('replace mode wipes then loads', async () => {
  const a = await svc(); await a.create({ kind: 'semantic', title: 'old', content: 'x' })
  const b = await svc(); await b.create({ kind: 'semantic', title: 'keep?', content: 'y' })
  const bundle = await exportBundle(a)
  const r = await importBundle(b, bundle, 'replace')
  assert.equal(r.inserted, 1)
  const titles = (await b.allRecords()).map(x => x.title)
  assert.deepEqual(titles, ['old'])
})

test('list/search default to a capped page size', async () => {
  const s = await svc()
  const total = 1005
  for (let i = 0; i < total; i++) await s.create({ kind: 'semantic', title: `t${i}`, content: 'c' })
  assert.equal((await s.list({})).length, DEFAULT_LIMIT)
  assert.equal((await s.list({ limit: 999999 })).length, 1000) // capped at MAX_LIMIT (from 1005 records)
})
