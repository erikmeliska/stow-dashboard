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

import { anyLocation, clientStats, roleStats, filterVirtual, pruneSelection } from './virtual-projects.mjs'

const P = buildVirtualProjects([
  rec('/p/blog', { project_id: 'g:blog', client: 'InteliMail', role: 'primary' }),
  rec('/p/blog-x', { project_id: 'g:blog', client: 'InteliMail ', role: 'experiment' }),
  rec('/p/shop', { project_id: 'g:shop', client: 'acme', role: 'primary' }),
  rec('/p/loose'),
])
const vids = rows => rows.map(r => r.vpId)

test('anyLocation checks every checkout of a project, or the record itself', () => {
  const blog = P.find(r => r.vpId === 'g:blog')
  assert.equal(anyLocation(blog, l => l.directory === '/p/blog-x'), true)
  assert.equal(anyLocation(blog, l => l.directory === '/p/nope'), false)
  assert.equal(anyLocation(rec('/p/z'), l => l.directory === '/p/z'), true)
})

test('clientStats: trimmed names merge, A→Z case-insensitive, Unassigned last', () => {
  assert.deepEqual(clientStats(P), [
    { value: 'acme', label: 'acme', count: 1 },
    { value: 'InteliMail', label: 'InteliMail', count: 1 },
    { value: UNASSIGNED, label: 'Unassigned', count: 1 },
  ])
})

test('clientStats over plain records (directory view) counts records', () => {
  const recs = [rec('/a', { project_id: 'g', client: 'X' }), rec('/b', { project_id: 'g', client: 'X ' })]
  assert.deepEqual(clientStats(recs), [{ value: 'X', label: 'X', count: 2 }])
})

test('roleStats counts projects having at least one checkout in the role', () => {
  assert.deepEqual(roleStats(P), [
    { value: 'primary', label: 'primary', count: 2 },
    { value: 'experiment', label: 'experiment', count: 1 },
  ])
})

test('filterVirtual by client, including Unassigned', () => {
  assert.deepEqual(vids(filterVirtual(P, { clients: ['acme'] })), ['g:shop'])
  assert.deepEqual(vids(filterVirtual(P, { clients: [UNASSIGNED] })), ['dir:/p/loose'])
  assert.deepEqual(vids(filterVirtual(P, { clients: ['acme', UNASSIGNED] })), ['g:shop', 'dir:/p/loose'])
})

test('filterVirtual by role matches when any checkout has it', () => {
  assert.deepEqual(vids(filterVirtual(P, { roles: ['experiment'] })), ['g:blog'])
})

test('filterVirtual multiCopy is 3-state', () => {
  assert.deepEqual(vids(filterVirtual(P, { multiCopy: true })), ['g:blog'])
  assert.deepEqual(vids(filterVirtual(P, { multiCopy: false })), ['g:shop', 'dir:/p/loose'])
  assert.equal(filterVirtual(P, { multiCopy: null }).length, 3)
})

test('pruneSelection drops vanished values and keeps identity when unchanged', () => {
  const stats = clientStats(P)
  const sel = ['acme', 'Gone Ltd']
  assert.deepEqual(pruneSelection(sel, stats), ['acme'])
  const ok = ['acme']
  assert.equal(pruneSelection(ok, stats), ok)
})

import { compareClients, withClientHeaders } from './virtual-projects.mjs'

test('compareClients is case-insensitive and keeps Unassigned last in both directions', () => {
  const names = ['beta', null, 'Alpha']
  assert.deepEqual([...names].sort((a, b) => compareClients(a, b)), ['Alpha', 'beta', null])
  assert.deepEqual([...names].sort((a, b) => compareClients(a, b, true)), ['beta', 'Alpha', null])
})

test('withClientHeaders emits one header per client run with totals over all filtered rows', () => {
  const mk = (vpId, client, costUsd, unpriced = []) => ({ vpId, client, usage: costUsd === undefined ? undefined : { costUsd, unpricedModels: unpriced } })
  const all = [mk('a', 'A', 1), mk('b', 'A', 2), mk('c', 'B', undefined), mk('d', null, 4, ['x'])]
  const page = [all[1], all[2], all[3]].map(original => ({ original })) // 'a' sits on the previous page
  const out = withClientHeaders(page, all)
  assert.deepEqual(out.map(x => x.type), ['header', 'row', 'header', 'row', 'header', 'row'])
  assert.deepEqual(out[0], { type: 'header', client: 'A', count: 2, costUsd: 3, unpriced: false })
  assert.deepEqual(out[2], { type: 'header', client: 'B', count: 1, costUsd: 0, unpriced: false })
  assert.deepEqual(out[4], { type: 'header', client: null, count: 1, costUsd: 4, unpriced: true })
})

import { validateMetaPatch } from './virtual-projects.mjs'

