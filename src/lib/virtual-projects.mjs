/**
 * Virtual projects (Client → Project → Locations) for the projects page (#10).
 * Pure and client-safe. The server stamps each ledger record with `vp` from
 * the register (#8/#9) via `annotateRecords`; `locationMeta` is the only
 * reader of those fields — change it, not the callers, if they move.
 * A location is a checkout root (#9): rows inside one checkout are its
 * members, so a project row's sub-rows are one record per checkout.
 */

export const ROLES = ['primary', 'deploy', 'experiment', 'stale']
export const UNASSIGNED = '__unassigned__'

const rootOf = record => record?.checkout?.root || record?.directory

/**
 * Copy the register's project/client/location/role onto each ledger record
 * as `record.vp`. Records the register doesn't know (scanned after it was
 * built) are returned untouched and fall back in `locationMeta`.
 */
export function annotateRecords(records, registry) {
  if (!registry?.projects) return records
  const byLocation = new Map()
  for (const p of registry.projects) {
    for (const l of p.locations || []) byLocation.set(l.directory, { p, l })
  }
  return records.map(r => {
    const hit = byLocation.get(rootOf(r))
    if (!hit) return r
    const { p, l } = hit
    return {
      ...r,
      vp: {
        project_id: p.key,
        client: p.client?.name ?? null,
        client_source: p.client?.source ?? null,
        location: l.directory,
        role: l.role ?? null,
        role_source: l.role_source ?? null,
        primary: p.primary === l.directory,
        members: l.members ?? 1,
      },
    }
  })
}

export function locationMeta(record) {
  const vp = record?.vp || {}
  const client = typeof vp.client === 'string' && vp.client.trim() ? vp.client.trim() : null
  return {
    projectId: vp.project_id || record?.project_id || `dir:${record?.directory}`,
    location: vp.location || rootOf(record),
    client,
    clientSource: client ? (vp.client_source || null) : null,
    role: ROLES.includes(vp.role) ? vp.role : null,
    primary: vp.primary === true,
  }
}

function time(r) {
  const t = Date.parse(r?.last_modified)
  return Number.isNaN(t) ? -Infinity : t
}

const byDir = (a, b) => a.directory.localeCompare(b.directory)

export function pickPrimary(locations) {
  const primaries = locations.filter(l => locationMeta(l).role === 'primary').sort(byDir)
  const conflict = primaries.length > 1
  const flagged = locations.find(l => locationMeta(l).primary)
  if (flagged) return { primary: flagged, conflict }
  if (primaries.length) return { primary: primaries[0], conflict }
  const newest = [...locations].sort((a, b) => time(b) - time(a) || byDir(a, b))[0]
  return { primary: newest, conflict: false }
}

export function sumUsage(usages) {
  const present = usages.filter(Boolean)
  if (!present.length) return undefined
  const out = { costUsd: 0, sessions: 0, activeMinutes: 0, tokens: {}, unpricedModels: [] }
  const unpriced = new Set()
  for (const u of present) {
    out.costUsd += u.costUsd || 0
    out.sessions += u.sessions || 0
    out.activeMinutes += u.activeMinutes || 0
    for (const [k, v] of Object.entries(u.tokens || {})) {
      if (typeof v === 'number') out.tokens[k] = (out.tokens[k] || 0) + v
    }
    for (const m of u.unpricedModels || []) unpriced.add(m)
  }
  out.unpricedModels = [...unpriced]
  return out
}

// One record speaks for a checkout: its root's own row, else the shallowest member.
function representative(members, root) {
  return members.find(r => r.directory === root) ||
    [...members].sort((a, b) => a.directory.length - b.directory.length || byDir(a, b))[0]
}

export function buildVirtualProjects(records) {
  const groups = new Map()
  for (const r of records || []) {
    const id = locationMeta(r).projectId
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(r)
  }
  const out = []
  for (const [vpId, rows] of groups) {
    const byRoot = new Map()
    for (const r of rows) {
      const root = locationMeta(r).location
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root).push(r)
    }
    // locationRoot: the checkout root edits target — a weak-only root's representative is a member row
    const reps = [...byRoot].map(([root, members]) => ({ ...representative(members, root), locationRoot: root, locationMembers: members.length }))
    const { primary, conflict } = pickPrimary(reps)
    const meta = locationMeta(primary)
    const newest = [...rows].sort((a, b) => time(b) - time(a))[0]
    out.push({
      ...primary,
      vpId,
      client: meta.client,
      clientSource: meta.clientSource,
      locations: [primary, ...reps.filter(l => l !== primary).sort(byDir)],
      copyCount: reps.length,
      recordCount: rows.length,
      roles: [...new Set(reps.map(l => locationMeta(l).role).filter(Boolean))].sort(),
      primaryConflict: conflict,
      last_modified: newest?.last_modified ?? primary.last_modified,
      usage: sumUsage(rows.map(l => l.usage)),
    })
  }
  return out
}

/** `pred` on every checkout of a project row, or on the row itself (directory view). */
export function anyLocation(row, pred) {
  return Array.isArray(row?.locations) ? row.locations.some(pred) : pred(row)
}

