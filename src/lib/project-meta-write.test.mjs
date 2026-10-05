import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocationRole, setProjectClient } from './project-meta-write.mjs'

// In-memory .stow metas + a register with one two-checkout project.
function fakeDeps({ metas = {}, missing = [] } = {}) {
  const store = new Map(Object.entries(metas))
  const writes = []
  return {
    writes,
    store,
    loadRegistry: async () => ({
      projects: [{
        key: 'git:x/blog', primary: '/p/blog',
        locations: [{ directory: '/p/blog' }, { directory: '/p/blog-test' }, { directory: '/p/gone' }],
      }],
    }),
    readStowMeta: async dir => ({ meta: store.get(dir) || null, warnings: [] }),
    writeStowMeta: async (dir, patch) => {
      writes.push([dir, patch])
      const next = { ...(store.get(dir) || { id: 'p_new' }) }
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v }
      store.set(dir, next)
      return next
    },
    exists: async dir => !missing.includes(dir) && dir !== '/p/gone',
  }
}

test('setLocationRole writes the role to the checkout root', async () => {
  const d = fakeDeps()
  await setLocationRole({ directory: '/p/blog-test', role: 'stale' }, d)
  assert.deepEqual(d.writes, [['/p/blog-test', { role: 'stale' }]])
})

test('setLocationRole primary demotes other manual primaries first', async () => {
  const d = fakeDeps({ metas: { '/p/blog': { id: 'a', role: 'primary' } } })
  await setLocationRole({ directory: '/p/blog-test', role: 'primary' }, d)
  assert.deepEqual(d.writes, [['/p/blog', { role: null }], ['/p/blog-test', { role: 'primary' }]])
})

test('setLocationRole refuses an unknown or vanished location', async () => {
  await assert.rejects(setLocationRole({ directory: '/p/nope', role: 'stale' }, fakeDeps()), /not a location/)
  const d = fakeDeps()
  await assert.rejects(setLocationRole({ directory: '/p/gone', role: 'stale' }, d), /no longer exists/)
  assert.equal(d.writes.length, 0)
})

test('setProjectClient writes the client to every existing checkout', async () => {
  const d = fakeDeps()
  await setProjectClient({ projectId: 'git:x/blog', client: 'Acme' }, d)
  assert.deepEqual(d.writes, [['/p/blog', { client: 'Acme' }], ['/p/blog-test', { client: 'Acme' }]])
})

test('setProjectClient null clears manual clients without creating files', async () => {
  const d = fakeDeps({ metas: { '/p/blog-test': { id: 'b', client: 'Old' } } })
  await setProjectClient({ projectId: 'git:x/blog', client: null }, d)
  assert.deepEqual(d.writes, [['/p/blog-test', { client: null }]])
})

test('setProjectClient refuses an unknown project', async () => {
  await assert.rejects(setProjectClient({ projectId: 'git:nope', client: 'A' }, fakeDeps()), /unknown project/)
})

test('default writer: real .stow files, primary handover and automatic client', async () => {
  const { mkdtemp, mkdir, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const root = await mkdtemp(path.join(tmpdir(), 'stow-meta-write-'))
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b'), gone = path.join(root, 'gone')
    await mkdir(a); await mkdir(b)
    const loadRegistry = async () => ({ projects: [{ key: 'stow:p', locations: [{ directory: a }, { directory: b }, { directory: gone }] }] })
    const read = async dir => JSON.parse(await readFile(path.join(dir, '.stow', 'project.json'), 'utf8'))

    await setLocationRole({ directory: a, role: 'primary' }, { loadRegistry })
    await setLocationRole({ directory: b, role: 'primary' }, { loadRegistry })
    assert.equal((await read(a)).role, undefined)
    assert.equal((await read(b)).role, 'primary')

    await setProjectClient({ projectId: 'stow:p', client: 'Acme' }, { loadRegistry })
    assert.equal((await read(a)).client, 'Acme')
    await setProjectClient({ projectId: 'stow:p', client: null }, { loadRegistry })
    assert.equal((await read(b)).client, undefined)
    await assert.rejects(readFile(path.join(gone, '.stow', 'project.json')), /ENOENT/) // never recreated
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
