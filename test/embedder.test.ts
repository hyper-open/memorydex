/** Embedder resolution + degradation tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEmbedder } from '../src/embedder-config.ts'

test('enabled=false -> off (no embedder)', async () => {
  const r = await resolveEmbedder({ enabled: false })
  assert.equal(r.mode, 'off')
  assert.equal(r.embedder, undefined)
})

test('kind=hashing -> hashing embedder', async () => {
  const r = await resolveEmbedder({ kind: 'hashing' })
  assert.equal(r.mode, 'hashing')
  const v = await r.embedder!.embed('hello')
  assert.equal(v.length, 256)
})

test('kind=http without url -> falls back to hashing', async () => {
  const r = await resolveEmbedder({ kind: 'http' })
  assert.equal(r.mode, 'hashing')
  assert.match(r.note ?? '', /no embedding url/)
})

test('unreachable http url -> degrades to hashing', async () => {
  const r = await resolveEmbedder({ kind: 'http', url: 'http://127.0.0.1:1/v1/embeddings', timeoutMs: 500 })
  assert.equal(r.mode, 'hashing')
  assert.match(r.note ?? '', /degraded/)
})

test('unreachable http + fallbackToHashing=false -> off', async () => {
  const r = await resolveEmbedder({ kind: 'http', url: 'http://127.0.0.1:1/v1/embeddings', timeoutMs: 500, fallbackToHashing: false })
  assert.equal(r.mode, 'off')
})