export const clientOf = row => (row.vpId ? row.client : locationMeta(row).client)
const rolesOf = row => (row.vpId ? row.roles : [locationMeta(row).role].filter(Boolean))
const copiesOf = row => (row.vpId ? row.copyCount : 1)

export function clientStats(rows) {
  const counts = new Map()
  let unassigned = 0
  for (const r of rows) {
    const c = clientOf(r)
    if (c) counts.set(c, (counts.get(c) || 0) + 1)
    else unassigned++
  }
  const out = [...counts]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([value, count]) => ({ value, label: value, count }))
  if (unassigned) out.push({ value: UNASSIGNED, label: 'Unassigned', count: unassigned })
  return out
}

export function roleStats(rows) {
  return ROLES
    .map(role => ({ value: role, label: role, count: rows.filter(r => rolesOf(r).includes(role)).length }))
    .filter(s => s.count > 0)
}

export function filterVirtual(rows, { clients = [], roles = [], multiCopy = null } = {}) {
  return rows.filter(r => {
    if (clients.length && !clients.includes(clientOf(r) ?? UNASSIGNED)) return false
    if (roles.length && !rolesOf(r).some(x => roles.includes(x))) return false
    if (multiCopy !== null && (copiesOf(r) > 1) !== multiCopy) return false
    return true
  })
}

/** Keep only values still in `stats`; the same array when nothing changed (no effect loop). */
export function pruneSelection(selected, stats) {
  const present = new Set(stats.map(s => s.value))
  const kept = selected.filter(v => present.has(v))
  return kept.length === selected.length ? selected : kept
}

/** Case-insensitive; null (Unassigned) sorts last regardless of `desc`. */
export function compareClients(a, b, desc = false) {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  const c = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return desc ? -c : c
}

/**
 * TanStack `sortingFn` for the client column. TanStack negates a sortingFn
 * for a descending sort, so this one is pre-inverted to keep Unassigned
 * (null) last in both directions. Not `sortUndefined: 'last'`: that returns
 * 1 for two undefined values, so rows inside Unassigned never reach the
 * secondary sort key.
 */
export function clientSortingFn(desc = false) {
  return (rowA, rowB, columnId) => {
    const c = compareClients(rowA.getValue(columnId), rowB.getValue(columnId), !!desc)
    return desc ? -c : c
  }
}

/** Stable TanStack row id: project rows by project, records/checkouts by directory. */
export function virtualRowId(row) {
  return row.vpId ?? row.directory
}

/**
 * Interleave a header before the first row of each client run on the page.
 * Totals cover every filtered row of the client (`allRows`), not just the
 * page. `pageRows` are TanStack rows (`row.original` is the data); expanded
 * sub-rows (`depth > 0`) follow their parent without a header of their own.
 */
export function withClientHeaders(pageRows, allRows) {
  const totals = new Map()
  for (const r of allRows) {
    const k = clientOf(r) ?? UNASSIGNED
    const t = totals.get(k) || { count: 0, costUsd: 0, unpriced: false }
    t.count++
    t.costUsd += r.usage?.costUsd || 0
    if ((r.usage?.unpricedModels || []).length) t.unpriced = true
    totals.set(k, t)
  }
  const out = []
  let prev
  for (const row of pageRows) {
    if (row.depth > 0) { out.push({ type: 'row', row }); continue }
    const client = clientOf(row.original) ?? null
    const key = client ?? UNASSIGNED
    if (key !== prev) {
      out.push({ type: 'header', client, ...(totals.get(key) || { count: 0, costUsd: 0, unpriced: false }) })
      prev = key
    }
    out.push({ type: 'row', row })
  }
  return out
}

const CLIENT_MAX = 80

/**
 * Body of PATCH /api/projects/meta: `{projectId, client}` (client: 1–80 chars
 * after trim, or null = back to automatic) or `{directory, role}` (absolute
 * checkout root, role in ROLES or null = automatic). Exactly one shape.
 */
export function validateMetaPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' }
  const isClient = 'projectId' in body || 'client' in body
  const isRole = 'directory' in body || 'role' in body
  if (isClient === isRole) return { ok: false, error: 'send either {projectId, client} or {directory, role}' }
  if (isClient) {
    if (typeof body.projectId !== 'string' || !body.projectId) return { ok: false, error: 'projectId required' }
    if (!('client' in body)) return { ok: false, error: 'client required (null = automatic)' }
    if (body.client === null) return { ok: true, op: { kind: 'client', projectId: body.projectId, client: null } }
    const client = typeof body.client === 'string' ? body.client.trim() : ''
    if (!client || client.length > CLIENT_MAX) return { ok: false, error: `client must be 1–${CLIENT_MAX} characters` }
    return { ok: true, op: { kind: 'client', projectId: body.projectId, client } }
  }
  if (typeof body.directory !== 'string' || !body.directory.startsWith('/')) return { ok: false, error: 'directory must be an absolute path' }
  if (body.role !== null && !ROLES.includes(body.role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')} (null = automatic)` }
  return { ok: true, op: { kind: 'role', directory: body.directory, role: body.role } }
}
