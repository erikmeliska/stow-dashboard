import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadProjectIndex, resetProjectIndexMemo, resolveClient } from './project-index.mjs'

const REG = {
  clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:x/blog'] }],
  projects: [{ key: 'git:x/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail' }, locations: [{ directory: '/p/blog' }] }],
}
beforeEach(() => resetProjectIndexMemo())

test('builds the index from the register and memoises on mtimes', async () => {
  let loads = 0, mtime = 1
  const opts = { base: '/b', load: async () => { loads++; return REG }, stat: async () => ({ mtimeMs: mtime }), now: () => 0 }
  const a = await loadProjectIndex(opts)
  await loadProjectIndex(opts)
  assert.equal(loads, 1)
  assert.equal(a.index.get('git:x/blog').client_name, 'Intelimail')
  assert.equal(a.projectKeyOf('/p/blog/sub'), 'git:x/blog')
  assert.equal(a.registry, REG)
  mtime = 2
  await loadProjectIndex(opts)
  assert.equal(loads, 2)
})

test('the memo also expires after maxAge (a .stow client edit touches neither mtime)', async () => {
  let loads = 0, t = 0
  const opts = { base: '/b', load: async () => { loads++; return REG }, stat: async () => ({ mtimeMs: 1 }), now: () => t, maxAgeMs: 1000 }
  await loadProjectIndex(opts)
  t = 999; await loadProjectIndex(opts)
  assert.equal(loads, 1)
  t = 1000; await loadProjectIndex(opts)
  assert.equal(loads, 2)
})

test('a missing registry.json still loads (stat failure is just a memo key)', async () => {
  const r = await loadProjectIndex({ base: '/b', load: async () => REG, stat: async () => { throw new Error('ENOENT') } })
  assert.equal(r.index.size, 1)
})

test('fails soft: a throwing register gives an empty index and warns once per message', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  let m = 1
  const opts = { base: '/b', load: async () => { throw new Error('bad registry.json') }, stat: async () => ({ mtimeMs: m }) }
  const r = await loadProjectIndex(opts)
  assert.equal(r.index.size, 0)
  assert.equal(r.registry, null)
  assert.equal(r.projectKeyOf, null)
  m = 2
  await loadProjectIndex(opts)
  assert.equal(warn.mock.callCount(), 1)
})

test('resolveClient by id, by name (case/space-insensitive) and unassigned', () => {
  assert.deepEqual(resolveClient(REG, 'intelimail'), { id: 'intelimail', name: 'Intelimail' })
  assert.deepEqual(resolveClient(REG, ' InteliMail '), { id: 'intelimail', name: 'Intelimail' })
  assert.equal(resolveClient(REG, 'Unassigned'), 'unassigned')
  assert.equal(resolveClient(REG, '__unassigned'), 'unassigned')
  assert.equal(resolveClient(REG, 'nobody'), null)
  assert.equal(resolveClient(null, 'intelimail'), null)
})
