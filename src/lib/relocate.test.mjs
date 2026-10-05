import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planRelocation, nearestExistingParent, executeRelocation, resumeRelocation } from './relocate.mjs'
import { claudeSlug } from './claude-project-dirs.mjs'
import { openStore, upsertSession } from './cc/store.mjs'
import { loadPathMoves } from './path-moves.mjs'

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

// ── executeRelocation ────────────────────────────────────────────────────────

const exists = (p) => fsp.stat(p).then(() => true, () => false)

async function listTree(dir) {
  const out = []
  async function walk(d) {
    let es
    try { es = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { out.push(p + '/'); await walk(p) } else out.push(`${p}=${await readFile(p, 'utf8')}`)
    }
  }
  await walk(dir)
  return out
}

/** A temp state dir (ledger, usage cache, file DB) wired into f.deps. */
async function withStateDir(f) {
  const stateDir = path.join(f.root, 'state'); const data = path.join(stateDir, 'data')
  await mkdir(data, { recursive: true })
  const ledger = path.join(data, 'projects_metadata.jsonl')
  const other = { directory: path.join(f.P, 'other'), checkout: { root: path.join(f.P, 'other'), subpath: '', git: true } }
  await writeFile(ledger, [JSON.stringify(f.deps.rows[0]), JSON.stringify({ directory: path.join(f.from, 'pkg'), checkout: { root: f.from, subpath: 'pkg', git: true } }), JSON.stringify(other)].join('\n') + '\n')
  const cacheFile = path.join(data, 'usage-cache.json')
  await writeFile(cacheFile, JSON.stringify({ version: 1, files: {} }))
  const dbFile = path.join(data, 'cc-sessions.db')
  const db = openStore(dbFile)
  const movesFile = path.join(data, 'path-moves.json')
  const stateOpts = { env: { STOW_STATE_DIR: stateDir } }
  const deps = { ...f.deps, stateOpts, openStore: () => openStore(dbFile), runExclusive: (fn) => fn(), now: () => '2026-10-05T00:00:00.000Z' }
  return {
    deps, movesFile, db: () => db,
    seedSession: async (row) => upsertSession(db, row),
    seedUsageCache: async (files) => writeFile(cacheFile, JSON.stringify({ version: 1, files })),
    readUsageCache: async () => JSON.parse(await readFile(cacheFile, 'utf8')),
    readLedger: async () => (await readFile(ledger, 'utf8')).trim().split('\n').map(l => JSON.parse(l)),
    snapshot: async () => ({
      tree: [...await listTree(f.P), ...await listTree(f.claudeDir)],
      sessions: db.prepare('SELECT session_id, project_dir, cwd, base_dir, raw_ref FROM sessions ORDER BY session_id').all().map(r => ({ ...r })),
      subagents: db.prepare('SELECT agent_id, raw_ref FROM subagents ORDER BY agent_id').all().map(r => ({ ...r })),
      ingest: db.prepare('SELECT path, session_id FROM ingest_state ORDER BY path').all().map(r => ({ ...r })),
      cache: await readFile(cacheFile, 'utf8'),
      ledger: await readFile(ledger, 'utf8'),
      moves: await readFile(movesFile, 'utf8').catch(() => null),
    }),
    done: async () => { db.close() },
  }
}

