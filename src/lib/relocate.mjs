/**
 * Physical project move (#11) — the exception to the Reorg report's virtual
 * actions. `planRelocation` is a read-only dry-run: blockers, warnings and the
 * exact steps; `executeRelocation` re-plans, refuses unless the planHash the
 * user confirmed still matches, then runs the steps with a journal and undoes
 * them in reverse on any failure.
 *
 * Links migrated: the folder itself, ~/.claude/projects/<slug> (incl. memory/,
 * merged when Claude Code was already used in the target), cc-sessions.db,
 * the usage cache keys, path-moves.json (so Claude transcripts and Codex
 * rollouts — never edited — resolve to the new path) and the ledger rows
 * (= the register location; .stow and remotes travel with the folder).
 * ~/.claude.json is Claude Code's own config and is only warned about.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { claudeSlug, findClaudeProjectDirs } from './claude-project-dirs.mjs'
import { locationOf } from './registry/identity.mjs'
import { dataFile, ledgerFile } from './state-dir.mjs'
import { appendPathMove, removePathMove, resolveMovedPath, loadPathMoves, PATH_MOVES_FILE } from './path-moves.mjs'

// Claude Code shortens longer slugs with a hash we can't reproduce.
const MAX_SLUG = 200

const statOr = (stat, p) => stat(p).then((s) => s, () => null)

export async function nearestExistingParent(p, stat) {
  let cur = path.resolve(p)
  for (;;) {
    if (await statOr(stat, cur)) return cur
    const up = path.dirname(cur)
    if (up === cur) return cur
    cur = up
  }
}

const underDir = (p, dir) => p === dir || p.startsWith(dir + '/')

export async function planRelocation({ from, to, force = false }, deps) {
  const blockers = [], warnings = [], steps = []
  const { fs } = deps
  const stat = deps.stat ?? fs.stat
  from = path.resolve(from); to = path.resolve(to)

  const isLoc = (deps.register?.projects || []).some(p => p.locations?.some(l => l.directory === from))
  if (!isLoc) blockers.push(`${from} is not a register location`)
  if (underDir(to, from)) blockers.push(`${to} is inside ${from}`)
  if (await statOr(stat, to)) blockers.push(`${to} already exists`)
  const fromSt = await statOr(stat, from)
  if (!fromSt) blockers.push(`${from} does not exist`)
  const toParentSt = await statOr(stat, await nearestExistingParent(path.dirname(to), stat))
  if (fromSt && toParentSt && fromSt.dev !== toParentSt.dev) blockers.push('source and target are on different devices')
  if (fromSt && await deps.processesUnder(from) > 0) blockers.push('a process or container is running in this project')

  if (fromSt) {
    const wt = await deps.exec('git', ['-C', from, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }))
    const trees = String(wt?.stdout ?? '').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    const real = await fs.realpath(from).catch(() => from)
    const self = (t) => t === from || t === real
    if (trees.length && !self(trees[0])) blockers.push(`${from} is a linked worktree of ${trees[0]}`)
    else if (trees.length > 1) blockers.push(`linked git worktrees exist: ${trees.slice(1).join(', ')}`)
  }

  const dirty = (deps.rows || []).some(r => locationOf(r) === from && r.git_info?.uncommitted_changes > 0)
  if (dirty) (force ? warnings : blockers).push('uncommitted changes in the working tree')

  steps.push({ kind: 'move-dir', description: `Move ${from} → ${to}`, detail: { from, to } })
  const folders = []
  for (const c of await findClaudeProjectDirs(deps.claudeDir, from, { fs, moves: deps.moves ?? [] })) {
    const newCwd = to + c.cwd.slice(from.length)
    const destSlug = claudeSlug(newCwd)
    if (destSlug.length > MAX_SLUG) blockers.push(`target path too long for a predictable Claude project folder: ${newCwd}`)
    const dest = path.join(deps.claudeDir, destSlug)
    const existing = await fs.readdir(dest).catch(() => null)
    const clash = existing ? c.files.filter(f => existing.includes(f)) : []
    if (clash.length) blockers.push(`Claude folder collision in ${dest}: ${clash.join(', ')}`)
    folders.push({ src: c.dir, dest })
    steps.push({
      kind: 'claude-dir',
      description: `${existing ? 'Merge' : 'Rename'} Claude project folder ${c.slug} → ${destSlug}${c.hasMemory ? ' (incl. memory/)' : ''}`,
      detail: { src: c.dir, dest, merge: !!existing, files: c.files, memory: c.hasMemory },
    })
  }
  steps.push({ kind: 'db', description: `Rewrite ${await deps.store.count(from)} sessions in cc-sessions.db`, detail: { from, to, folders } })
  const keys = await deps.usageCache.keysUnder(folders.map(f => f.src))
  steps.push({ kind: 'usage-cache', description: `Re-key ${keys.length} usage-cache entries of moved transcripts`, detail: { folders } })
  steps.push({ kind: 'alias', description: `Record ${from} → ${to} in path-moves.json (Claude transcripts and Codex rollouts resolve through it)`, detail: { from, to } })
  const rowCount = (deps.rows || []).filter(r => underDir(r.directory, from)).length
  steps.push({ kind: 'ledger', description: `Update ${rowCount} ledger row(s) under the project (the register location follows)`, detail: { from, to } })
  warnings.push('A session ingest or usage refresh in another process (e.g. the dashboard while you use the CLI) is not paused — turn Auto refresh off during the move')
  warnings.push('~/.claude.json per-project settings (trust, allowed tools, MCP) are keyed by path and are not migrated')

  // What will happen (kinds + details), not the informational counts in the descriptions.
  const planHash = createHash('sha256').update(JSON.stringify({ from, to, steps: steps.map(s => [s.kind, s.detail]) })).digest('hex')
  return { ok: blockers.length === 0, from, to, blockers, warnings, steps, planHash }
}

// ── execute ──────────────────────────────────────────────────────────────────
// Every step's run() is all-or-nothing on its own and returns a JSON undo
// record; the journal keeps those records, so a crashed run can still be
// rolled back from disk (resumeRelocation).

const HEARTBEAT_STALE_MS = 60_000

async function atomicWrite(fs, file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, text)
  await fs.rename(tmp, file)
}

const exists = (fs, p) => fs.stat(p).then(() => true, () => false)

function underFolder(p, folders) {
  if (typeof p !== 'string') return null
  for (const { src, dest } of folders) if (p.startsWith(src + '/')) return dest + p.slice(src.length)
  return null
}

// Rename object keys in place of the old ones, keeping the order (so an undo is byte-exact).
function rekey(obj, map) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const nk = map(k) ?? k
    if (nk !== k && nk in obj) throw new Error(`usage cache already has ${nk}`)
    out[nk] = v
  }
  return out
}

const STEPS = {
  'move-dir': {
    async run({ from, to }, { fs, stat }) {
      const parent = path.dirname(to)
      const have = await nearestExistingParent(parent, stat)
      const created = []
      for (let d = parent; d !== have && d.startsWith(have + '/'); d = path.dirname(d)) created.push(d) // deepest first
      await fs.mkdir(parent, { recursive: true })
      try { await fs.rename(from, to) } catch (e) {
        for (const d of created) await fs.rmdir(d).catch(() => {})
        throw e
      }
      return { from, to, created }
    },
    async undo({ from, to, created }, { fs }) {
      await fs.rename(to, from)
      for (const d of created) await fs.rmdir(d)
    },
  },

  'claude-dir': {
    async run({ src, dest, merge, files }, { fs }) {
      if (!merge) { await fs.rename(src, dest); return { src, dest, merge: false } }
      const moved = []
      try {
        for (const f of files) {
          if (await exists(fs, path.join(dest, f))) throw new Error(`Claude folder collision: ${path.join(dest, f)}`)
          await fs.rename(path.join(src, f), path.join(dest, f))
          moved.push(f)
        }
        await fs.rmdir(src)
      } catch (e) {
        await fs.mkdir(src, { recursive: true })
        for (const f of moved.reverse()) await fs.rename(path.join(dest, f), path.join(src, f))
        throw e
      }
      return { src, dest, merge: true, moved }
    },
    async undo({ src, dest, merge, moved }, { fs }) {
      if (!merge) return fs.rename(dest, src)
      await fs.mkdir(src, { recursive: true })
      for (const f of moved) await fs.rename(path.join(dest, f), path.join(src, f))
    },
  },

  db: {
    async run({ from, to, folders }, { deps }) {
      const moves = [{ from, to }]
      const changes = []
      const db = deps.openStore()
      try {
        db.exec('BEGIN')
        try {
          const plan = (table, keyCol, cols, map) => {
            for (const r of db.prepare(`SELECT ${[keyCol, ...cols].join(', ')} FROM ${table}`).all()) {
              for (const col of cols) {
                const next = map(r[col])
                if (next != null && next !== r[col]) changes.push({ table, keyCol, key: r[keyCol], col, old: r[col], new: next })
              }
            }
          }
          plan('sessions', 'session_id', ['project_dir', 'cwd', 'base_dir'], (p) => resolveMovedPath(p, moves))
          plan('sessions', 'session_id', ['raw_ref'], (p) => underFolder(p, folders))
          plan('subagents', 'agent_id', ['raw_ref'], (p) => underFolder(p, folders))
          plan('ingest_state', 'path', ['path'], (p) => underFolder(p, folders))
          for (const c of changes) db.prepare(`UPDATE ${c.table} SET ${c.col} = ? WHERE ${c.keyCol} = ?`).run(c.new, c.key)
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
      } finally { db.close?.() }
      return { changes }
    },
    async undo({ changes }, { deps }) {
      const db = deps.openStore()
      try {
        db.exec('BEGIN')
        try {
          for (const c of [...changes].reverse()) {
            db.prepare(`UPDATE ${c.table} SET ${c.col} = ? WHERE ${c.keyCol} = ?`).run(c.old, c.keyCol === c.col ? c.new : c.key)
          }
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
      } finally { db.close?.() }
    },
  },

  'usage-cache': {
    async run({ folders }, { fs, stateOpts }) {
      const file = dataFile('usage-cache.json', stateOpts)
      let text
      try { text = await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return { file, renames: [] }; throw e }
      const cache = JSON.parse(text)
      const renames = []
      const files = rekey(cache.files || {}, (k) => { const n = underFolder(k, folders); if (n) renames.push([k, n]); return n })
      if (renames.length) await atomicWrite(fs, file, JSON.stringify({ ...cache, files }))
      return { file, renames }
    },
    async undo({ file, renames }, { fs }) {
      if (!renames.length) return
      const back = new Map(renames.map(([o, n]) => [n, o]))
      const cache = JSON.parse(await fs.readFile(file, 'utf8'))
      await atomicWrite(fs, file, JSON.stringify({ ...cache, files: rekey(cache.files || {}, (k) => back.get(k)) }))
    },
  },

  alias: {
    async run({ from, to }, { fs, stateOpts, id, at }) {
      const file = dataFile(PATH_MOVES_FILE, stateOpts)
      const existed = await exists(fs, file)
      await appendPathMove({ id, from, to, at }, { file })
      return { file, id, existed }
    },
    async undo({ file, id, existed }, { fs }) {
      if (existed) await removePathMove(id, { file })
      else await fs.unlink(file)
    },
  },

  ledger: {
    async run({ from, to }, { fs, stateOpts }) {
      const file = ledgerFile(stateOpts)
      const moves = [{ from, to }]
      const text = await fs.readFile(file, 'utf8')
      const restore = []
      const lines = text.split('\n').map((line) => {
        if (!line.trim()) return line
        let row
        try { row = JSON.parse(line) } catch { return line }
        if (typeof row?.directory !== 'string') return line
        const next = { ...row, directory: resolveMovedPath(row.directory, moves) }
        if (row.checkout) next.checkout = { ...row.checkout, root: resolveMovedPath(row.checkout.root, moves), ...(row.checkout.main ? { main: resolveMovedPath(row.checkout.main, moves) } : {}) }
        const out = JSON.stringify(next)
        if (out === JSON.stringify(row)) return line
        restore.push([next.directory, line])
        return out
      })
      if (restore.length) await atomicWrite(fs, file, lines.join('\n'))
      return { file, restore }
    },
    async undo({ file, restore }, { fs }) {
      if (!restore.length) return
      const back = new Map(restore)
      const text = await fs.readFile(file, 'utf8')
      await atomicWrite(fs, file, text.split('\n').map((line) => {
        try { const d = JSON.parse(line)?.directory; return back.has(d) ? back.get(d) : line } catch { return line }
      }).join('\n'))
    },
  },
}

function contextOf(deps, extra = {}) {
  return { deps, fs: deps.fs, stat: deps.stat ?? deps.fs.stat, stateOpts: deps.stateOpts ?? {}, ...extra }
}

async function writeJournal(fs, file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(fs, file, JSON.stringify(value, null, 2))
}

// Undo `journal.done` in reverse, popping each record once it is undone, so a
// failed rollback can be resumed from the journal. → true when all undone.
async function rollback(journal, file, ctx) {
  while (journal.done.length) {
    const rec = journal.done[journal.done.length - 1]
    try { await STEPS[rec.kind].undo(rec.undo, ctx) } catch (e) {
      journal.status = 'rollback-failed'
      journal.rollback_error = `${rec.kind}: ${e.message}`
      await writeJournal(ctx.fs, file, journal)
      return false
    }
    journal.done.pop()
    await writeJournal(ctx.fs, file, journal)
  }
  journal.status = 'rolled-back'
  await writeJournal(ctx.fs, file, journal)
  return true
}

/** Another writer of the session store or the ledger is busy → a reason, else null. */
async function busyReason(deps) {
  const db = deps.openStore()
  try {
    const since = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString()
    const job = db.prepare("SELECT job_id FROM summary_jobs WHERE status = 'running' AND heartbeat_at >= ?").get(since)
    if (job) return 'a summary batch is running'
  } finally { db.close?.() }
  if (await deps.analysisRunning?.()) return 'an AI analysis batch is running'
  return null
}

