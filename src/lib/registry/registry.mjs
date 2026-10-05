/**
 * The virtual-project register (#8): Client → Project → Location over the
 * scanned ledger. buildRegistry is pure — callers pass the ledger rows, the
 * per-directory .stow metas and the data/registry.json config. Nothing on
 * disk moves; this is a view.
 */
import path from 'node:path'
import { identityOf, remoteOwner } from './identity.mjs'
import { buildClientCatalog, bizzClient, cleanClientName } from './client.mjs'

export const STALE_DAYS = 180
const DAY_MS = 86400000
const STALE_RE = /(^|[-_.\s])(old|backup|bak|archive)([-_.\s]|$)/i
const DEPLOY_RE = /(^|[-_.\s])(prod|production|deploy|live)([-_.\s]|$)/i

function activityOf(record) {
  const t = Date.parse(record.last_code_modified || record.last_modified || '')
  return Number.isFinite(t) ? t : null
}

export function deriveRole(directory, activityMs, now = Date.now()) {
  const base = path.basename(directory || '')
  if (STALE_RE.test(base)) return 'stale'
  if (DEPLOY_RE.test(base)) return 'deploy'
  if (activityMs == null || now - activityMs > STALE_DAYS * DAY_MS) return 'stale'
  return 'experiment'
}

// Most recent first; tie → shorter path, then lexical — deterministic.
const byActivity = (a, b) =>
  (b.last_activity ?? -Infinity) - (a.last_activity ?? -Infinity) ||
  a.directory.length - b.directory.length ||
  a.directory.localeCompare(b.directory)

export function buildRegistry(records, { metas = new Map(), config = { clients: [] }, now = Date.now() } = {}) {
  const metaOf = dir => metas.get(dir) || { meta: null, warnings: [] }

  const groups = new Map()
  for (const record of records) {
    if (!record || typeof record.directory !== 'string') continue
    const { meta } = metaOf(record.directory)
    const id = identityOf(record, meta)
    let g = groups.get(id.key)
    if (!g) groups.set(id.key, g = { ...id, rows: [] })
    g.rows.push(record)
  }

  const bizz = [], seen = []
  for (const r of records) {
    if (!r || typeof r.directory !== 'string') continue
    const b = bizzClient(r.directory); if (b) bizz.push(b)
    const m = metaOf(r.directory).meta; if (m?.client) seen.push(m.client)
    const ai = cleanClientName(r.ai_analysis?.client); if (ai) seen.push(ai)
  }
  const catalog = buildClientCatalog({ config, names: { bizz, seen } })

  const projects = []
  for (const g of groups.values()) {
    const warnings = []
    const locs = g.rows.map(r => {
      const { meta, warnings: w } = metaOf(r.directory)
      for (const x of w) warnings.push(`${r.directory}: ${x}`)
      return { record: r, meta, directory: r.directory, record_id: r.id ?? null, stow_id: meta?.id ?? null, last_activity: activityOf(r) }
    })

    const manualPrimaries = locs.filter(l => l.meta?.role === 'primary').sort(byActivity)
    if (manualPrimaries.length > 1) warnings.push('multiple-primary')
    const unroled = locs.filter(l => !l.meta?.role)
    const primary = manualPrimaries[0] || [...(unroled.length ? unroled : locs)].sort(byActivity)[0]

    for (const l of locs) {
      if (l.meta?.role) { l.role = l.meta.role; l.role_source = 'manual' }
      else if (l === primary) { l.role = 'primary'; l.role_source = 'derived' }
      else { l.role = deriveRole(l.directory, l.last_activity, now); l.role_source = 'derived' }
    }
    const ordered = [primary, ...locs.filter(l => l !== primary).sort(byActivity)]

    let client = null
    const pick = (source, name) => {
      if (client || !name) return
      const c = catalog.lookup(name)
      if (c) client = { ...c, source }
    }
    for (const l of ordered) pick('manual', l.meta?.client)
    for (const l of ordered) pick('ai', cleanClientName(l.record.ai_analysis?.client))
    pick('owner', remoteOwner(g.remote))
    for (const l of ordered) pick('path', bizzClient(l.directory))

    const name = g.kind === 'git'
      ? g.remote.split('/').pop()
      : primary.record.project_name || path.basename(primary.directory)

    projects.push({
      key: g.key, kind: g.kind, name, remote: g.remote, client,
      primary: primary.directory,
      locations: ordered.map(({ directory, record_id, stow_id, role, role_source, last_activity }) =>
        ({ directory, record_id, stow_id, role, role_source, last_activity })),
      warnings,
    })
  }

  // Unassigned last; then client name, project name, key.
  projects.sort((a, b) =>
    (a.client ? 0 : 1) - (b.client ? 0 : 1) ||
    (a.client?.name || '').localeCompare(b.client?.name || '') ||
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key))

  const clientMap = new Map()
  for (const p of projects) {
    if (!p.client) continue
    let c = clientMap.get(p.client.id)
    if (!c) clientMap.set(p.client.id, c = { id: p.client.id, name: p.client.name, projects: [] })
    c.projects.push(p.key)
  }
  const clients = [...clientMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  const count = (obj, k) => { obj[k] = (obj[k] || 0) + 1 }
  const stats = { records: records.length, projects: projects.length, multi_location: 0, locations_in_multi: 0, unassigned: 0, by_kind: {}, by_client_source: {} }
  for (const p of projects) {
    if (p.locations.length > 1) { stats.multi_location++; stats.locations_in_multi += p.locations.length }
    if (!p.client) stats.unassigned++
    else count(stats.by_client_source, p.client.source)
    count(stats.by_kind, p.kind)
  }
  return { clients, projects, stats }
}
