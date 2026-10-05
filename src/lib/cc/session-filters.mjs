/**
 * Client-side filters for the /sessions table. Pure over the family rows the
 * page builds (session-tree.mjs) — no extra queries. Works on plain session
 * rows too: rollup/agents/children fall back to the row's own fields.
 */

import { displayTitle } from './summary-view.mjs'
import { sessionProjectKey } from './session-project.mjs'
import { UNASSIGNED } from './session-projects.mjs'

/** Menu order matters: rendered top-to-bottom in the quality <select>. */
export const QUALITY_FILTERS = {
  any: { label: 'Quality: any', test: () => true },
  q90: { label: '≥ 90', test: (s) => s.quality_score != null && s.quality_score >= 90 },
  q75: { label: '≥ 75', test: (s) => s.quality_score != null && s.quality_score >= 75 },
  q50: { label: '≥ 50', test: (s) => s.quality_score != null && s.quality_score >= 50 },
  low: { label: '< 50', test: (s) => s.quality_score != null && s.quality_score < 50 },
  unscored: { label: 'Unscored', test: (s) => s.quality_score == null },
}

/** Entrypoint → coarse source bucket shown in the Source filter. */
export function sourceOf(s) {
  const e = s?.entrypoint || ''
  if (e.startsWith('codex')) return 'codex'
  if (e.startsWith('antigravity')) return 'antigravity'
  if (e.startsWith('sdk')) return 'sdk'
  if (e === 'claude-desktop') return 'desktop'
  if (e === 'cli') return 'cli'
  return 'other'
}

export const SOURCE_FILTERS = {
  any: 'Source: any', cli: 'CLI', desktop: 'Desktop app', sdk: 'SDK / hooks', antigravity: 'Antigravity', codex: 'Codex', other: 'Other',
}

const ACTIVE_MS = 10 * 60 * 1000
const EXPENSIVE_USD = 50
const LONG_S = 2 * 60 * 60

/**
 * Quick filters (on/off chips). Each `test` gets a family row; `rollup` is used
 * where present so "expensive" means the whole package.
 */
export const QUICK_FILTERS = {
  subs: { label: 'Has subagents', title: 'Nested agents or linked sessions', test: (f) => (f.sub_count || 0) > 0 },
  guard: { label: 'Guard hits', title: 'At least one cc-guard hit', test: (f) => (f.guard_hits || 0) > 0 },
  expensive: { label: `> $${EXPENSIVE_USD}`, title: 'Package cost above the threshold', test: (f) => ((f.rollup || f).cost_usd || 0) > EXPENSIVE_USD },
  long: { label: '> 2h active', title: 'Package active time above two hours', test: (f) => ((f.rollup || f).active_s || 0) > LONG_S },
  nosummary: { label: 'No summary', title: 'No AI summary generated yet', test: (f) => !f.summary },
  active: { label: 'Active now', title: 'Transcript written in the last 10 minutes', test: (f, now = Date.now()) => !!f.ended_at && now - Date.parse(f.ended_at) < ACTIVE_MS },
}

export function filterSessions(sessions, { search = '', ticket = '', quality = 'any', model = 'any', source = 'any', quick = [], clients = [], projects = [], workspace = 'any', now = Date.now() } = {}) {
  const needle = (search || ticket).trim().toLowerCase()
  const q = QUALITY_FILTERS[quality] || QUALITY_FILTERS.any
  const matchModel = !model || model === 'any' ? null : model.trim().toLowerCase()
  const matchSource = !source || source === 'any' ? null : source
  const quickTests = (quick || []).map((k) => QUICK_FILTERS[k]?.test).filter(Boolean)
  // Virtual projects (#13): client ids (UNASSIGNED = none), project keys, workspace 'main' | 'worktrees' | exact value.
  const clientSet = clients?.length ? new Set(clients) : null
  const projectSet = projects?.length ? new Set(projects) : null
  const ws = !workspace || workspace === 'any' ? null : workspace
  return sessions.filter((s) => {
    if (needle) {
      const matchTicket = (s.ticket_id || '').toLowerCase().includes(needle)
      const matchProject = [s.project_dir, s.base_dir, s.workspace, s.project_name, s.client_name].some((v) => (v || '').toLowerCase().includes(needle))
      const matchBranch = (s.git_branch || '').toLowerCase().includes(needle)
      const matchTitle = (displayTitle(s) || '').toLowerCase().includes(needle)
      if (!matchTicket && !matchProject && !matchBranch && !matchTitle) return false
    }
    if (matchModel && (s.model || '').toLowerCase() !== matchModel) return false
    if (matchSource && sourceOf(s) !== matchSource) return false
    if (clientSet && !clientSet.has(s.client_id || UNASSIGNED)) return false
    if (projectSet && !projectSet.has(sessionProjectKey(s))) return false
    if (ws === 'main' ? Boolean(s.workspace) : ws === 'worktrees' ? !s.workspace : ws && s.workspace !== ws) return false
    for (const t of quickTests) if (!t(s, now)) return false
    return q.test(s)
  })
}
