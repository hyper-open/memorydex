/** Qdrant store tests using a stubbed fetch (no live server needed). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QdrantStore } from '../src/db/vector/qdrant.ts'

/** Install a fake in-memory Qdrant over global fetch; returns restore fn. */
function fakeQdrant(): { points: Map<string, { id: string; vector: number[]; payload: { record: unknown } }>; restore: () => void } {
  const points = new Map<string, { id: string; vector: number[]; payload: { record: unknown } }>()
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); const method = init?.method ?? 'GET'; const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
    if (u.endsWith('/collections')) return json({ result: { collections: [] } })
    if (/\/collections\/[^/]+$/.test(u) && method === 'GET') return json({ result: {} })
    if (/\/collections\/[^/]+$/.test(u) && method === 'PUT') return json({ result: true })
    if (u.includes('/points/scroll')) return json({ result: { points: [...points.values()], next_page_offset: null } })
    if (u.includes('/points/delete')) { for (const id of body.points) points.delete(id); return json({ result: {} }) }
    if (u.includes('/points/search')) return json({ result: [{ score: 0.9, payload: [...points.values()][0]?.payload }] })
    if (u.includes('/points') && (method === 'PUT')) { for (const p of body.points) points.set(p.id, p); return json({ result: {} }) }
    if (u.endsWith('/points') && method === 'POST') { const ids = (body.ids ?? []) as string[]; return json({ result: ids.map(id => points.get(id)).filter(Boolean) }) }
    return json({ result: {} })
  }) as typeof fetch
  return { points, restore: () => { globalThis.fetch = real } }
}

test('QdrantStore put/get/all/delete round-trip', async () => {
  const fake = fakeQdrant()
  try {
    const s = new QdrantStore({ kind: 'qdrant', url: 'http://x', collection: 'c', dim: 3 })
    await s.init()
    await s.put({ id: 'm1', kind: 'semantic', title: 'A', content: 'a', tags: [], importance: 0.5, origin: 'manual', metadata: {}, createdAt: 1, updatedAt: 1, embedding: [0.1, 0.2, 0.3] })
    assert.equal(fake.points.size, 1)
    const all = await s.all()
    assert.equal(all.length, 1)
    assert.equal(all[0]?.title, 'A')
    const got = await s.get('m1')
    assert.equal(got?.title, 'A')
    const del = await s.delete('m1')
    assert.equal(del, true)
  } finally { fake.restore() }
})