async function seedAll(f, env) {
  const cdir = await f.mkClaude(f.from, { memory: true })
  await mkdir(path.join(cdir, 's1', 'subagents'), { recursive: true })
  await writeFile(path.join(cdir, 's1', 'subagents', 'agent-a.jsonl'), '{}\n')
  await env.seedSession({ session_id: 's1', project_dir: f.from, cwd: f.from, raw_ref: path.join(cdir, 's1.jsonl') })
  await env.seedSession({ session_id: 's2', project_dir: path.join(f.P, 'other'), cwd: f.from + 'ish', raw_ref: '/elsewhere/s2.jsonl' })
  env.db().prepare('INSERT INTO subagents (agent_id, session_id, raw_ref) VALUES (?, ?, ?)').run('a', 's1', path.join(cdir, 's1', 'subagents', 'agent-a.jsonl'))
  env.db().prepare('INSERT INTO ingest_state (path, session_id, signature) VALUES (?, ?, ?)').run(path.join(cdir, 's1.jsonl'), 's1', 'sig')
  await env.seedUsageCache({
    '/other/x.jsonl': { tool: 'claude', size: 1, mtimeMs: 1, offset: 1, missing: false, state: { cwd: '/x' } },
    [path.join(cdir, 's1.jsonl')]: { tool: 'claude', size: 10, mtimeMs: 1, offset: 10, missing: false, state: { cwd: f.from } },
    '/other/z.jsonl': { tool: 'claude', size: 1, mtimeMs: 1, offset: 1, missing: false, state: { cwd: '/z' } },
  })
  return cdir
}

test('execute: moves dir, renames Claude folder incl. memory, rewrites db/cache/ledger, records alias', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    const cdir = await seedAll(f, env)
    const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
    assert.equal(plan.ok, true, plan.blockers.join())
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, env.deps)
    assert.equal(res.ok, true, JSON.stringify(res.failed))
    assert.deepEqual(res.done, ['move-dir', 'claude-dir', 'db', 'usage-cache', 'alias', 'ledger'])
    assert.ok(await exists(f.to)); assert.equal(await exists(f.from), false)
    const newDir = path.join(f.claudeDir, claudeSlug(f.to))
    assert.ok(await exists(path.join(newDir, 'memory/MEMORY.md')))
    assert.equal(await exists(cdir), false)
    const s = env.db().prepare('SELECT project_dir, cwd, raw_ref FROM sessions WHERE session_id = ?').get('s1')
    assert.deepEqual({ ...s }, { project_dir: f.to, cwd: f.to, raw_ref: path.join(newDir, 's1.jsonl') })
    const s2 = env.db().prepare('SELECT cwd FROM sessions WHERE session_id = ?').get('s2')
    assert.equal(s2.cwd, f.from + 'ish') // path boundary
    assert.equal(env.db().prepare('SELECT raw_ref FROM subagents').get().raw_ref, path.join(newDir, 's1', 'subagents', 'agent-a.jsonl'))
    assert.equal(env.db().prepare('SELECT path FROM ingest_state').get().path, path.join(newDir, 's1.jsonl'))
    const cache = await env.readUsageCache()
    assert.deepEqual(Object.keys(cache.files), ['/other/x.jsonl', path.join(newDir, 's1.jsonl'), '/other/z.jsonl']) // order kept
    assert.equal(cache.files[path.join(newDir, 's1.jsonl')].offset, 10) // no re-parse, no ghost
    const ledger = await env.readLedger()
    assert.deepEqual(ledger.map(r => [r.directory, r.checkout.root]), [[f.to, f.to], [path.join(f.to, 'pkg'), f.to], [path.join(f.P, 'other'), path.join(f.P, 'other')]])
    assert.deepEqual((await loadPathMoves({ file: env.movesFile })).map(m => [m.from, m.to]), [[f.from, f.to]])
    const journal = JSON.parse(await readFile(res.journal, 'utf8'))
    assert.equal(journal.status, 'ok')
  } finally { await env.done(); await f.done() }
})

for (const failAt of ['move-dir', 'claude-dir', 'db', 'usage-cache', 'alias', 'ledger']) {
  test(`failure at ${failAt} rolls everything back`, async () => {
    const f = await fixture(); const env = await withStateDir(f)
    try {
      await seedAll(f, env)
      const before = await env.snapshot()
      const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
      const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, { ...env.deps, failAt })
      assert.equal(res.ok, false); assert.equal(res.rolledBack, true); assert.equal(res.failed.kind, failAt)
      assert.deepEqual(await env.snapshot(), before)
      assert.equal(JSON.parse(await readFile(res.journal, 'utf8')).status, 'rolled-back')
    } finally { await env.done(); await f.done() }
  })
}

