import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMetaPatch, handleMetaRequest } from './route.js'
import { setProjectClient, setLocationRole } from '../../../../lib/project-meta-write.mjs'

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

// --- Full request: guard + register-backed writers (#10 security fix) ---

const request = (body, headers = {}) => new Request('http://localhost:3088/api/projects/meta', {
  method: 'PATCH',
  headers: { host: 'localhost:3088', 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

// The real writers over an in-memory register with one checkout, so a 400 for
// an unknown directory / projectId comes from the code the route really runs.
function registerDeps() {
  const writes = []
  const writerDeps = {
    loadRegistry: async () => ({ projects: [{ key: 'git:x/blog', locations: [{ directory: '/p/blog' }] }] }),
    readStowMeta: async () => ({ meta: null, warnings: [] }),
    writeStowMeta: async (dir, patch) => { writes.push([dir, patch]); return patch },
    exists: async () => true,
  }
  return {
    writes,
    setProjectClient: (a) => setProjectClient(a, writerDeps),
    setLocationRole: (a) => setLocationRole(a, writerDeps),
  }
}

test('request: same-origin JSON on loopback writes (happy path)', async () => {
  const d = registerDeps()
  const role = await handleMetaRequest(request({ directory: '/p/blog', role: 'primary' }, { origin: 'http://localhost:3088' }), d)
  assert.equal(role.status, 200)
  const client = await handleMetaRequest(request({ projectId: 'git:x/blog', client: 'Acme' }), d)
  assert.equal(client.status, 200)
  assert.deepEqual(d.writes, [['/p/blog', { role: 'primary' }], ['/p/blog', { client: 'Acme' }]])
})

test('request: the guard refuses before the body is read', async () => {
  const cases = {
    'cross-origin': { origin: 'https://evil.example' },
    'cross-site fetch': { 'sec-fetch-site': 'cross-site' },
    'non-loopback host (DNS rebinding)': { host: 'evil.example:3088', origin: 'http://evil.example:3088' },
    'text/plain (simple CORS request)': { 'content-type': 'text/plain;charset=UTF-8' },
    'form post': { 'content-type': 'application/x-www-form-urlencoded' },
  }
  for (const [name, headers] of Object.entries(cases)) {
    const d = registerDeps()
    const req = request({ directory: '/p/blog', role: 'stale' }, headers)
    const res = await handleMetaRequest(req, d)
    assert.equal(res.status, 403, name)
    assert.equal(req.bodyUsed, false, name)
    assert.equal(d.writes.length, 0, name)
  }
})

test('request: unknown directory or projectId is a 400 and writes nothing', async () => {
  const d = registerDeps()
  for (const body of [
    { directory: '/tmp/evil', role: 'stale' },
    { directory: '/p/blog/sub', role: 'primary' },
    { directory: '/p/blog/../other', role: 'stale' },
    { projectId: 'git:nope', client: 'Acme' },
  ]) {
    const res = await handleMetaRequest(request(body), d)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal(d.writes.length, 0)
})
