import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentOfficeExport, floorId, githubRepo, isWorktreePath, EXPORT_FORMAT,
} from './agent-office-export.mjs'

const B = '/Users/u/Projekty/_Bizz/Intelimail'
const loc = (directory, role, last_activity = null) => ({ directory, role, role_source: 'derived', last_activity, record_id: null, stow_id: null })
const project = (o) => ({ kind: 'git', remote: null, client: null, warnings: [], ...o })
const intelimail = { id: 'intelimail', name: 'Intelimail', source: 'ai' }

const blog = project({
  key: 'git:gitlab.com/intelimail/blog', name: 'blog', remote: 'gitlab.com/intelimail/blog', client: intelimail,
  primary: `${B}/blog`,
  locations: [
    loc(`${B}/blog`, 'primary', '2026-10-04T12:00:00.000Z'),
    loc(`${B}/blog-huha`, 'experiment', '2026-09-01T00:00:00.000Z'),
    loc(`${B}/blog-volaco`, 'stale', '2025-01-01T00:00:00.000Z'),
  ],
})
const app = project({
  key: 'git:github.com/intelimail/app', name: 'app', remote: 'github.com/intelimail/app', client: intelimail,
  primary: `${B}/app`, locations: [loc(`${B}/app`, 'primary', '2026-10-05T08:00:00.000Z')],
})
const loose = project({ key: 'path:/Users/u/x', kind: 'path', name: 'x', primary: '/Users/u/x', locations: [loc('/Users/u/x', 'primary')] })
const reg = (...projects) => {
  const clients = new Map()
  for (const p of projects) if (p.client) {
    const c = clients.get(p.client.id) ?? { id: p.client.id, name: p.client.name, projects: [] }
    c.projects.push(p.key); clients.set(c.id, c)
  }
  return { clients: [...clients.values()], projects, stats: {} }
}
const all = () => true
const NOW = Date.parse('2026-10-05T18:00:00.000Z')

test('blog 4x → one floor, locations primary first, gitlab has no repo', () => {
  const doc = buildAgentOfficeExport(reg(blog), { now: NOW, exists: all })
  assert.equal(doc.format, EXPORT_FORMAT)
  assert.equal(doc.version, 1)
  assert.equal(doc.generated_at, '2026-10-05T18:00:00.000Z')
  assert.equal(doc.buildings.length, 1)
  const [b] = doc.buildings
  assert.deepEqual([b.id, b.name], ['intelimail', 'Intelimail'])
  const [f] = b.floors
  assert.equal(f.dir, `${B}/blog`)
  assert.equal(f.repo, null)
  assert.equal(f.remote, 'gitlab.com/intelimail/blog')
  assert.equal(f.project_key, 'git:gitlab.com/intelimail/blog')
  assert.equal(f.last_activity, '2026-10-04T12:00:00.000Z')
  assert.deepEqual(f.locations.map(l => l.role), ['primary', 'experiment', 'stale'])
  assert.deepEqual(Object.keys(f.locations[0]), ['dir', 'role'])
})

test('githubRepo only for github.com', () => {
  assert.equal(githubRepo('github.com/IntelIMail/App'), 'IntelIMail/App')
  assert.equal(githubRepo('github.com/o/r/sub'), 'o/r')
  assert.equal(githubRepo('gitlab.com/o/r'), null)
  assert.equal(githubRepo('notgithub.com/o/r'), null)
  assert.equal(githubRepo(null), null)
})

test('floorId: stable, slug-safe, unique per key', () => {
  const re = /^[a-z0-9-]{1,40}$/
  for (const n of ['web', 'Biblia čítanie', 'next.js-demo', '_tools', '!!!', 'x'.repeat(80)]) {
    const id = floorId(n, `git:h/${n}`)
    assert.match(id, re, n)
  }
  assert.equal(floorId('web', 'git:a/web'), floorId('web', 'git:a/web'))
  assert.notEqual(floorId('web', 'git:a/web'), floorId('web', 'git:b/web'))
  assert.match(floorId('Biblia čítanie', 'k'), /^biblia-citanie-[0-9a-f]{6}$/)
  assert.match(floorId('!!!', 'k'), /^project-[0-9a-f]{6}$/)
})

test('isWorktreePath', () => {
  assert.ok(isWorktreePath('/p/_AgentOffice/o/r/.agent-office/worktrees/bolt-5310'))
  assert.ok(isWorktreePath('/p/r/.claude/worktrees/feat'))
  assert.ok(!isWorktreePath('/p/r'))
})

