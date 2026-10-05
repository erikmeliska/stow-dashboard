import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReorgReport, fingerprintOf } from './reorg.mjs'

const NOW = Date.parse('2026-10-05T00:00:00Z')
const iso = (monthsAgo) => new Date(NOW - monthsAgo * 30.44 * 864e5).toISOString()
const row = (dir, o = {}) => ({
  directory: dir, project_name: dir.split('/').pop(), project_id: o.pid ?? 'p1',
  checkout: { root: dir, subpath: '', git: o.git ?? true },
  last_modified: iso(o.age ?? 0),
  git_info: { uncommitted_changes: o.dirty ?? 0, ahead: o.ahead ?? 0, behind: o.behind ?? 0, last_total_commit_date: iso(o.age ?? 0), remotes: [] },
  ai_analysis: o.ai ?? null, ai_derived: o.derived ?? null, scc: { total_code: o.code ?? 100 },
  content_size_bytes: o.size ?? 1000, file_types: o.types ?? { js: 3 },
})
// The merged #8 shape: key, client {id,name,source}, primary dir, locations with role + role_source.
const project = (key, locations, o = {}) => ({
  key, name: o.name ?? key, client: o.client ? { id: o.client.toLowerCase().replace(/[^a-z0-9]/g, ''), name: o.client, source: o.source } : null,
  primary: locations[0]?.directory ?? null, locations,
})
const loc = (directory, role = 'primary', role_source = 'derived') => ({ directory, role, role_source })
const B = '/P'
const all = () => true
const run = (o) => buildReorgReport({ baseDir: B, exists: all, ...o })
const kinds = (r) => r.suggestions.map(s => `${s.kind}:${s.location ?? ''}`)

test('client project outside _Bizz/<Client> is suggested with confirm-client + move', () => {
  const reg = { projects: [project('p1', [loc('/P/_Work/blog')], { client: 'InteliMail', source: 'owner' })] }
  const r = run({ register: reg, rows: [row('/P/_Work/blog')], exists: (p) => p === '/P/_Work/blog' })
  const s = r.suggestions[0]
  assert.equal(s.kind, 'client-placement')
  assert.equal(s.projectId, 'p1')
  assert.deepEqual(s.action, { type: 'confirm-client', client: 'InteliMail', directory: '/P/_Work/blog' })
  assert.deepEqual(s.move, { from: '/P/_Work/blog', to: '/P/_Bizz/InteliMail/blog' })
  assert.equal(r.summary['client-placement'], 1)
})

test('client placement: folded match, alias, manual and low-confidence AI skipped, existing target → no move', () => {
  const ok = { projects: [project('p1', [loc('/P/_Bizz/inteli-mail/blog')], { client: 'InteliMail', source: 'path' })] }
  assert.equal(run({ register: ok, rows: [row('/P/_Bizz/inteli-mail/blog')] }).suggestions.length, 0)
  const alias = { projects: [project('p1', [loc('/P/_Bizz/OldBrand/blog')], { client: 'InteliMail', source: 'ai' })] }
  const config = { clients: [{ name: 'InteliMail', aliases: ['OldBrand'] }] }
  assert.equal(run({ register: alias, rows: [row('/P/_Bizz/OldBrand/blog')], config }).suggestions.length, 0)
  const manual = { projects: [project('p1', [loc('/P/x/blog')], { client: 'InteliMail', source: 'manual' })] }
  assert.equal(run({ register: manual, rows: [row('/P/x/blog')] }).suggestions.length, 0)
  const low = { projects: [project('p1', [loc('/P/x/blog')], { client: 'Acme', source: 'ai' })] }
  assert.equal(run({ register: low, rows: [row('/P/x/blog', { ai: { confidence: 'low', client: 'Acme' } })] }).suggestions.length, 0)
  const taken = { projects: [project('p1', [loc('/P/x/blog')], { client: 'Acme', source: 'ai' })] }
  const r = run({ register: taken, rows: [row('/P/x/blog')], exists: (p) => p !== '/nope' })
  assert.equal(r.suggestions[0].move, null)
})

