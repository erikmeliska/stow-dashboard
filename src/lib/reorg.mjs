/**
 * Reorg report over the virtual-project register (#11). Pure apart from the
 * injectable `exists`: it reads only what the scanner and the refresh cycle
 * already keep (register from loadRegistry, ledger rows), so it stays cheap.
 *
 * Four kinds, each with a virtual default action (see reorg-apply.mjs):
 *   client-placement  client resolved, primary checkout not under _Bizz/<client> → confirm-client
 *   stale-copy        old, clean non-primary checkout                            → set-role stale
 *   abandoned         experiment with a dead / archive-candidate status          → archive-project
 *   orphan            every location gone from disk (stale ledger rows)           → remove-project
 * A physical `move` ({from,to}) is only an optional alternative for the first
 * and third; relocate.mjs plans and runs it.
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { locationOf } from './registry/identity.mjs'
import { bizzClient, clientKey } from './registry/client.mjs'

export const KINDS = ['client-placement', 'stale-copy', 'abandoned', 'orphan']
export const STALE_COPY_MONTHS = 6
const MONTH_MS = 30.44 * 864e5
const EXPERIMENT_MATURITY = new Set(['idea', 'prototype', 'abandoned-wip'])
const ABANDONED_STATUS = new Set(['dead', 'archive-candidate'])

/** Stable JSON with sorted keys: the dismissal fingerprint of a suggestion's evidence. */
export function fingerprintOf(evidence) {
  const sort = (v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v
  return JSON.stringify(sort(evidence) ?? null)
}

const lastActivity = (r) => Math.max(0, ...[r?.git_info?.last_total_commit_date, r?.last_modified]
  .map(d => Date.parse(d)).filter(Number.isFinite))
const isoOrNull = (t) => (t ? new Date(t).toISOString() : null)
const under = (dir, parent) => dir === parent || dir.startsWith(parent + '/')
// Already physically archived: a path segment `_Archive` / `_Archives`.
const ARCHIVED_PATH = /\/_Archives?(\/|$)/i

// `_Bizz/<folder>` path of a directory, e.g. /P/_Bizz/Acme/x → /P/_Bizz/Acme.
function bizzFolderOf(dir) {
  const m = dir.match(/^(.*\/_Bizz\/[^/]+)(?:\/|$)/)
  return m ? m[1] : null
}

/**
 * Is a project archived? Every location still on disk carries a manual
 * `stale` role (#11 ruling: no project flag in #8). Vanished locations can't
 * be written, so they don't count.
 */
export function isArchived(project, exists = existsSync) {
  const live = (project.locations || []).filter(l => exists(l.directory))
  return live.length > 0 && live.every(l => l.role === 'stale' && l.role_source === 'manual')
}

// Gone, not merely unreachable: the folder is missing but its parent exists
// (an unmounted volume or an offline share has no parent either).
const deleted = (dir, exists) => !exists(dir) && exists(path.dirname(dir))

export function buildReorgReport({
  register, rows, baseDir, runningDirs = [], dismissed = {},
  staleMonths = STALE_COPY_MONTHS, exists = existsSync, config = { clients: [] },
}) {
  // One row per checkout root: the root's own row, else its shallowest member.
  const rootRow = new Map()
  for (const r of rows || []) {
    if (!r || typeof r.directory !== 'string') continue
    const root = locationOf(r)
    const cur = rootRow.get(root)
    if (!cur || (r.directory === root && cur.directory !== root) ||
      (cur.directory !== root && r.directory.length < cur.directory.length)) rootRow.set(root, r)
  }
  // Existing _Bizz/<folder> per client key, so a move reuses the folder already on disk.
  const bizzFolders = new Map()
  for (const r of rows || []) {
    const folder = typeof r?.directory === 'string' && bizzFolderOf(r.directory)
    if (folder && !bizzFolders.has(clientKey(bizzClient(r.directory)))) bizzFolders.set(clientKey(bizzClient(r.directory)), folder)
  }
  // Client id → every key that counts as "its" _Bizz folder (the id + registry.json aliases).
  const aliasKeys = new Map()
  for (const c of config?.clients || []) {
    const k = clientKey(c.name)
    aliasKeys.set(k, new Set([k, ...(c.aliases || []).map(clientKey)]))
  }
  const keysOf = (client) => aliasKeys.get(client.id) || new Set([client.id])

  const running = (dir) => runningDirs.some(d => under(d, dir))
  const out = []
  const push = (s, sortKey) => out.push({ ...s, id: `${s.kind}:${s.projectId}:${s.location ?? ''}`, fingerprint: fingerprintOf(s.evidence), sortKey })
  let unassigned = 0

  for (const p of register?.projects || []) {
    if (!p.client) unassigned++
    const locs = p.locations || []
    const dirs = locs.map(l => l.directory)
    const base = { projectId: p.key, projectName: p.name ?? null }

    if (!locs.length || locs.every(l => deleted(l.directory, exists))) {
      push({ ...base, kind: 'orphan', location: null,
        reason: 'Every checkout of this project was deleted from disk',
        evidence: { directories: dirs, manualClient: p.client?.source === 'manual', manualRoles: locs.some(l => l.role_source === 'manual') },
        action: { type: 'remove-project', directories: dirs }, move: null }, p.name ?? '')
      continue
    }
    if (locs.every(l => !exists(l.directory))) continue // unreachable (offline volume): nothing to suggest

    const primaryDir = p.primary ?? dirs[0]
    const primary = locs.find(l => l.directory === primaryDir) ?? locs[0]
    const pRow = rootRow.get(primary.directory)

    const c = p.client
    if (c && c.source !== 'manual' && !(c.source === 'ai' && pRow?.ai_analysis?.confidence === 'low')) {
      const placed = keysOf(c).has(clientKey(bizzClient(primary.directory)))
      if (!placed) {
        const folder = bizzFolders.get(c.id) ?? [...keysOf(c)].map(k => bizzFolders.get(k)).find(Boolean) ?? path.join(baseDir, '_Bizz', c.name)
        const to = path.join(folder, path.basename(primary.directory))
        push({ ...base, kind: 'client-placement', location: primary.directory,
          reason: `Client ${c.name} (${c.source}), but not under _Bizz/${path.basename(folder)}`,
          evidence: { client: c.name, source: c.source, directory: primary.directory },
          action: { type: 'confirm-client', client: c.name, directory: primary.directory },
          move: exists(to) ? null : { from: primary.directory, to } }, -(pRow?.scc?.total_code ?? 0))
      }
    }

    for (const l of locs) {
      // A manual role is the user's decision; a deploy checkout looks stale by design.
      if (l === primary || l.role_source === 'manual' || l.role === 'deploy') continue
      const r = rootRow.get(l.directory)
      if (!r || !pRow || !exists(l.directory)) continue
      const gi = r.git_info || {}
      const safe = r.checkout?.git
        ? (gi.uncommitted_changes ?? 1) === 0 && (gi.ahead ?? 1) === 0
        : r.content_size_bytes === pRow.content_size_bytes && fingerprintOf(r.file_types) === fingerprintOf(pRow.file_types)
      const gap = (lastActivity(pRow) - lastActivity(r)) / MONTH_MS
      if (!safe || gap < staleMonths) continue
      push({ ...base, kind: 'stale-copy', location: l.directory,
        reason: `Clean copy, ${Math.round(gap)} months behind the primary`,
        evidence: { behind: gi.behind ?? null, ahead: gi.ahead ?? null, uncommitted: gi.uncommitted_changes ?? null,
          lastActivity: isoOrNull(lastActivity(r)), primaryLastActivity: isoOrNull(lastActivity(pRow)) },
        action: { type: 'set-role', directory: l.directory, role: 'stale' }, move: null }, -gap)
    }

    const ai = pRow?.ai_analysis
    const status = pRow?.ai_derived?.status
    const experiment = primary.role === 'experiment' || EXPERIMENT_MATURITY.has(ai?.maturity) || ai?.project_type === 'prototype-poc'
    if (!isArchived(p, exists) && !ARCHIVED_PATH.test(primary.directory) && experiment && ABANDONED_STATUS.has(status) && !locs.some(l => running(l.directory))) {
      const archive = ['_Archive', '_Archives'].map(n => path.join(baseDir, n)).find(d => exists(d)) ?? path.join(baseDir, '_Archive')
      const to = path.join(archive, path.basename(primary.directory))
      push({ ...base, kind: 'abandoned', location: primary.directory,
        reason: `Experiment, ${status}`,
        evidence: { status, maturity: ai?.maturity ?? null, role: primary.role ?? null, code: pRow.scc?.total_code ?? 0 },
        action: { type: 'archive-project', directories: dirs },
        move: under(primary.directory, archive) || exists(to) ? null : { from: primary.directory, to } }, pRow.scc?.total_code ?? 0)
    }
  }

  out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    (typeof a.sortKey === 'string' ? a.sortKey.localeCompare(b.sortKey) : a.sortKey - b.sortKey) ||
    a.id.localeCompare(b.id))
  const visible = []
  for (const s of out) {
    delete s.sortKey
    if (dismissed[s.id]?.fingerprint !== s.fingerprint) visible.push(s)
  }
  const summary = { 'client-placement': 0, 'stale-copy': 0, abandoned: 0, orphan: 0, unassigned }
  for (const s of visible) summary[s.kind]++
  return { suggestions: visible, dismissedCount: out.length - visible.length, summary }
}