test('merge into an existing target Claude folder, and roll it back', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    await seedAll(f, env)
    const target = await f.mkClaude(f.to)
    await rm(path.join(target, 's1.jsonl')); await writeFile(path.join(target, 's9.jsonl'), JSON.stringify({ cwd: f.to }) + '\n')
    const before = await env.snapshot()
    const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
    assert.equal(plan.ok, true, plan.blockers.join())
    const failed = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, { ...env.deps, failAt: 'ledger' })
    assert.equal(failed.rolledBack, true)
    assert.deepEqual(await env.snapshot(), before)
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, env.deps)
    assert.equal(res.ok, true)
    assert.deepEqual((await readdir(target)).sort(), ['memory', 's1', 's1.jsonl', 's9.jsonl'])
  } finally { await env.done(); await f.done() }
})

test('stale planHash and a blocked plan are refused before anything runs', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: 'x'.repeat(64) }, env.deps)
    assert.equal(res.ok, false); assert.match(res.failed.error, /plan changed/)
    const blocked = await executeRelocation({ from: '/nope', to: f.to, planHash: 'x' }, env.deps)
    assert.match(blocked.failed.error, /not a register location/)
    assert.ok(await exists(f.from))
  } finally { await env.done(); await f.done() }
})

test('a running summary batch refuses the move', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    env.db().prepare("INSERT INTO summary_jobs (job_id, status, heartbeat_at) VALUES ('j', 'running', ?)").run(new Date().toISOString())
    const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, { ...env.deps, now: undefined })
    assert.equal(res.ok, false); assert.match(res.failed.error, /summary batch/)
    assert.ok(await exists(f.from))
  } finally { await env.done(); await f.done() }
})

test('db rewrite: an underscore in the path does not match a sibling', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    const from = path.join(f.P, 'a_b'); const sib = path.join(f.P, 'aXb'); const to = path.join(f.P, 'moved')
    await mkdir(from); await mkdir(sib)
    const deps = { ...env.deps, exec: async () => ({ stdout: '' }), register: { projects: [{ key: 'p', locations: [{ directory: from }] }] }, rows: [] }
    await env.seedSession({ session_id: 'u', project_dir: from, cwd: path.join(from, 'src') })
    await env.seedSession({ session_id: 'x', project_dir: sib, cwd: sib })
    const plan = await planRelocation({ from, to }, deps)
    assert.equal((await executeRelocation({ from, to, planHash: plan.planHash }, deps)).ok, true)
    const rows = env.db().prepare('SELECT session_id, project_dir, cwd FROM sessions ORDER BY session_id').all().map(r => ({ ...r }))
    assert.deepEqual(rows, [{ session_id: 'u', project_dir: to, cwd: path.join(to, 'src') }, { session_id: 'x', project_dir: sib, cwd: sib }])
  } finally { await env.done(); await f.done() }
})

test('resumeRelocation rolls back a journal left by a crash', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    await seedAll(f, env)
    const before = await env.snapshot()
    const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
    // A crash after 'usage-cache': the process dies, the journal stays 'running'.
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, { ...env.deps, crashAt: 'usage-cache' }).catch(e => e)
    assert.match(String(res.message), /crash/)
    const [jf] = await readdir(path.join(f.root, 'state', 'data', 'relocations'))
    const journalFile = path.join(f.root, 'state', 'data', 'relocations', jf)
    assert.equal(JSON.parse(await readFile(journalFile, 'utf8')).status, 'running')
    const r = await resumeRelocation(journalFile, env.deps)
    assert.equal(r.rolledBack, true)
    assert.deepEqual(await env.snapshot(), before)
    assert.equal(JSON.parse(await readFile(journalFile, 'utf8')).status, 'rolled-back')
  } finally { await env.done(); await f.done() }
})
