import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gitProbe, clearGitProbeCache, buildProjectIndex, placeSession, loadPlacementContext } from './project-key.mjs'

beforeEach(() => clearGitProbeCache())

// Shape of #8's buildRegistry() output: project id is `key`.
const register = { projects: [
  { key: 'P-blog', name: 'blog', locations: [{ directory: '/p/blog' }, { directory: '/p/blog-huha' }] },
  { key: 'P-mono', name: 'mono', locations: [{ directory: '/p/mono' }] },
  { key: 'P-pkg', name: 'pkg-a', locations: [{ directory: '/p/mono/packages/a' }] },
] }

function fakeExec(answers) {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const dir = args[1]
    if (!(dir in answers)) throw new Error('not a git repository')
    return { stdout: answers[dir] }
  }
  return { exec, calls }
}

test('index: deepest location wins, sibling prefix does not match', () => {
  const idx = buildProjectIndex({ register })
  assert.equal(idx.lookup('/p/mono/packages/a/src'), 'P-pkg')
  assert.equal(idx.lookup('/p/mono/docs'), 'P-mono')
  assert.equal(idx.lookup('/p/blog-huha'), 'P-blog')
  assert.equal(idx.lookup('/p/blog-huhax'), null)
  assert.equal(idx.lookup('/elsewhere'), null)
  assert.ok(idx.knownDirs.includes('/p/mono/packages/a'))
})

test('index: missing/malformed register → empty', () => {
  assert.equal(buildProjectIndex({ register: null }).lookup('/p/blog'), null)
  assert.equal(buildProjectIndex({ register: { projects: 'nope' } }).lookup('/p/blog'), null)
})

test('gitProbe: linked worktree, main checkout, bare, failure; memoized', async () => {
  const { exec, calls } = fakeExec({
    '/w/feat': '/p/blog/.git\n/w/feat\n',
    '/p/blog': '/p/blog/.git\n/p/blog\n',
    '/w/bare': '/srv/blog.git\n/w/bare\n',
  })
  assert.deepEqual(await gitProbe('/w/feat', { exec }), { base: '/p/blog', toplevel: '/w/feat' })
  assert.equal(await gitProbe('/p/blog', { exec }), null)
  assert.equal(await gitProbe('/w/bare', { exec }), null)
  assert.equal(await gitProbe('/nope', { exec }), null)
  await gitProbe('/w/feat', { exec }); await gitProbe('/nope', { exec })
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[0], ['git', '-C', '/w/feat', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
})

test('placeSession: agent-office worktree of a gone dir — no git spawn', async () => {
  const { exec, calls } = fakeExec({})
  const index = buildProjectIndex({ register })
  const got = await placeSession({ cwd: '/p/blog/.agent-office/worktrees/pixel-77d1', project_dir: '/p/blog/.agent-office/worktrees/pixel-77d1' },
    { index, exists: () => false, exec })
  assert.deepEqual(got, { project_key: 'P-blog', workspace: 'agent-office:pixel-77d1', base_dir: '/p/blog' })
  assert.equal(calls.length, 0)
})

test('placeSession: live linked git worktree outside the project', async () => {
  const { exec } = fakeExec({ '/w/feat/src': '/p/blog/.git\n/w/feat\n' })
  const got = await placeSession({ cwd: '/w/feat/src', project_dir: '/w/feat/src' },
    { index: buildProjectIndex({ register }), exists: () => true, exec })
  assert.deepEqual(got, { project_key: 'P-blog', workspace: 'git-worktree:feat', base_dir: '/p/blog/src' })
})

test('placeSession: dir inside a known location is never probed', async () => {
  const { exec, calls } = fakeExec({})
  const got = await placeSession({ cwd: '/p/mono/docs', project_dir: '/p/mono/docs' },
    { index: buildProjectIndex({ register }), exists: () => true, exec })
  assert.deepEqual(got, { project_key: 'P-mono', workspace: null, base_dir: '/p/mono/docs' })
  assert.equal(calls.length, 0)
})

test('placeSession: Codex/Gemini rows use project_dir over cwd', async () => {
  const got = await placeSession({ cwd: '/home', project_dir: '/p/mono/packages/a', raw_ref: '/x/.codex/sessions/a.jsonl' },
    { index: buildProjectIndex({ register }), exists: () => false, exec: async () => { throw new Error() } })
  assert.equal(got.project_key, 'P-pkg')
})

test('placeSession: no register → key null, workspace still set', async () => {
  const got = await placeSession({ cwd: '/p/blog/.claude/worktrees/x', project_dir: '/p/blog/.claude/worktrees/x' },
    { index: buildProjectIndex({ register: null }), exists: () => false, exec: async () => { throw new Error() } })
  assert.deepEqual(got, { project_key: null, workspace: 'claude-worktree:x', base_dir: '/p/blog' })
})

test('loadPlacementContext: register load passes base; a throwing load is an empty index', async () => {
  let seen
  const ok = await loadPlacementContext({ base: '/repo', load: async (o) => { seen = o; return register } })
  assert.deepEqual(seen, { base: '/repo' })
  assert.equal(ok.index.lookup('/p/blog'), 'P-blog')
  const warn = console.warn; console.warn = () => {}
  try {
    const bad = await loadPlacementContext({ load: async () => { throw new Error('invalid registry.json') } })
    assert.equal(bad.index.lookup('/p/blog'), null)
  } finally { console.warn = warn }
})
