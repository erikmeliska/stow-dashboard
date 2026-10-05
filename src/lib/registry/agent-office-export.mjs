/**
 * Register (#8) → the building/floor document agent-office reads (#14):
 * one building per client, one floor per project at its primary checkout.
 * buildAgentOfficeExport is pure apart from the injectable `exists`.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataFile, ledgerFile } from '../state-dir.mjs'
import { clientKey } from './client.mjs'
import { loadRegistry } from './registry.mjs'

export const EXPORT_FORMAT = 'stow-dashboard/agent-office'
export const EXPORT_VERSION = 1
export const UNASSIGNED_ID = 'unassigned'

// Worker worktrees are short-lived checkouts of a project, never its floor.
const WORKTREE_RE = /\/\.(?:agent-office|claude)\/worktrees\//
const WORKTREE_MAIN_RE = /^(.*)\/\.(?:agent-office|claude)\/worktrees\//

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

// The main work tree a worktree belongs to: the ledger's `checkout.main`, or
// the path in front of `.agent-office/worktrees` / `.claude/worktrees`.
const mainOf = (dir, worktrees) => worktrees.get(dir) ?? WORKTREE_MAIN_RE.exec(dir + '/')?.[1] ?? null

function toFloor(p, exists, worktrees) {
  const live = p.locations.filter(l => !isWorktreePath(l.directory) && !worktrees.has(l.directory) && exists(l.directory))
  if (!live.length) return null
  // Keep the register's order (primary first). A dropped primary falls back
  // to its own main checkout — the busy-worker case, where the main sits idle
  // — then to the most recently active remaining checkout.
  const owner = mainOf(p.primary, worktrees)
  const main = live.find(l => l.directory === p.primary) ?? live.find(l => l.directory === owner) ?? [...live].sort(newestFirst)[0]
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
 * `worktrees` = Map<checkout root, main work tree> of linked git worktrees
 * (the ledger's `checkout.main`, #9); they are dropped like the two worktree
 * path patterns. `filter` in the result says which subset was exported.
 * Throws `code: 'UNKNOWN_CLIENT'` when `client` names no exported building.
 */
export function buildAgentOfficeExport(registry, { now = Date.now(), includeUnassigned = false, client, exists = existsSync, worktrees = new Map() } = {}) {
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
    filter: { client: client != null ? wanted[0].id : null, unassigned: includeUnassigned },
    buildings: out,
    skipped,
    stats: { buildings: out.length, floors: out.reduce((n, b) => n + b.floors.length, 0), skipped: skipped.length },
  }
}

export const EXPORT_FILE = 'agent-office.json'

/** Map<root, main> of checkouts the scanner (#9) recorded as linked git worktrees. */
export function linkedWorktreeRoots(records) {
  const roots = new Map()
  for (const r of records) {
    const c = r?.checkout
    if (c?.root && c.main && c.main !== c.root) roots.set(c.root, c.main)
  }
  return roots
}

async function readLinkedWorktrees(opts) {
  let text
  try { text = await readFile(ledgerFile(opts), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return new Map()
    throw e
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* skip malformed line */ }
  }
  return linkedWorktreeRoots(rows)
}

/**
 * loadRegistry → build → (write) data/agent-office.json via tmp + rename, so
 * a failed run leaves the previous file intact. `write: false` only builds.
 */
export async function exportAgentOffice({ base, includeUnassigned = false, client, write = true, now = Date.now(), load = loadRegistry, exists } = {}) {
  const opts = base ? { base } : {}
  const [registry, worktrees] = await Promise.all([load(opts), readLinkedWorktrees(opts)])
  const doc = buildAgentOfficeExport(registry, { now, includeUnassigned, client, worktrees, ...(exists ? { exists } : {}) })
  if (!write) return { doc, file: null }
  const file = dataFile(EXPORT_FILE, opts)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n')
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return { doc, file }
}
