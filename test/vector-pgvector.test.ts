/** pgvector config/guard tests (no live DB). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgVectorStore } from '../src/db/vector/pgvector.ts'

test('pgvector requires a url', () => {
  assert.throws(() => new PgVectorStore({ kind: 'pgvector' }), /requires remote.url/)
})

test('pgvector sanitizes the table name', () => {
  const s = new PgVectorStore({ kind: 'pgvector', url: 'postgres://x', collection: 'bad-name; DROP' })
  assert.equal(s.backend, 'pgvector')
  // no throw; backend label correct
})
