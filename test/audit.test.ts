/** Write-audit tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryService } from '../src/core/memory.ts'
import { SqliteStore } from '../src/db/sqlite.ts'

async function svc(dedupe = true): Promise<MemoryService> {
  const s = new SqliteStore(':memory:'); await s.init(); return new MemoryService(s, null, { dedupe })
}

test('create/update/delete produce audit events', async () => {
  const s = await svc()
  const a = await s.create({ kind: 'semantic', title: 'A', content: 'x' })
  await s.update(a.id, { content: 'y' })
  await s.delete(a.id)
  const ev = await s.audit_events()
  const actions = ev.map(e => e.action)
  assert.ok(actions.includes('create'))
  assert.ok(actions.includes('update'))
  assert.ok(actions.includes('delete'))
})

test('merge records an audit event', async () => {
  const s = await svc()
  await s.create({ kind: 'semantic', title: 'Dup', content: 'same' })
  await s.create({ kind: 'semantic', title: 'Dup', content: 'same' })
  const ev = await s.audit_events()
  assert.ok(ev.some(e => e.action === 'merge'))
})

test('audit newest-first and limit works', async () => {
  const s = await svc()
  for (let i = 0; i < 5; i++) await s.create({ kind: 'semantic', title: `t${i}`, content: `c${i}` })
  const ev = await s.audit_events(3)
  assert.equal(ev.length, 3)
  // newest first
  assert.ok(ev[0]!.time >= ev[1]!.time)
})
