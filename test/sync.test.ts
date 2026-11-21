/** Import + two-way sync behavior over an in-memory store. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { importFile } from '../src/import/markdown.ts'
import { pullFile, pushFile } from '../src/sync/files.ts'

async function svc(): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s)
}

test('import infers procedural vs semantic by heading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdx-'))
  const file = join(dir, 'AGENTS.md')
  await writeFile(file, '# Proj\n\nintro\n\n## Install command\n\nrun npm i\n\n## Facts\n\nthe sky is blue\n')
  const s = await svc()
  const res = await importFile(s, file)
  assert.equal(res.imported, 3)
  const byTitle = Object.fromEntries(res.records.map(r => [r.title, r.kind]))
  assert.equal(byTitle['Install command'], 'procedural')
  assert.equal(byTitle['Facts'], 'semantic')
})

test('pull updates changed sections and adds new ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdx-'))
  const file = join(dir, 'AGENTS.md')
  await writeFile(file, '# A\n\nv1\n')
  const s = await svc()
  await importFile(s, file)
  await writeFile(file, '# A\n\nv2 changed\n\n# B\n\nnew section\n')
  const r = await pullFile(s, file)
  assert.equal(r.added, 1)     // B
  assert.equal(r.updated, 1)   // A
  const titles = (await s.list({})).map(x => x.title).sort()
  assert.deepEqual(titles, ['A', 'B'])
})

test('push rewrites file from memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdx-'))
  const file = join(dir, 'AGENTS.md')
  await writeFile(file, '# OnlyOne\n\nbody\n')
  const s = await svc()
  await importFile(s, file)
  // add a record directly then push
  await s.create({ kind: 'semantic', title: 'Added InMemory', content: 'pushed', origin: 'manual', source: `${file}#added` })
  await pushFile(s, file)
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(file, 'utf8')
  assert.ok(text.includes('Added InMemory'))
})
