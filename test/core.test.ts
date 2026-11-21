/** End-to-end tests over an in-memory SQLite store. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { parseMarkdownSections } from '../src/import/markdown.ts'

async function freshService(): Promise<MemoryService> {
  const store = new SqliteStore(':memory:')
  await store.init()
  return new MemoryService(store)
}

test('create, get, update, delete round-trips a record', async () => {
  const svc = await freshService()
  const rec = await svc.create({ kind: 'semantic', title: 'Fact', content: 'the sky is blue', tags: ['nature'] })
  assert.equal((await svc.get(rec.id))?.title, 'Fact')
  const upd = await svc.update(rec.id, { title: 'Fact2', importance: 0.9 })
  assert.equal(upd?.title, 'Fact2')
  assert.equal(upd?.importance, 0.9)
  assert.equal(await svc.delete(rec.id), true)
  assert.equal(await svc.get(rec.id), undefined)
})

test('search ranks title matches higher', async () => {
  const svc = await freshService()
  await svc.create({ kind: 'semantic', title: 'deploy guide', content: 'how to deploy' })
  await svc.create({ kind: 'semantic', title: 'unrelated', content: 'nothing here about shipping' })
  const hits = await svc.search('deploy')
  assert.equal(hits[0]?.record.title, 'deploy guide')
})

test('working memory expires', async () => {
  const svc = await freshService()
  const now = Date.now()
  await svc.create({ kind: 'working', title: 'scratch', content: 'temp', expiresAt: now - 1000 })
  assert.equal((await svc.list({ includeExpired: false })).length, 0)
  assert.equal((await svc.list({ includeExpired: true })).length, 1)
})

test('parseMarkdownSections splits by heading with slugs', () => {
  const md = '# A\n\nbody a\n\n## B\n\nbody b\n'
  const sections = parseMarkdownSections(md)
  assert.equal(sections.length, 2)
  assert.equal(sections[0]?.heading, 'A')
  assert.equal(sections[1]?.heading, 'B')
  assert.ok(sections[1]?.slug.includes('-b'))
})

test('stats counts by kind', async () => {
  const svc = await freshService()
  await svc.create({ kind: 'semantic', title: 's', content: 'x' })
  await svc.create({ kind: 'procedural', title: 'p', content: 'y' })
  const st = await svc.stats()
  assert.equal(st.total, 2)
  assert.equal(st.byKind.semantic, 1)
  assert.equal(st.byKind.procedural, 1)
})