const kindsOf = (done) => done.map(d => d.kind)

export async function executeRelocation({ from, to, planHash, force = false }, deps) {
  const plan = await planRelocation({ from, to, force }, deps)
  if (!plan.ok) return { ok: false, done: [], failed: { kind: 'plan', error: plan.blockers.join('; ') }, rolledBack: false }
  if (plan.planHash !== planHash) return { ok: false, done: [], failed: { kind: 'plan', error: 'plan changed since the dry-run, review it again' }, rolledBack: false }
  const runExclusive = deps.runExclusive ?? ((fn) => fn())
  return runExclusive(async () => {
    const busy = await busyReason(deps)
    if (busy) return { ok: false, done: [], failed: { kind: 'lock', error: `${busy}, try again when it finishes` }, rolledBack: false }

    const at = deps.now?.() ?? new Date().toISOString()
    const id = createHash('sha256').update(`${plan.planHash}:${at}:${Math.random()}`).digest('hex').slice(0, 8)
    const ctx = contextOf(deps, { id, at })
    const file = dataFile(path.join('relocations', `${at.replace(/[:.]/g, '-')}-${id}.json`), ctx.stateOpts)
    const journal = { plan, done: [], status: 'running' }
    await writeJournal(ctx.fs, file, journal)

    for (const step of plan.steps) {
      try {
        const undo = await STEPS[step.kind].run(step.detail, ctx)
        journal.done.push({ kind: step.kind, undo })
        await writeJournal(ctx.fs, file, journal)
        if (deps.failAt === step.kind) throw new Error('injected')
      } catch (e) {
        const doneKinds = kindsOf(journal.done)
        journal.error = `${step.kind}: ${e.message}`
        const rolledBack = await rollback(journal, file, ctx)
        return { ok: false, done: doneKinds, failed: { kind: step.kind, error: e.message }, rolledBack, journal: file }
      }
      if (deps.crashAt === step.kind) throw new Error(`simulated crash after ${step.kind}`) // test-only: dies without rollback
    }
    journal.status = 'ok'
    await writeJournal(ctx.fs, file, journal)
    return { ok: true, done: kindsOf(journal.done), rolledBack: false, journal: file }
  })
}

