import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry, deriveRole } from './registry.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRegistryConfig, readRegistryConfig, loadRegistry } from './registry.mjs'

const NOW = Date.parse('2026-10-05T00:00:00Z')
const day = n => new Date(NOW - n * 86400000).toISOString()
const rec = (id, directory, extra = {}) => ({ id, directory, project_name: directory.split('/').pop(), last_code_modified: day(1), ...extra })
const remote = url => ({ git_info: { remotes: [url] } })

test('deriveRole: name tokens then age', () => {
  assert.equal(deriveRole('/p/krestan-next-prod-old', NOW - 86400000, NOW), 'stale')
  assert.equal(deriveRole('/p/blog-prod', NOW - 86400000, NOW), 'deploy')
  assert.equal(deriveRole('/p/blog-test', NOW - 200 * 86400000, NOW), 'stale')
  assert.equal(deriveRole('/p/blog-test', NOW - 86400000, NOW), 'experiment')
  assert.equal(deriveRole('/p/blog-test', null, NOW), 'stale')
})

test('four checkouts of one repo become one project with roles and an owner client', () => {
  const records = [
    rec('a', '/P/_Bizz/Intelimail/blog', { ...remote('git@gitlab.com:intelimail/blog.git'), last_code_modified: day(2) }),
    rec('b', '/P/blog-huha', { ...remote('https://gitlab.com/intelimail/blog.git'), last_code_modified: day(1) }),
    rec('c', '/P/blog-test', { ...remote('git@gitlab.com:Intelimail/blog'), last_code_modified: day(400) }),
    rec('d', '/P/blog-prod', { ...remote('git@gitlab.com:intelimail/blog.git'), last_code_modified: day(3) }),
  ]
  const { projects, clients, stats } = buildRegistry(records, { now: NOW })
  assert.equal(projects.length, 1)
  const p = projects[0]
  assert.equal(p.key, 'git:gitlab.com/intelimail/blog')
  assert.equal(p.name, 'blog')
  assert.equal(p.primary, '/P/blog-huha')
  assert.deepEqual(p.client, { id: 'intelimail', name: 'Intelimail', source: 'owner' })
  assert.deepEqual(Object.fromEntries(p.locations.map(l => [l.directory, l.role])),
    { '/P/blog-huha': 'primary', '/P/_Bizz/Intelimail/blog': 'experiment', '/P/blog-prod': 'deploy', '/P/blog-test': 'stale' })
  assert.deepEqual(clients, [{ id: 'intelimail', name: 'Intelimail', projects: ['git:gitlab.com/intelimail/blog'] }])
  assert.equal(stats.multi_location, 1)
  assert.equal(stats.locations_in_multi, 4)
})

test('client chain: manual > ai > owner > path; unknown owner is ignored', () => {
  const metas = new Map([['/P/m', { meta: { id: 'p_mmmmmmmmmmmm', client: 'Acme' }, warnings: [] }]])
  const records = [
    rec('m', '/P/m', { ai_analysis: { client: 'Intelimail' } }),
    rec('ai', '/P/ai', { ...remote('git@github.com:erikmeliska/ai.git'), ai_analysis: { client: 'new:Archon' } }),
    rec('o', '/P/o', remote('git@github.com:joweich/trends.git')),
    rec('pa', '/P/_Bizz/TriSoft/tool'),
    rec('own', '/P/own', remote('git@gitlab.com:tri-soft/calc.git')),
  ]
  const config = { clients: [{ name: 'TriSoft', aliases: ['tri-soft'] }] }
  const by = Object.fromEntries(buildRegistry(records, { metas, config, now: NOW }).projects.map(p => [p.primary, p.client]))
  assert.deepEqual(by['/P/m'], { id: 'acme', name: 'Acme', source: 'manual' })
  assert.deepEqual(by['/P/ai'], { id: 'archon', name: 'Archon', source: 'ai' })
  assert.equal(by['/P/o'], null)
  assert.deepEqual(by['/P/_Bizz/TriSoft/tool'], { id: 'trisoft', name: 'TriSoft', source: 'path' })
  assert.deepEqual(by['/P/own'], { id: 'trisoft', name: 'TriSoft', source: 'owner' })
})

