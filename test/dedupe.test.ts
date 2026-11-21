/** Write dedupe tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryService, fingerprint } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'

async function svc(dedupe = true): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s, null, { dedupe })
}

test('identical content merges instead of duplicating', async () => {
  const s = await svc()
  const a = await s.create({ kind: 'semantic', title: 'Fact', content: 'the sky is blue' })
  const b = await s.create({ kind: 'semantic', title: 'Fact', content: '  the sky   is blue ' }) // whitespace differs
  assert.equal(a.id, b.id)
  assert.equal((await s.allRecords()).length, 1)
})

test('same source key merges', async () => {
  const s = await svc()
  const a = await s.create({ kind: 'semantic', title: 'A', content: 'v1', source: 'file#a' })
  const b = await s.create({ kind: 'semantic', title: 'A', content: 'v2 changed', source: 'file#a' })
  assert.equal(a.id, b.id)
  assert.equal((await s.allRecords())[0]?.content, 'v2 changed')
})

test('different content does not merge', async () => {
  const s = await svc()
  await s.create({ kind: 'semantic', title: 'X', content: 'one' })
  await s.create({ kind: 'semantic', title: 'Y', content: 'two' })
  assert.equal((await s.allRecords()).length, 2)
})

test('dedupe=false keeps duplicates', async () => {
  const s = await svc(false)
  await s.create({ kind: 'semantic', title: 'Same', content: 'dup' })
  await s.create({ kind: 'semantic', title: 'Same', content: 'dup' })
  assert.equal((await s.allRecords()).length, 2)
})

test('fingerprint normalises whitespace/case', () => {
  assert.equal(fingerprint('A  B', 'c d'), fingerprint('a b', 'c  d'.toUpperCase()))
})
