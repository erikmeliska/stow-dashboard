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
  for (const c of await findClaudeProjectDirs(deps.claudeDir, from, { fs })) {
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
  warnings.push('~/.claude.json per-project settings (trust, allowed tools, MCP) are keyed by path and are not migrated')

  // What will happen (kinds + details), not the informational counts in the descriptions.
  const planHash = createHash('sha256').update(JSON.stringify({ from, to, steps: steps.map(s => [s.kind, s.detail]) })).digest('hex')
  return { ok: blockers.length === 0, from, to, blockers, warnings, steps, planHash }
}
