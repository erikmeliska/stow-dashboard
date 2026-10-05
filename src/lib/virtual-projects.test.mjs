import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, UNASSIGNED, annotateRecords, locationMeta, pickPrimary, sumUsage, buildVirtualProjects } from './virtual-projects.mjs'

const rec = (directory, vp, extra = {}) => ({ directory, project_name: directory.split('/').pop(), ...(vp ? { vp } : {}), ...extra })

test('constants', () => {
  assert.deepEqual(ROLES, ['primary', 'deploy', 'experiment', 'stale'])
  assert.equal(UNASSIGNED, '__unassigned__')
})

test('annotateRecords stamps project, client, location and role from the register', () => {
  const records = [
    { directory: '/p/blog', checkout: { root: '/p/blog' } },
    { directory: '/p/blog/packages/a', checkout: { root: '/p/blog' } },
    { directory: '/p/blog-test', checkout: { root: '/p/blog-test' } },
    { directory: '/p/new' },
  ]
  const registry = {
    projects: [{
      key: 'git:gitlab.com/x/blog', name: 'blog', client: { id: 'intelimail', name: 'InteliMail', source: 'owner' },
      primary: '/p/blog',
      locations: [
        { directory: '/p/blog', role: 'primary', role_source: 'derived', members: 2 },
        { directory: '/p/blog-test', role: 'experiment', role_source: 'manual', members: 1 },
      ],
    }],
  }
  const [a, b, c, d] = annotateRecords(records, registry)
  assert.deepEqual(a.vp, {
    project_id: 'git:gitlab.com/x/blog', client: 'InteliMail', client_source: 'owner',
    location: '/p/blog', role: 'primary', role_source: 'derived', primary: true, members: 2,
  })
  assert.equal(b.vp.location, '/p/blog')
  assert.equal(b.vp.role, 'primary')
  assert.equal(c.vp.role, 'experiment')
  assert.equal(c.vp.primary, false)
  assert.equal(d.vp, undefined) // not in the register (scanned after it was built)
  assert.equal(records[0].vp, undefined) // input not mutated
})

test('annotateRecords tolerates a missing register', () => {
  const records = [{ directory: '/p/a' }]
  assert.deepEqual(annotateRecords(records, null), records)
})

test('locationMeta falls back to the #9 project_id, then a per-directory project', () => {
  assert.deepEqual(locationMeta(rec('/p/a')), { projectId: 'dir:/p/a', location: '/p/a', client: null, clientSource: null, role: null, primary: false })
  assert.equal(locationMeta(rec('/p/a/sub', null, { project_id: 'git:x', checkout: { root: '/p/a' } })).projectId, 'git:x')
  assert.equal(locationMeta(rec('/p/a/sub', null, { checkout: { root: '/p/a' } })).location, '/p/a')
})

test('locationMeta trims the client, drops blank clients and unknown roles', () => {
  assert.deepEqual(
    locationMeta(rec('/p/a', { project_id: 'git:x', client: '  InteliMail ', client_source: 'manual', role: 'deploy', location: '/p/a' })),
    { projectId: 'git:x', location: '/p/a', client: 'InteliMail', clientSource: 'manual', role: 'deploy', primary: false },
  )
  assert.deepEqual(
    locationMeta(rec('/p/a', { project_id: 'git:x', client: '   ', client_source: 'ai', role: 'weird' })),
    { projectId: 'git:x', location: '/p/a', client: null, clientSource: null, role: null, primary: false },
  )
})

test('pickPrimary prefers the register primary, then role primary, else the most recently modified', () => {
  const a = rec('/p/a', { project_id: 'g', role: 'primary' }, { last_modified: '2026-10-01T00:00:00Z' })
  const b = rec('/p/b', { project_id: 'g', role: 'primary', primary: true }, { last_modified: '2026-01-01T00:00:00Z' })
  assert.deepEqual(pickPrimary([a, b]), { primary: b, conflict: true })
  const d = rec('/p/d', { project_id: 'g', role: 'deploy' }, { last_modified: '2026-10-01T00:00:00Z' })
  const e = rec('/p/e', { project_id: 'g', role: 'primary' }, { last_modified: '2026-01-01T00:00:00Z' })
  assert.deepEqual(pickPrimary([d, e]), { primary: e, conflict: false })
  const c = rec('/p/c', { project_id: 'g' }, { last_modified: '2026-10-02T00:00:00Z' })
  assert.deepEqual(pickPrimary([d, c]), { primary: c, conflict: false })
})