test('client placement reuses an existing _Bizz folder spelling from the ledger', () => {
  const reg = { projects: [project('p1', [loc('/P/x/blog')], { client: 'InteliMail', source: 'owner' }), project('p2', [loc('/Q/_Bizz/intelimail/site')], { client: 'InteliMail', source: 'path' })] }
  const rows = [row('/P/x/blog'), row('/Q/_Bizz/intelimail/site', { pid: 'p2' })]
  const r = run({ register: reg, rows, exists: (p) => p !== '/Q/_Bizz/intelimail/blog' })
  assert.deepEqual(r.suggestions.map(s => s.move), [{ from: '/P/x/blog', to: '/Q/_Bizz/intelimail/blog' }])
})

test('stale copy: old clean non-primary qualifies; dirty, ahead, deploy, manual role, recent do not', () => {
  const reg = { projects: [project('p1', [
    loc('/P/blog'), loc('/P/blog-old', 'stale'), loc('/P/blog-dirty', 'stale'),
    loc('/P/blog-ahead', 'stale'), loc('/P/blog-deploy', 'deploy'), loc('/P/blog-kept', 'experiment', 'manual'),
    loc('/P/blog-recent', 'experiment'),
  ])] }
  const rows = [row('/P/blog'), row('/P/blog-old', { age: 9 }), row('/P/blog-dirty', { age: 9, dirty: 2 }),
    row('/P/blog-ahead', { age: 9, ahead: 1 }), row('/P/blog-deploy', { age: 9 }), row('/P/blog-kept', { age: 9 }), row('/P/blog-recent', { age: 2 })]
  const r = run({ register: reg, rows })
  assert.deepEqual(kinds(r), ['stale-copy:/P/blog-old'])
  assert.deepEqual(r.suggestions[0].action, { type: 'set-role', directory: '/P/blog-old', role: 'stale' })
  assert.equal(r.suggestions[0].move, null)
})

test('stale copy without git needs an identical size and type mix', () => {
  const reg = { projects: [project('p1', [loc('/P/a'), loc('/P/a-copy', 'stale'), loc('/P/a-diff', 'stale')])] }
  const rows = [row('/P/a', { git: false }), row('/P/a-copy', { git: false, age: 9 }), row('/P/a-diff', { git: false, age: 9, size: 5 })]
  assert.deepEqual(kinds(run({ register: reg, rows })), ['stale-copy:/P/a-copy'])
})

test('stale copy: a member row (sub-path) does not stand in for the checkout root row', () => {
  const reg = { projects: [project('p1', [loc('/P/a'), loc('/P/a-old', 'stale')])] }
  const member = { ...row('/P/a-old/pkg', { age: 0 }), checkout: { root: '/P/a-old', subpath: 'pkg', git: true } }
  const rows = [row('/P/a'), member, row('/P/a-old', { age: 9 })]
  assert.deepEqual(kinds(run({ register: reg, rows })), ['stale-copy:/P/a-old'])
})

test('abandoned: experiment + dead, not when running, not production, not when archived', () => {
  const reg = { projects: [project('p1', [loc('/P/_AI/toy')])] }
  const rows = [row('/P/_AI/toy', { ai: { maturity: 'prototype' }, derived: { status: 'dead' } })]
  const r = run({ register: reg, rows, exists: (p) => p === '/P/_AI/toy' })
  assert.equal(r.suggestions[0].kind, 'abandoned')
  assert.deepEqual(r.suggestions[0].action, { type: 'archive-project', directories: ['/P/_AI/toy'] })
  assert.deepEqual(r.suggestions[0].move, { from: '/P/_AI/toy', to: '/P/_Archive/toy' })
  assert.equal(run({ register: reg, rows, runningDirs: ['/P/_AI/toy/src'] }).suggestions.length, 0)
  const prod = [row('/P/_AI/toy', { ai: { maturity: 'production' }, derived: { status: 'dead' } })]
  assert.equal(run({ register: reg, rows: prod }).suggestions.length, 0)
  const archived = { projects: [project('p1', [loc('/P/_AI/toy', 'stale', 'manual')])] }
  assert.equal(run({ register: archived, rows }).suggestions.length, 0)
  const manualExp = { projects: [project('p1', [loc('/P/_AI/toy', 'experiment', 'manual')])] }
  assert.equal(run({ register: manualExp, rows: [row('/P/_AI/toy', { derived: { status: 'archive-candidate' } })] }).suggestions[0].kind, 'abandoned')
})

