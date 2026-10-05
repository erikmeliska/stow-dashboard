import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planRelocation, nearestExistingParent } from './relocate.mjs'
import { claudeSlug } from './claude-project-dirs.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'reloc-'))
  const P = path.join(root, 'P'); const claudeDir = path.join(root, 'home/.claude/projects')
  const from = path.join(P, 'blog'); const to = path.join(P, '_Bizz/Acme/blog')
  await mkdir(from, { recursive: true })
  await mkdir(claudeDir, { recursive: true })
  const mkClaude = async (cwd, extra = {}) => {
    const d = path.join(claudeDir, claudeSlug(cwd)); await mkdir(d, { recursive: true })
    await writeFile(path.join(d, 's1.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n')
    if (extra.memory) { await mkdir(path.join(d, 'memory')); await writeFile(path.join(d, 'memory/MEMORY.md'), '- x') }
    return d
  }
  const deps = {
    fs: fsp, claudeDir,
    exec: async (cmd, args) => (args.includes('worktree') ? { stdout: `worktree ${from}\n` } : { stdout: '' }),
    processesUnder: async () => 0,
    register: { projects: [{ key: 'p1', locations: [{ directory: from, role: 'primary', role_source: 'derived' }] }] },
    rows: [{ directory: from, checkout: { root: from, subpath: '', git: true }, git_info: { uncommitted_changes: 0 } }],
    store: { count: async () => 3 }, usageCache: { keysUnder: async () => ['k1'] },
    stat: fsp.stat,
  }
  return { root, P, from, to, claudeDir, mkClaude, deps, done: () => rm(root, { recursive: true, force: true }) }
}

test('happy path lists every step incl. memory and is ok', async () => {
  const f = await fixture()
  try {
    await f.mkClaude(f.from, { memory: true }); await f.mkClaude(path.join(f.from, 'sub'))
    await f.mkClaude(f.from + 'ish') // must NOT be selected
    const plan = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(plan.ok, true, plan.blockers.join())
    assert.deepEqual(plan.steps.map(s => s.kind), ['move-dir', 'claude-dir', 'claude-dir', 'db', 'usage-cache', 'alias', 'ledger'])
    assert.match(plan.steps[1].description, /memory/)
    assert.equal(plan.steps[1].detail.dest, path.join(f.claudeDir, claudeSlug(f.to)))
    assert.equal(plan.steps[2].detail.dest, path.join(f.claudeDir, claudeSlug(path.join(f.to, 'sub'))))
    assert.match(plan.planHash, /^[0-9a-f]{64}$/)
    assert.ok(plan.warnings.some(w => /claude\.json/.test(w)))
    // same inputs → same hash
    assert.equal((await planRelocation({ from: f.from, to: f.to }, f.deps)).planHash, plan.planHash)
  } finally { await f.done() }
})

test('blockers: target exists, not a location, running process, linked worktree, other device, into itself', async () => {
  const f = await fixture()
  try {
    await mkdir(f.to, { recursive: true })
    assert.match((await planRelocation({ from: f.from, to: f.to }, f.deps)).blockers.join(), /already exists/)
    await rm(f.to, { recursive: true })
    assert.match((await planRelocation({ from: '/nope', to: f.to }, f.deps)).blockers.join(), /not a register location/)
    assert.match((await planRelocation({ from: f.from, to: f.to }, { ...f.deps, processesUnder: async () => 2 })).blockers.join(), /running/)
    const wt = { ...f.deps, exec: async () => ({ stdout: `worktree ${f.from}\n\nworktree ${f.from}/.agent-office/worktrees/x\n` }) }
    assert.match((await planRelocation({ from: f.from, to: f.to }, wt)).blockers.join(), /worktree/)
    const linked = { ...f.deps, exec: async () => ({ stdout: `worktree /elsewhere/main\n\nworktree ${f.from}\n` }) }
    assert.match((await planRelocation({ from: f.from, to: f.to }, linked)).blockers.join(), /linked worktree of/)
    const dev = { ...f.deps, stat: async (p) => ({ dev: p.startsWith(f.from) ? 1 : 2, isDirectory: () => true }) }
    dev.stat = async (p) => { if (p === f.to) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { dev: p.startsWith(f.from) ? 1 : 2 } }
    assert.match((await planRelocation({ from: f.from, to: f.to }, dev)).blockers.join(), /device/)
    assert.match((await planRelocation({ from: f.from, to: path.join(f.from, 'inner') }, f.deps)).blockers.join(), /inside/)
  } finally { await f.done() }
})

test('dirty tree is a warning, blocking only without force', async () => {
  const f = await fixture()
  try {
    f.deps.rows[0].git_info.uncommitted_changes = 4
    const p = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(p.ok, false); assert.match(p.blockers.join(), /uncommitted/)
    const forced = await planRelocation({ from: f.from, to: f.to, force: true }, f.deps)
    assert.equal(forced.ok, true); assert.match(forced.warnings.join(), /uncommitted/)
  } finally { await f.done() }
})

test('target Claude folder exists: merge, collision blocks', async () => {
  const f = await fixture()
  try {
    await f.mkClaude(f.from)
    const target = await f.mkClaude(f.to) // also contains s1.jsonl → collision
    assert.match((await planRelocation({ from: f.from, to: f.to }, f.deps)).blockers.join(), /collision.*s1\.jsonl/)
    await rm(path.join(target, 's1.jsonl')); await writeFile(path.join(target, 's2.jsonl'), '')
    const p = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(p.ok, true, p.blockers.join()); assert.match(p.steps.find(s => s.kind === 'claude-dir').description, /^Merge/)
  } finally { await f.done() }
})

test('a target slug over 200 characters is a blocker (Claude Code hashes those)', async () => {
  const f = await fixture()
  try {
    await f.mkClaude(f.from)
    const long = path.join(f.P, 'x'.repeat(220))
    assert.match((await planRelocation({ from: f.from, to: long }, f.deps)).blockers.join(), /too long/)
  } finally { await f.done() }
})

test('nearestExistingParent walks up to a directory that exists', async () => {
  const f = await fixture()
  try {
    assert.equal(await nearestExistingParent(path.join(f.P, 'a/b/c'), fsp.stat), f.P)
  } finally { await f.done() }
})
