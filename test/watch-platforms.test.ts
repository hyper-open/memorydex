/** Platform auto-import (poll) tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'
import { CodebuddyAdapter } from '../src/adapters/codebuddy-workbuddy.ts'
import { watchPlatforms } from '../src/adapters/watch-platforms.ts'

async function svc(): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s, null, { dedupe: true })
}

test('watchPlatforms imports new + changed files on scanNow', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wp-'))
  const memDir = join(home, '.codebuddy/projects/p/memory')
  await mkdir(memDir, { recursive: true })
  const f = join(memDir, 'feedback_a.md')
  await writeFile(f, '---\nname: A\ntype: feedback\n---\nfirst body\n')

  const s = await svc()
  const reg = { list: () => [new CodebuddyAdapter(home)], get: () => undefined }
  const handle = watchPlatforms(s, reg as never, { intervalMs: 999_999 })
  try {
    await handle.scanNow() // baseline -> imports 1
    assert.equal((await s.allRecords()).length, 1)
    // no change -> nothing new
    await handle.scanNow()
    assert.equal((await s.allRecords()).length, 1)
    // change content -> updates (same record via source)
    await writeFile(f, '---\nname: A\ntype: feedback\n---\nSECOND body changed\n')
    const changed = await handle.scanNow()
    assert.equal(changed, 1)
    const recs = await s.allRecords()
    assert.equal(recs.length, 1)
    assert.match(recs[0]!.content, /SECOND body/)
  } finally { handle.close() }
})

test('watchPlatforms picks up a newly added file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wp2-'))
  const memDir = join(home, '.codebuddy/projects/p/memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'feedback_a.md'), '---\nname: A\ntype: feedback\n---\na\n')
  const s = await svc()
  const reg = { list: () => [new CodebuddyAdapter(home)], get: () => undefined }
  const handle = watchPlatforms(s, reg as never, { intervalMs: 999_999 })
  try {
    await handle.scanNow()
    assert.equal((await s.allRecords()).length, 1)
    await writeFile(join(memDir, 'user_b.md'), '---\nname: B\ntype: user\n---\nb\n')
    await handle.scanNow()
    assert.equal((await s.allRecords()).length, 2)
  } finally { handle.close() }
})
