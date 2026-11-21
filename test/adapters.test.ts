/** Platform adapter parsing tests (synthetic temp dirs). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { CodebuddyAdapter, WorkbuddyAdapter } from '../src/adapters/codebuddy-workbuddy.ts'
import { importPlatform } from '../src/adapters/index.ts'
import { MarkdownAdapter } from '../src/adapters/md-adapter.ts'

async function svc(): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s)
}

test('codebuddy adapter reads frontmatter name/type', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cb-'))
  const memDir = join(home, '.codebuddy/projects/projA/memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'feedback_x.md'), '---\nname: 写作风格\ndescription: 用人话\ntype: feedback\n---\n正文内容\n')
  const a = new CodebuddyAdapter(home)
  const files = await a.discover()
  assert.equal(files.length, 1)
  const secs = await a.read(files[0]!)
  assert.equal(secs[0]?.title, '写作风格')
  assert.equal(secs[0]?.kind, 'procedural')
  assert.match(secs[0]?.content ?? '', /用人话/)
})

test('workbuddy adapter extracts memoryBlock from RAW_JSON', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-'))
  const memDir = join(home, '.workbuddy/memory')
  await mkdir(memDir, { recursive: true })
  const json = JSON.stringify({ uid: 'u1', memoryBlock: '**工作背景** 用户是工程师', version: 3 })
  await writeFile(join(memDir, 'u1_memory.md'), `# User Memory Profile\n\n## Memory Block\n\n<!-- RAW_JSON_START\n${json}\nRAW_JSON_END -->\n`)
  const a = new WorkbuddyAdapter(home)
  const files = await a.discover()
  const memFile = files.find(f => f.endsWith('_memory.md'))!
  const secs = await a.read(memFile)
  assert.match(secs[0]?.content ?? '', /用户是工程师/)
})

test('importPlatform tags records with platform + is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'md2-'))
  await writeFile(join(home, 'CLAUDE.md'), '# Rules\n\nbe nice\n')
  const a = new MarkdownAdapter('claude', ['CLAUDE.md'], [home])
  const s = await svc()
  const r1 = await importPlatform(s, a)
  assert.equal(r1[0]?.imported, 1)
  const recs = await s.allRecords()
  assert.equal(recs[0]?.metadata.platform, 'claude')
  // re-import -> unchanged
  const r2 = await importPlatform(s, a)
  assert.equal(r2[0]?.unchanged, 1)
  assert.equal((await s.allRecords()).length, 1)
})
