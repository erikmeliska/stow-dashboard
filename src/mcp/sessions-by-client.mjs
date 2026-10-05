/**
 * Pure helpers behind the MCP client tools (#13): `list_clients` and
 * `list_client_projects` over the register (#8, `loadRegistry()` shape).
 * Unassigned projects are reported as client id 'unassigned'.
 */

import { resolveClient } from '../lib/cc/project-index.mjs'

const UNASSIGNED_ID = 'unassigned'
const round2 = (n) => Number(n.toFixed(2))

const pick = ({ key, name, remote, primary, locations }) => ({
  key, name, remote: remote ?? null, primary: primary ?? null,
  locations: (locations || []).map(({ directory, role }) => ({ directory, role })),
})

/**
 * @param sessionsByKey Map<project_key|null, { sessions, cost_usd }> for a period (empty = no session numbers).
 *   Keys the register doesn't know (or null) count toward Unassigned, so no session is dropped.
 */
export function clientsSummary(registry, sessionsByKey = new Map()) {
  const rows = new Map()
  const row = (id, name) => rows.get(id) || rows.set(id, { id, name, projects: 0, sessions: 0, cost_usd: 0 }).get(id)
  const owner = new Map()
  for (const p of registry?.projects || []) {
    const r = p.client?.id ? row(p.client.id, p.client.name) : row(UNASSIGNED_ID, 'Unassigned')
    r.projects++
    owner.set(p.key, r)
  }
  for (const [key, s] of sessionsByKey) {
    const r = owner.get(key) || row(UNASSIGNED_ID, 'Unassigned')
    r.sessions += s.sessions || 0
    r.cost_usd = round2(r.cost_usd + (s.cost_usd || 0))
  }
  return [...rows.values()].sort((a, b) =>
    (a.id === UNASSIGNED_ID) - (b.id === UNASSIGNED_ID) || b.cost_usd - a.cost_usd || a.name.localeCompare(b.name))
}

/** A client's projects (`client` = `{ id }` or 'unassigned') with their checkouts, by name. */
export function clientProjects(registry, client) {
  const want = client === UNASSIGNED_ID ? null : client?.id
  return (registry?.projects || [])
    .filter((p) => (p.client?.id ?? null) === want)
    .map(pick)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A tool's `client` argument → `{ client }` (`{ id, name }` or 'unassigned'), or `{ error }`:
 * 'unavailable' when the register couldn't be loaded (so the client isn't blamed), 'unknown' otherwise.
 */
export function clientArg(registry, q) {
  const client = resolveClient(registry, q)
  if (client) return { client }
  return { error: registry ? 'unknown' : 'unavailable' }
}