/**
 * Roll back the steps a journal still lists as done (a crash mid-run, or a
 * rollback that failed and was fixed by hand). Resuming forwards is not supported.
 */
export async function resumeRelocation(journalFile, deps) {
  const ctx = contextOf(deps)
  const journal = JSON.parse(await ctx.fs.readFile(journalFile, 'utf8'))
  if (journal.status === 'ok' || journal.status === 'rolled-back') {
    return { ok: false, rolledBack: false, error: `journal is already ${journal.status}`, journal: journalFile }
  }
  const runExclusive = deps.runExclusive ?? ((fn) => fn())
  return runExclusive(async () => {
    const undone = kindsOf(journal.done)
    const rolledBack = await rollback(journal, journalFile, ctx)
    return { ok: rolledBack, rolledBack, undone, journal: journalFile }
  })
}

// ── real dependencies ────────────────────────────────────────────────────────

/**
 * The real deps for plan/execute, loaded at call time. `base` is the repo root
 * for the CLI (state-dir resolution), omitted inside the Next server.
 */
export async function defaultRelocateDeps({ base } = {}) {
  const [{ execFile }, { promisify }, fsp, os, { loadRegistry }, { openStore, DB_NAME }, { runExclusive }, { runUsageExclusive }, { collectProjectProcesses }, { getAnalysisStatus }] = await Promise.all([
    import('node:child_process'), import('node:util'), import('node:fs/promises'), import('node:os'),
    import('./registry/registry.mjs'), import('./cc/store.mjs'), import('./cc/ingest-run.mjs'), import('./usage.mjs'),
    import('./processes.mjs'), import('./analyze-batch.mjs'),
  ])
  const stateOpts = base ? { base } : {}
  const execFileP = promisify(execFile)
  const rows = []
  try {
    for (const line of (await fsp.readFile(ledgerFile(stateOpts), 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* skip malformed line */ }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const dbFile = dataFile(DB_NAME, stateOpts)
  const under = (p, dir) => typeof p === 'string' && (p === dir || p.startsWith(dir + '/'))
  return {
    fs: fsp, stat: fsp.stat,
    exec: (cmd, args) => execFileP(cmd, args),
    claudeDir: process.env.CC_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects'),
    register: await loadRegistry(stateOpts),
    // Earlier moves: their Claude folders hold transcripts with the old cwd.
    moves: await loadPathMoves(stateOpts),
    rows,
    stateOpts,
    openStore: () => openStore(dbFile),
    // In this process: no session ingest and no usage refresh while the move runs.
    runExclusive: (fn) => runExclusive(() => runUsageExclusive(fn)),
    analysisRunning: () => getAnalysisStatus().running,
    processesUnder: async (dir) => (await collectProjectProcesses([dir])).projects[dir]?.length ?? 0,
    store: {
      async count(from) {
        const db = openStore(dbFile)
        try { return db.prepare('SELECT project_dir, cwd FROM sessions').all().filter(r => under(r.project_dir, from) || under(r.cwd, from)).length }
        finally { db.close() }
      },
    },
    usageCache: {
      async keysUnder(dirs) {
        try {
          const cache = JSON.parse(await fsp.readFile(dataFile('usage-cache.json', stateOpts), 'utf8'))
          return Object.keys(cache.files || {}).filter(k => dirs.some(d => k.startsWith(d + '/')))
        } catch { return [] }
      },
    },
  }
}