test('manual roles win; several manual primaries warn; stow id identity; meta warnings surface', () => {
  const metas = new Map([
    ['/P/x1', { meta: { id: 'p_111111111111', role: 'primary' }, warnings: [] }],
    ['/P/x2', { meta: { id: 'p_222222222222', role: 'primary' }, warnings: [] }],
    ['/P/solo', { meta: { id: 'p_soloooooooo', role: 'stale' }, warnings: ['ignored invalid client'] }],
  ])
  const records = [
    rec('1', '/P/x1', { ...remote('git@github.com:a/x.git'), last_code_modified: day(10) }),
    rec('2', '/P/x2', { ...remote('git@github.com:a/x.git'), last_code_modified: day(5) }),
    rec('3', '/P/x3', { ...remote('git@github.com:a/x.git'), last_code_modified: day(1) }),
    rec('s', '/P/solo'),
  ]
  const { projects } = buildRegistry(records, { metas, now: NOW })
  const x = projects.find(p => p.key === 'git:github.com/a/x')
  assert.equal(x.primary, '/P/x2')
  assert.deepEqual(x.warnings, ['multiple-primary'])
  assert.deepEqual(x.locations.map(l => [l.directory, l.role, l.role_source]),
    [['/P/x2', 'primary', 'manual'], ['/P/x3', 'experiment', 'derived'], ['/P/x1', 'primary', 'manual']])
  const solo = projects.find(p => p.key === 'stow:p_soloooooooo')
  assert.equal(solo.kind, 'stow')
  assert.equal(solo.primary, '/P/solo')
  assert.deepEqual(solo.locations.map(l => [l.role, l.role_source]), [['stale', 'manual']])
  assert.deepEqual(solo.warnings, ['/P/solo: ignored invalid client'])
})

test('no manual primary: derived primary skips manually-roled locations; tie → shortest path', () => {
  const metas = new Map([['/P/a', { meta: { id: 'p_aaaaaaaaaaaa', role: 'deploy' }, warnings: [] }]])
  const records = [
    rec('a', '/P/a', { ...remote('git@github.com:o/r.git'), last_code_modified: day(0) }),
    rec('b', '/P/bb', { ...remote('git@github.com:o/r.git'), last_code_modified: day(2) }),
    rec('c', '/P/b', { ...remote('git@github.com:o/r.git'), last_code_modified: day(2) }),
  ]
  const [p] = buildRegistry(records, { metas, now: NOW }).projects
  assert.equal(p.primary, '/P/b')
})

test('sorting and stats: unassigned last, by_kind / by_client_source counts', () => {
  const records = [
    rec('1', '/P/zeta', remote('git@github.com:x/zeta.git')),
    rec('2', '/P/_Bizz/Acme/beta'),
    rec('3', '/P/_Bizz/Acme/alpha'),
  ]
  const r = buildRegistry(records, { now: NOW })
  assert.deepEqual(r.projects.map(p => p.name), ['alpha', 'beta', 'zeta'])
  assert.deepEqual(r.stats, { records: 3, projects: 3, multi_location: 0, locations_in_multi: 0, unassigned: 1,
    by_kind: { git: 1, path: 2 }, by_client_source: { path: 2 } })
})

test('parseRegistryConfig validates shape', () => {
  assert.deepEqual(parseRegistryConfig('{"clients":[{"name":"TriSoft","aliases":["tri-soft"]},{"name":"Acme"}]}'),
    { version: 1, clients: [{ name: 'TriSoft', aliases: ['tri-soft'] }, { name: 'Acme', aliases: [] }] })
  assert.throws(() => parseRegistryConfig('{nope'), /registry.json/)
  assert.throws(() => parseRegistryConfig('{"clients":[{"aliases":[]}]}'), /name/)
  assert.throws(() => parseRegistryConfig('{"clients":[{"name":"A","aliases":"x"}]}'), /aliases/)
})

test('loadRegistry reads ledger + config from the state dir and metas per directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-reg-'))
  const saved = process.env.STOW_STATE_DIR
  process.env.STOW_STATE_DIR = base
  try {
    await fs.mkdir(path.join(base, 'data'))
    assert.deepEqual(await readRegistryConfig(), { version: 1, clients: [] })
    await fs.writeFile(path.join(base, 'data', 'projects_metadata.jsonl'),
      JSON.stringify(rec('a', '/P/one')) + '\nnot json\n' + JSON.stringify(rec('b', '/P/two')) + '\n')
    await fs.writeFile(path.join(base, 'data', 'registry.json'), '{"clients":[{"name":"Acme"}]}')
    const readMeta = async dir => dir === '/P/one'
      ? { meta: { id: 'p_oneoneoneone', client: 'acme' }, warnings: [] } : { meta: null, warnings: [] }
    const r = await loadRegistry({ readMeta, now: NOW })
    assert.equal(r.stats.records, 2)
    assert.deepEqual(r.projects.map(p => [p.key, p.client?.name ?? null]),
      [['stow:p_oneoneoneone', 'Acme'], ['path:/P/two', null]])
  } finally {
    if (saved === undefined) delete process.env.STOW_STATE_DIR; else process.env.STOW_STATE_DIR = saved
    await fs.rm(base, { recursive: true, force: true })
  }
})