/**
 * Register (#8) → the building/floor document agent-office reads (#14):
 * one building per client, one floor per project at its primary checkout.
 * buildAgentOfficeExport is pure apart from the injectable `exists`.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { clientKey } from './client.mjs'

export const EXPORT_FORMAT = 'stow-dashboard/agent-office'
export const EXPORT_VERSION = 1
export const UNASSIGNED_ID = 'unassigned'

// Worker worktrees are short-lived checkouts of a project, never its floor.
const WORKTREE_RE = /\/\.(?:agent-office|claude)\/worktrees\//

export function isWorktreePath(dir) {
  return WORKTREE_RE.test(dir + '/')
}

// Agent-office floors take a GitHub `owner/name` only; other hosts open by dir.
export function githubRepo(remote) {
  const m = /^github\.com\/([^/]+)\/([^/]+)/.exec(remote || '')
  return m ? `${m[1]}/${m[2]}` : null
}

// `<slug>-<6 hex of sha1(key)>`, ≤ 40 chars of [a-z0-9-] (agent-office's
// floor id rule). The key survives moves (#9), so the id does too.
export function floorId(name, key) {
  const hash = createHash('sha1').update(String(key)).digest('hex').slice(0, 6)
  const slug = String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 33).replace(/-+$/, '')
  return `${slug || 'project'}-${hash}`
}

const toMs = v => {
  if (v == null || v === '') return null
  const ms = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}
const newestFirst = (a, b) => (toMs(b.last_activity) ?? -1) - (toMs(a.last_activity) ?? -1)

function toFloor(p, exists, worktrees) {
  const live = p.locations.filter(l => !isWorktreePath(l.directory) && !worktrees.has(l.directory) && exists(l.directory))
  if (!live.length) return null
  // Keep the register's order (primary first); a dropped primary falls back
  // to the most recently active remaining checkout.
  const main = live.find(l => l.directory === p.primary) ?? [...live].sort(newestFirst)[0]
  const times = live.map(l => toMs(l.last_activity)).filter(t => t != null)
  return {
    id: floorId(p.name, p.key),
    name: p.name,
    project_key: p.key,
    dir: main.directory,
    repo: githubRepo(p.remote),
    remote: p.remote ?? null,
    last_activity: times.length ? new Date(Math.max(...times)).toISOString() : null,
    locations: [main, ...live.filter(l => l !== main)].map(l => ({ dir: l.directory, role: l.role })),
  }
}

const byActivityThenName = (a, b) =>
  (b.last_activity ?? '').localeCompare(a.last_activity ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/**
 * `worktrees` = checkout roots known to be linked git worktrees (the ledger's
 * `checkout.main`, #9); they are dropped like the two worktree path patterns.
 * Throws `code: 'UNKNOWN_CLIENT'` when `client` names no exported building.
 */
export function buildAgentOfficeExport(registry, { now = Date.now(), includeUnassigned = false, client, exists = existsSync, worktrees = new Set() } = {}) {
  const buildings = registry.clients.map(c => ({ id: c.id, name: c.name, keys: new Set(c.projects), floors: [] }))
  if (includeUnassigned) buildings.push({ id: UNASSIGNED_ID, name: 'Unassigned', keys: null, floors: [] })

  let wanted = buildings
  if (client != null) {
    const k = clientKey(client)
    wanted = buildings.filter(b => b.id === k || clientKey(b.name) === k)
    if (!k || !wanted.length) throw Object.assign(new Error(`Unknown client: ${client}`), { code: 'UNKNOWN_CLIENT' })
  }

  const skipped = []
  for (const p of registry.projects) {
    const b = wanted.find(b => (b.keys ? b.keys.has(p.key) : !p.client))
    if (!b) continue
    const floor = toFloor(p, exists, worktrees)
    if (floor) b.floors.push(floor)
    else skipped.push({ project_key: p.key, reason: 'no-location' })
  }

  const out = wanted.filter(b => b.floors.length)
    .map(b => ({ id: b.id, name: b.name, floors: b.floors.sort(byActivityThenName) }))
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generated_at: new Date(now).toISOString(),
    buildings: out,
    skipped,
    stats: { buildings: out.length, floors: out.reduce((n, b) => n + b.floors.length, 0), skipped: skipped.length },
  }
}