test('orphan: every location gone from disk', () => {
  const reg = { projects: [project('p9', [loc('/P/gone'), loc('/P/gone2', 'stale', 'manual')], { client: 'Acme', source: 'manual' })] }
  const r = run({ register: reg, rows: [row('/P/gone', { pid: 'p9' })], exists: () => false })
  const s = r.suggestions[0]
  assert.equal(r.suggestions.length, 1)
  assert.equal(s.kind, 'orphan')
  assert.deepEqual(s.action, { type: 'remove-project', directories: ['/P/gone', '/P/gone2'] })
  assert.equal(s.evidence.manualClient, true)
  assert.equal(s.evidence.manualRoles, true)
  // one location still on disk → not an orphan
  assert.equal(run({ register: reg, rows: [], exists: (p) => p === '/P/gone2' }).suggestions.some(x => x.kind === 'orphan'), false)
})

test('dismissal hides a suggestion until its evidence changes', () => {
  const reg = { projects: [project('p1', [loc('/P/blog'), loc('/P/blog-old', 'stale')])] }
  const rows = [row('/P/blog'), row('/P/blog-old', { age: 9 })]
  const first = run({ register: reg, rows }).suggestions[0]
  const dismissed = { [first.id]: { at: 'x', fingerprint: first.fingerprint } }
  const again = run({ register: reg, rows, dismissed })
  assert.equal(again.suggestions.length, 0)
  assert.equal(again.dismissedCount, 1)
  rows[1].git_info.behind = 7
  assert.equal(run({ register: reg, rows, dismissed }).suggestions.length, 1)
})

test('ids are stable and fingerprints ignore key order', () => {
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }))
  const reg = { projects: [project('p1', [loc('/P/blog'), loc('/P/blog-old', 'stale')])] }
  const rows = [row('/P/blog'), row('/P/blog-old', { age: 9 })]
  assert.equal(run({ register: reg, rows }).suggestions[0].id, 'stale-copy:p1:/P/blog-old')
})

test('ordering: kinds in order, client placement by code size desc, unassigned counted', () => {
  const reg = { projects: [
    project('small', [loc('/P/s')], { client: 'Acme', source: 'owner' }),
    project('big', [loc('/P/b')], { client: 'Acme', source: 'owner' }),
    project('mid', [loc('/P/m')], { client: 'Acme', source: 'owner' }),
    project('toy', [loc('/P/t')]),
  ] }
  const rows = [row('/P/s', { pid: 'small', code: 10 }), row('/P/b', { pid: 'big', code: 9000 }), row('/P/m', { pid: 'mid', code: 500 }),
    row('/P/t', { pid: 'toy', ai: { maturity: 'idea' }, derived: { status: 'dead' } })]
  const r = run({ register: reg, rows })
  assert.deepEqual(r.suggestions.map(s => s.projectId), ['big', 'mid', 'small', 'toy'])
  assert.equal(r.summary.unassigned, 1)
  assert.equal(r.summary.abandoned, 1)
})

test('abandoned: already under an _Archive(s) folder is skipped; an existing _Archives folder is reused', () => {
  const dead = { ai: { maturity: 'idea' }, derived: { status: 'dead' } }
  const inArchive = { projects: [project('p1', [loc('/P/_Archives/old/toy')])] }
  assert.equal(run({ register: inArchive, rows: [row('/P/_Archives/old/toy', dead)] }).suggestions.length, 0)
  const reg = { projects: [project('p1', [loc('/P/_AI/toy')])] }
  const r = run({ register: reg, rows: [row('/P/_AI/toy', dead)], exists: (p) => p === '/P/_AI/toy' || p === '/P/_Archives' })
  assert.deepEqual(r.suggestions[0].move, { from: '/P/_AI/toy', to: '/P/_Archives/toy' })
})
