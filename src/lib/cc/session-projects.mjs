/**
 * Virtual-project view of sessions (#13): joins #12's `project_key` to #8's
 * register at read time (so a client reassignment shows without re-ingest),
 * parses #12's `workspace` (`kind:name`), and counts filter facets.
 * Pure and client-safe — the register itself is loaded server-side
 * (project-index.mjs) and only its index travels here.
 */
import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs'

export const UNASSIGNED = '__unassigned'

/** Workspace kinds #12 writes (workspace.mjs, project-key.mjs), in menu order. */
export const WORKSPACE_KINDS = {
  'agent-office': 'Agent Office',
  'claude-worktree': 'Claude worktree',
  'git-worktree': 'Git worktree',
  scratchpad: 'Scratchpad',
  other: 'Other',
}

/** Register (`loadRegistry()` shape) → Map<project_key, { project_key, project_name, client_id, client_name }>. */
export function projectIndex(registry) {
  const idx = new Map()
  for (const p of registry?.projects || []) {
    if (!p?.key) continue
    idx.set(p.key, { project_key: p.key, project_name: p.name, client_id: p.client?.id ?? null, client_name: p.client?.name ?? null })
  }
  return idx
}

/** New rows with `project_name`, `client_id` (null = unassigned) and `client_name`. A key the register doesn't know is unassigned. */
export function annotateSessions(rows, index = new Map()) {
  return (rows || []).map((r) => {
    const hit = r.project_key ? index?.get(r.project_key) : null
    return {
      ...r,
      project_name: hit?.project_name || sessionProjectLabel({ ...r, project_name: null }),
      client_id: hit?.client_id ?? null,
      client_name: hit?.client_name ?? null,
    }
  })
}

/** `null` = main checkout; else `{ kind, name, label, raw }`. Unknown kinds or shapes → kind 'other', shown verbatim. */
export function parseWorkspace(ws) {
  if (!ws) return null
  const i = ws.indexOf(':')
  const kind = i > 0 ? ws.slice(0, i) : null
  if (!kind || kind === 'other' || !WORKSPACE_KINDS[kind]) return { kind: 'other', name: ws, label: ws, raw: ws }
  const name = ws.slice(i + 1).trim()
  return { kind, name, label: `${WORKSPACE_KINDS[kind]} · ${name}`, raw: ws }
}

const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name)

/**
 * Filter-menu facets over (annotated) family rows, counted by root. Unassigned
 * lists last. Entries named in `keep` (the current selection) survive with
 * count 0 so a selection that left the loaded data can still be unticked.
 */
export function facetCounts(families, { keep = {} } = {}) {
  const clients = new Map(), projects = new Map(), kinds = new Map()
  let main = 0, worktrees = 0
  const addWs = (ws, n) => {
    const k = kinds.get(ws.kind) || { kind: ws.kind, label: WORKSPACE_KINDS[ws.kind], items: new Map() }
    const it = k.items.get(ws.raw) || { value: ws.raw, label: ws.name, count: 0 }
    it.count += n
    k.items.set(ws.raw, it)
    kinds.set(ws.kind, k)
  }
  for (const f of families || []) {
    const cid = f.client_id || UNASSIGNED
    const c = clients.get(cid) || { id: cid, name: f.client_name || 'Unassigned', count: 0 }
    c.count++
    clients.set(cid, c)
    const pk = sessionProjectKey(f) || '—'
    const p = projects.get(pk) || { key: pk, name: f.project_name || sessionProjectLabel(f), client_id: f.client_id ?? null, count: 0 }
    p.count++
    projects.set(pk, p)
    const ws = parseWorkspace(f.workspace)
    if (!ws) { main++; continue }
    worktrees++
    addWs(ws, 1)
  }
  for (const id of keep.clients || []) if (!clients.has(id)) clients.set(id, { id, name: id === UNASSIGNED ? 'Unassigned' : id, count: 0 })
  for (const key of keep.projects || []) if (!projects.has(key)) projects.set(key, { key, name: key, client_id: null, count: 0 })
  const kw = keep.workspace && !['any', 'main', 'worktrees'].includes(keep.workspace) ? parseWorkspace(keep.workspace) : null
  if (kw && !kinds.get(kw.kind)?.items.has(kw.raw)) addWs(kw, 0)
  const kindOrder = Object.keys(WORKSPACE_KINDS)
  return {
    clients: [...clients.values()].sort((a, b) => (a.id === UNASSIGNED) - (b.id === UNASSIGNED) || byCount(a, b)),
    projects: [...projects.values()].sort(byCount),
    workspaces: {
      main, worktrees,
      byKind: [...kinds.values()]
        .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))
        .map((k) => ({ ...k, items: [...k.items.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) })),
    },
  }
}