test('pickPrimary with two primaries and no register flag picks the alphabetically first and flags a conflict', () => {
  const z = rec('/p/z', { project_id: 'g', role: 'primary' })
  const m = rec('/p/m', { project_id: 'g', role: 'primary' })
  assert.deepEqual(pickPrimary([z, m]), { primary: m, conflict: true })
})

test('sumUsage adds numbers and tokens, keeps unpriced models, returns undefined when nothing is there', () => {
  assert.equal(sumUsage([undefined, undefined]), undefined)
  const s = sumUsage([
    { costUsd: 1.5, sessions: 2, activeMinutes: 10, tokens: { input: 100, output: 5 }, unpricedModels: [] },
    undefined,
    { costUsd: 0.5, sessions: 1, activeMinutes: 5, tokens: { input: 50, codexInput: 7 }, unpricedModels: ['mystery-1'] },
  ])
  assert.deepEqual(s, {
    costUsd: 2, sessions: 3, activeMinutes: 15,
    tokens: { input: 150, output: 5, codexInput: 7 },
    unpricedModels: ['mystery-1'],
  })
})

test('buildVirtualProjects merges checkouts by project id and aggregates over every member', () => {
  const u = costUsd => ({ costUsd, sessions: 1, activeMinutes: 1, tokens: {}, unpricedModels: [] })
  const rows = buildVirtualProjects([
    rec('/p/blog', { project_id: 'git:blog', client: 'InteliMail', client_source: 'owner', role: 'primary', primary: true, location: '/p/blog' },
      { last_modified: '2026-09-01T00:00:00Z', usage: u(1) }),
    rec('/p/blog/packages/a', { project_id: 'git:blog', client: 'InteliMail', client_source: 'owner', role: 'primary', primary: true, location: '/p/blog' },
      { last_modified: '2026-10-03T00:00:00Z', usage: u(4) }),
    rec('/p/blog-test', { project_id: 'git:blog', client: 'InteliMail', client_source: 'owner', role: 'experiment', location: '/p/blog-test' },
      { last_modified: '2026-10-01T00:00:00Z', usage: u(2) }),
    rec('/p/solo'),
  ])
  assert.equal(rows.length, 2)
  const blog = rows.find(r => r.vpId === 'git:blog')
  assert.equal(blog.directory, '/p/blog')          // primary checkout's root row
  assert.equal(blog.client, 'InteliMail')
  assert.equal(blog.clientSource, 'owner')
  assert.equal(blog.copyCount, 2)                  // checkouts, not member rows
  assert.equal(blog.recordCount, 3)
  assert.deepEqual(blog.roles, ['experiment', 'primary'])
  assert.equal(blog.last_modified, '2026-10-03T00:00:00Z') // newest of any member
  assert.equal(blog.usage.costUsd, 7)
  assert.deepEqual(blog.locations.map(l => l.directory), ['/p/blog', '/p/blog-test']) // primary first, then by path
  assert.deepEqual(blog.locations.map(l => l.locationMembers), [2, 1])
  const solo = rows.find(r => r.vpId === 'dir:/p/solo')
  assert.equal(solo.client, null)
  assert.equal(solo.copyCount, 1)
  assert.equal(solo.usage, undefined)
})

test('buildVirtualProjects: a weak-only checkout root is represented by its shallowest member', () => {
  const [p] = buildVirtualProjects([
    rec('/p/r/a/deep', { project_id: 'g', location: '/p/r' }),
    rec('/p/r/b', { project_id: 'g', location: '/p/r' }),
  ])
  assert.equal(p.copyCount, 1)
  assert.equal(p.directory, '/p/r/b')
})

test('buildVirtualProjects keeps the unpriced marker when one checkout has unpriced usage', () => {
  const [p] = buildVirtualProjects([
    rec('/p/a', { project_id: 'g', location: '/p/a' }, { usage: { costUsd: 1, unpricedModels: [] } }),
    rec('/p/b', { project_id: 'g', location: '/p/b' }, { usage: { costUsd: 0, unpricedModels: ['m'] } }),
  ])
  assert.deepEqual(p.usage.unpricedModels, ['m'])
})

test('buildVirtualProjects takes the client from the primary when locations disagree', () => {
  const [p] = buildVirtualProjects([
    rec('/p/a', { project_id: 'g', client: 'A', role: 'deploy', location: '/p/a' }),
    rec('/p/b', { project_id: 'g', client: 'B', role: 'primary', location: '/p/b' }),
  ])
  assert.equal(p.client, 'B')
})