test('worktree primary → falls back to the most active real checkout', () => {
  const wt = '/p/r/.agent-office/worktrees/bolt-1'
  const p = project({ ...app, primary: wt, locations: [loc(wt, 'primary', '2026-10-05T10:00:00Z'), loc(`${B}/app`, 'experiment', '2026-10-01T00:00:00Z')] })
  const [f] = buildAgentOfficeExport(reg(p), { now: NOW, exists: all }).buildings[0].floors
  assert.equal(f.dir, `${B}/app`)
  assert.deepEqual(f.locations.map(l => l.dir), [`${B}/app`])
})

test('only worktrees or only missing dirs → skipped', () => {
  const wt = project({ ...app, key: 'git:github.com/o/wt', primary: '/r/.claude/worktrees/a', locations: [loc('/r/.claude/worktrees/a', 'primary')] })
  const doc = buildAgentOfficeExport(reg(wt, blog), { now: NOW, exists: d => d !== `${B}/blog` && d !== `${B}/blog-huha` && d !== `${B}/blog-volaco` })
  assert.deepEqual(doc.skipped, [
    { project_key: 'git:github.com/o/wt', reason: 'no-location' },
    { project_key: blog.key, reason: 'no-location' },
  ])
  assert.deepEqual(doc.buildings, [])
  assert.deepEqual(doc.stats, { buildings: 0, floors: 0, skipped: 2 })
})

test('deleted primary → next existing location', () => {
  const doc = buildAgentOfficeExport(reg(blog), { now: NOW, exists: d => d !== `${B}/blog` })
  assert.equal(doc.buildings[0].floors[0].dir, `${B}/blog-huha`)
})

test('unassigned off by default, own building when asked', () => {
  assert.equal(buildAgentOfficeExport(reg(loose), { now: NOW, exists: all }).buildings.length, 0)
  const doc = buildAgentOfficeExport(reg(loose, blog), { now: NOW, exists: all, includeUnassigned: true })
  assert.deepEqual(doc.buildings.map(b => b.id), ['intelimail', 'unassigned'])
  assert.equal(doc.buildings[1].name, 'Unassigned')
})

test('client filter by name or spelling variant; unknown throws', () => {
  const other = project({ ...loose, key: 'git:github.com/t/t', client: { id: 'trisoft', name: 'TriSoft', source: 'ai' } })
  const r = reg(blog, other)
  for (const c of ['Intelimail', 'InteliMail', 'intelimail']) {
    assert.deepEqual(buildAgentOfficeExport(r, { now: NOW, exists: all, client: c }).buildings.map(b => b.id), ['intelimail'])
  }
  assert.throws(() => buildAgentOfficeExport(r, { now: NOW, exists: all, client: 'Intelimial' }), e => e.code === 'UNKNOWN_CLIENT')
})

test('floors by last activity desc, null last; deterministic', () => {
  const quiet = project({ ...blog, key: 'git:gitlab.com/intelimail/aaa', name: 'aaa', locations: [loc(`${B}/aaa`, 'primary')], primary: `${B}/aaa` })
  const r = reg(blog, quiet, app)
  const a = buildAgentOfficeExport(r, { now: NOW, exists: all })
  assert.deepEqual(a.buildings[0].floors.map(f => f.name), ['app', 'blog', 'aaa'])
  assert.deepEqual(buildAgentOfficeExport(r, { now: NOW, exists: all }), a)
})

test('last_activity accepts ms numbers', () => {
  const p = project({ ...app, locations: [loc(`${B}/app`, 'primary', Date.parse('2026-10-05T08:00:00.000Z'))] })
  assert.equal(buildAgentOfficeExport(reg(p), { now: NOW, exists: all }).buildings[0].floors[0].last_activity, '2026-10-05T08:00:00.000Z')
})

test('linked git worktrees (from the ledger) are dropped like worktree paths', () => {
  const linked = `${B}/app-feature`
  const p = project({ ...app, primary: linked, locations: [loc(linked, 'primary', '2026-10-05T10:00:00Z'), loc(`${B}/app`, 'experiment', '2026-10-01T00:00:00Z')] })
  const [f] = buildAgentOfficeExport(reg(p), { now: NOW, exists: all, worktrees: new Set([linked]) }).buildings[0].floors
  assert.equal(f.dir, `${B}/app`)
  assert.deepEqual(f.locations.map(l => l.dir), [`${B}/app`])
})
