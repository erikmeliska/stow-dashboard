import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMetaPatch } from './route.js'

const spyDeps = () => {
  const calls = []
  return {
    calls,
    setProjectClient: async (a) => { calls.push(['client', a]) },
    setLocationRole: async (a) => { calls.push(['role', a]) },
  }
}

test('client patch calls setProjectClient', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ projectId: 'git:x', client: 'Acme' }, d)
  assert.equal(res.status, 200)
  assert.deepEqual(d.calls, [['client', { projectId: 'git:x', client: 'Acme' }]])
})

test('role patch calls setLocationRole', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ directory: '/p/a', role: 'stale' }, d)
  assert.equal(res.status, 200)
  assert.deepEqual(d.calls, [['role', { directory: '/p/a', role: 'stale' }]])
})

test('invalid body is a 400 and writes nothing', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ directory: '/p/a', role: 'boss' }, d)
  assert.equal(res.status, 400)
  assert.equal(d.calls.length, 0)
})

test('writer failure is a 500 with the message', async () => {
  const res = await handleMetaPatch({ projectId: 'x', client: 'A' }, {
    setProjectClient: async () => { throw new Error('read-only volume') },
    setLocationRole: async () => {},
  })
  assert.equal(res.status, 500)
  assert.match(res.json.error, /read-only volume/)
})