test('validateMetaPatch accepts a client change and a reset to automatic', () => {
  assert.deepEqual(validateMetaPatch({ projectId: 'git:x', client: '  Acme ' }),
    { ok: true, op: { kind: 'client', projectId: 'git:x', client: 'Acme' } })
  assert.deepEqual(validateMetaPatch({ projectId: 'git:x', client: null }),
    { ok: true, op: { kind: 'client', projectId: 'git:x', client: null } })
})

test('validateMetaPatch accepts a role change on an absolute directory', () => {
  assert.deepEqual(validateMetaPatch({ directory: '/p/a', role: 'primary' }),
    { ok: true, op: { kind: 'role', directory: '/p/a', role: 'primary' } })
})

test('validateMetaPatch rejects bad input', () => {
  for (const body of [
    null, {}, [], { projectId: 'x' }, { projectId: 'x', client: '   ' }, { projectId: 'x', client: 'a'.repeat(81) },
    { projectId: 'x', client: 5 }, { directory: 'rel/path', role: 'deploy' }, { directory: '/p/a', role: 'boss' },
    { projectId: 'x', client: 'A', directory: '/p/a', role: 'deploy' },
  ]) {
    assert.equal(validateMetaPatch(body).ok, false, JSON.stringify(body))
  }
})

test('withClientHeaders passes expanded sub-rows through under their parent', () => {
  const all = [{ vpId: 'a', client: 'A' }, { vpId: 'b', client: 'B' }]
  const page = [
    { original: all[0], depth: 0 },
    { original: { directory: '/x', vp: { client: 'Other' } }, depth: 1 },
    { original: all[1], depth: 0 },
  ]
  const out = withClientHeaders(page, all)
  assert.deepEqual(out.map(x => x.type === 'header' ? `h:${x.client}` : x.row.depth), ['h:A', 0, 1, 'h:B', 0])
})

// --- final-review fixes ---
import { createTable, getCoreRowModel, getSortedRowModel, getExpandedRowModel } from '@tanstack/table-core'
import { clientSortingFn, virtualRowId } from './virtual-projects.mjs'

test('a checkout represented by a member row still carries its checkout root (edits target the root)', () => {
  const [p] = buildVirtualProjects([rec('/p/r/b', { project_id: 'g', location: '/p/r' })])
  assert.equal(p.locations[0].directory, '/p/r/b')
  assert.equal(p.locations[0].locationRoot, '/p/r')
})

function sortTable(data, sorting) {
  const table = createTable({
    data,
    columns: [
      { id: 'client', accessorFn: r => r.client, sortingFn: clientSortingFn(sorting.find(s => s.id === 'client')?.desc) },
      { id: 'n', accessorFn: r => r.n },
    ],
    state: { sorting, columnPinning: { left: [], right: [] } },
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  return table.getSortedRowModel().rows.map(r => `${r.original.client}:${r.original.n}`)
}

test('client sort keeps Unassigned last both ways and still applies the secondary sort inside it', () => {
  const data = [
    { client: null, n: 5 }, { client: 'A', n: 1 }, { client: null, n: 9 }, { client: 'b', n: 3 },
    { client: null, n: 1 }, { client: 'A', n: 7 },
  ]
  assert.deepEqual(sortTable(data, [{ id: 'client', desc: false }, { id: 'n', desc: true }]),
    ['A:7', 'A:1', 'b:3', 'null:9', 'null:5', 'null:1'])
  assert.deepEqual(sortTable(data, [{ id: 'client', desc: true }, { id: 'n', desc: false }]),
    ['b:3', 'A:1', 'A:7', 'null:1', 'null:5', 'null:9'])
})

test('virtualRowId keys project rows by project and records by directory, so expansion survives filtering', () => {
  const P2 = buildVirtualProjects([
    rec('/p/a', { project_id: 'g:a', location: '/p/a' }), rec('/p/a2', { project_id: 'g:a', location: '/p/a2' }),
    rec('/p/b', { project_id: 'g:b', location: '/p/b' }), rec('/p/b2', { project_id: 'g:b', location: '/p/b2' }),
  ])
  const expandedOf = data => {
    const table = createTable({
      data,
      columns: [{ id: 'x', accessorFn: r => r.directory }],
      getRowId: virtualRowId,
      getSubRows: r => (r.copyCount > 1 ? r.locations : undefined),
      state: { expanded: { 'g:b': true }, columnPinning: { left: [], right: [] } },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
      getExpandedRowModel: getExpandedRowModel(),
    })
    return table.getExpandedRowModel().rows.map(r => r.id)
  }
  assert.deepEqual(expandedOf(P2), ['g:a', 'g:b', '/p/b', '/p/b2'])
  assert.deepEqual(expandedOf(P2.filter(p => p.vpId === 'g:b')), ['g:b', '/p/b', '/p/b2'])
  assert.equal(virtualRowId(rec('/p/z')), '/p/z')
})

test('validateMetaPatch accepts role null = back to automatic', () => {
  assert.deepEqual(validateMetaPatch({ directory: '/p/a', role: null }),
    { ok: true, op: { kind: 'role', directory: '/p/a', role: null } })
})
