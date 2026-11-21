/** Advanced retrieval + watch tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { HashingEmbedder, cosine } from '../src/core/embedder.ts'
import { importFile } from '../src/import/markdown.ts'
import { watchFiles } from '../src/sync/watch.ts'

async function svc(): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s)
}

test('hashing embedder produces unit vectors and cosine is sane', async () => {
  const e = new HashingEmbedder(128)
  const a = await e.embed('deploy the app to production')
  const b = await e.embed('deploy the app to production')
  const c = await e.embed('completely unrelated banana')
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9)
  assert.ok(cosine(a, b) > 0.99)      // identical
  assert.ok(cosine(a, c) < cosine(a, b)) // related ranks higher
})

test('semantic-ish recall finds related text without exact term', async () => {
  const s = await svc()
  await s.create({ kind: 'semantic', title: 'Deployment', content: 'how to deploy the application to production servers' })
  await s.create({ kind: 'semantic', title: 'Cooking', content: 'how to bake banana bread' })
  const hits = await s.search('deploy application production')
  assert.equal(hits[0]?.record.title, 'Deployment')
})

test('pinned records rank first', async () => {
  const s = await svc()
  const a = await s.create({ kind: 'semantic', title: 'alpha', content: 'x' })
  await s.create({ kind: 'semantic', title: 'beta', content: 'x' })
  await s.update(a.id, { pinned: true })
  const hits = await s.search('x')
  assert.equal(hits[0]?.record.title, 'alpha')
})

test('touch bumps access count', async () => {
  const s = await svc()
  const r = await s.create({ kind: 'semantic', title: 't', content: 'c' })
  await s.touch(r.id); await s.touch(r.id)
  assert.equal((await s.get(r.id))?.accessCount, 2)
})

test('watchFiles pulls changes into memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdxw-'))
  const file = join(dir, 'AGENTS.md')
  await writeFile(file, '# A\n\ninitial\n')
  const s = await svc()
  await importFile(s, file)
  let synced = 0
  const handle = await watchFiles(s, [file], { debounceMs: 50, onSync: () => { synced += 1 } })
  try {
    await writeFile(file, '# A\n\nchanged now\n\n# B\n\nnew one\n')
    await new Promise(r => setTimeout(r, 500))
    const titles = (await s.list({})).map(x => x.title).sort()
    assert.ok(titles.includes('B'))
    assert.ok(synced >= 1)
  } finally {
    handle.close()
  }
})
