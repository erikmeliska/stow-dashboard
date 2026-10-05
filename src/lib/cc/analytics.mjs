/**
 * Aggregations behind /api/analytics: session-side numbers computed with SQL
 * over the cc session store, portfolio-side numbers as a pure pass over the
 * projects ledger + usage.json. Nothing here writes — the ingest/refresh cycle
 * owns the data; this layer only reads it at request time.
 */

import { localDay } from './session-tree.mjs'
import { UNASSIGNED } from './session-projects.mjs'

const MODEL_SLOTS = 5 // donut cap: top 5 models + 'Other' keeps the part-to-whole ≤ 6 segments
const CLIENT_SLOTS = 8

/** '7d' | '30d' | '90d' | 'all' → ISO cutoff (null = no cutoff). */
export function sinceForRange(range, now = Date.now()) {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range]
  return days ? new Date(now - days * 86400_000).toISOString() : null
}

/**
 * `index` is session-projects.mjs's projectIndex (register join, #13); without
 * it every session counts as Unassigned in `topClients`.
 */
export function sessionAnalytics(db, { since = null, index = new Map() } = {}) {
  // One WHERE fragment shared by every query; guard/tool tables join through sessions
  // so the time filter applies to them too.
  const where = since ? 'WHERE s.started_at >= ?' : ''
  const args = since ? [since] : []
  const one = (sql) => db.prepare(sql).get(...args)
  const all = (sql) => db.prepare(sql).all(...args)

  // `sessions` counts top-level sessions only: hook-spawned children (security
  // reviews) would inflate it, while their cost/tokens still belong in the sums.
  const k = one(`
    SELECT sum(parent_session_id IS NULL) sessions,
           coalesce(sum(cost_usd), 0) cost_usd,
           coalesce(sum(input_tokens), 0) input_tokens,
           coalesce(sum(output_tokens), 0) output_tokens,
           coalesce(sum(turns), 0) turns,
           avg(quality_score) avg_quality,
           avg(active_s) avg_active_s
    FROM sessions s ${where}`)
  const toolCalls = one(`
    SELECT coalesce(sum(t.count), 0) n
    FROM tool_usage t JOIN sessions s ON s.session_id = t.session_id ${where}`)
  const guardHits = one(`
    SELECT count(*) n
    FROM guard_hits g JOIN sessions s ON s.session_id = g.session_id ${where}`)

  // Local calendar days (the server runs on the user's machine), matching the
  // /sessions table and calendar; SQL substr() would bucket by UTC day.
  const perDayMap = new Map()
  for (const r of all(`SELECT s.started_at, s.parent_session_id, s.cost_usd, s.input_tokens, s.output_tokens FROM sessions s ${where}`)) {
    const t = Date.parse(r.started_at || '')
    if (!Number.isFinite(t)) continue
    const day = localDay(new Date(t))
    const d = perDayMap.get(day) || { day, sessions: 0, cost_usd: 0, tokens: 0 }
    if (!r.parent_session_id) d.sessions++
    d.cost_usd += r.cost_usd || 0
    d.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
    perDayMap.set(day, d)
  }
  const perDayRaw = [...perDayMap.values()].sort((a, b) => a.day.localeCompare(b.day))

  const byModelRaw = all(`
    SELECT coalesce(model, 'unknown') model, count(*) sessions,
           coalesce(sum(input_tokens), 0) input_tokens,
           coalesce(sum(output_tokens), 0) output_tokens,
           coalesce(sum(cost_usd), 0) cost_usd
    FROM sessions s ${where} GROUP BY model ORDER BY sessions DESC, model`)

  const topTools = all(`
    SELECT t.tool, sum(t.count) count
    FROM tool_usage t JOIN sessions s ON s.session_id = t.session_id ${where}
    GROUP BY t.tool ORDER BY count DESC LIMIT 10`)

  const topSkills = all(`
    SELECT k.skill, sum(k.count) count
    FROM skill_usage k JOIN sessions s ON s.session_id = k.session_id ${where}
    GROUP BY k.skill ORDER BY count DESC LIMIT 10`)

  // By register project (#12), so worktree/scratchpad sessions count toward it;
  // unplaced rows fall back to their main-checkout dir, then the raw dir.
  const topProjects = all(`
    SELECT coalesce(s.project_key, s.base_dir, s.project_dir) k, max(s.project_key) project_key,
           max(coalesce(s.base_dir, s.project_dir)) project_dir,
           sum(parent_session_id IS NULL) sessions, coalesce(sum(cost_usd), 0) cost_usd
    FROM sessions s ${where} GROUP BY k ORDER BY cost_usd DESC LIMIT 8`)
    .map((r) => ({
      project: (r.project_dir || '').split('/').filter(Boolean).at(-1) || '—',
      project_key: r.project_key,
      project_dir: r.project_dir,
      sessions: r.sessions,
      cost_usd: r.cost_usd,
    }))

  // By register client (#13), joined at read time: the store never holds the client.
  // A key the register doesn't know (or no key) is Unassigned, listed last.
  const clientMap = new Map()
  for (const r of all(`
    SELECT s.project_key, sum(parent_session_id IS NULL) sessions, coalesce(sum(cost_usd), 0) cost_usd
    FROM sessions s ${where} GROUP BY s.project_key`)) {
    const hit = r.project_key ? index.get(r.project_key) : null
    const id = hit?.client_id || UNASSIGNED
    const c = clientMap.get(id) || { client_id: id, client: hit?.client_name || 'Unassigned', sessions: 0, cost_usd: 0 }
    c.sessions += r.sessions
    c.cost_usd += r.cost_usd
    clientMap.set(id, c)
  }
  const unassigned = clientMap.get(UNASSIGNED)
  clientMap.delete(UNASSIGNED)
  const topClients = [
    ...[...clientMap.values()].sort((a, b) => b.cost_usd - a.cost_usd || a.client.localeCompare(b.client)).slice(0, CLIENT_SLOTS),
    ...(unassigned ? [unassigned] : []),
  ]

  const qualityRows = all(`
    SELECT min(4, cast(quality_score / 20 AS INTEGER)) b, count(*) n
    FROM sessions s ${where} ${where ? 'AND' : 'WHERE'} quality_score IS NOT NULL
    GROUP BY b`)

  return {
    kpis: {
      sessions: k.sessions,
      cost_usd: k.cost_usd,
      input_tokens: k.input_tokens,
      output_tokens: k.output_tokens,
      turns: k.turns,
      tool_calls: toolCalls.n,
      guard_hits: guardHits.n,
      avg_quality: k.avg_quality == null ? null : Math.round(k.avg_quality),
      avg_active_s: k.avg_active_s == null ? null : Math.round(k.avg_active_s),
    },
    perDay: fillDays(perDayRaw),
    byModel: foldModels(byModelRaw),
    topTools,
    topSkills,
    topProjects,
    topClients,
    quality: qualityBuckets(qualityRows),
  }
}

/** Zero-fill missing days so the time axis isn't distorted by gaps. */
function fillDays(rows) {
  if (rows.length === 0) return []
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out = []
  const end = Date.parse(rows.at(-1).day + 'T00:00:00Z')
  for (let t = Date.parse(rows[0].day + 'T00:00:00Z'); t <= end; t += 86400_000) {
    const day = new Date(t).toISOString().slice(0, 10)
    out.push(byDay.get(day) || { day, sessions: 0, cost_usd: 0, tokens: 0 })
  }
  return out
}

function foldModels(rows) {
  if (rows.length <= MODEL_SLOTS + 1) return rows
  const head = rows.slice(0, MODEL_SLOTS)
  const other = { model: 'Other', sessions: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }
  for (const r of rows.slice(MODEL_SLOTS)) {
    other.sessions += r.sessions
    other.input_tokens += r.input_tokens
    other.output_tokens += r.output_tokens
    other.cost_usd += r.cost_usd
  }
  return [...head, other]
}

function qualityBuckets(rows) {
  const labels = ['0–19', '20–39', '40–59', '60–79', '80–100']
  const counts = new Array(labels.length).fill(0)
  for (const r of rows) counts[r.b] = r.n
  return labels.map((bucket, i) => ({ bucket, count: counts[i] }))
}

// ---- portfolio (projects ledger + usage.json) ----

const ACTIVITY_BUCKETS = [
  ['≤ 1w', 7], ['≤ 1m', 31], ['≤ 3m', 92], ['≤ 6m', 183], ['≤ 1y', 366],
]

export function portfolioAnalytics(projects, usage, now = Date.now()) {
  const kpis = { projects: projects.length, total_code: 0, est_value: 0, dirty: 0, ai_cost: 0, ai_sessions: 0 }
  const byCategory = new Map()
  const byMaturity = new Map()
  const byLanguage = new Map()
  const activity = new Map([...ACTIVITY_BUCKETS.map(([l]) => [l, 0]), ['> 1y', 0], ['no git', 0]])

  for (const p of projects) {
    kpis.total_code += p.scc?.total_code || 0
    kpis.est_value += p.scc?.estimated_cost || 0
    if (p.git_info?.is_clean === false) kpis.dirty++

    const cat = p.ai_analysis?.category ? p.ai_analysis.category.replace(/^_/, '') : 'unanalyzed'
    byCategory.set(cat, (byCategory.get(cat) || 0) + 1)
    if (p.ai_analysis?.maturity) byMaturity.set(p.ai_analysis.maturity, (byMaturity.get(p.ai_analysis.maturity) || 0) + 1)
    for (const l of p.scc?.languages || []) byLanguage.set(l.name, (byLanguage.get(l.name) || 0) + (l.code || 0))

    const last = p.git_info?.last_total_commit_date
    if (!p.git_info?.git_detected || !last) {
      activity.set('no git', activity.get('no git') + 1)
    } else {
      const days = (now - Date.parse(last)) / 86400_000
      const bucket = ACTIVITY_BUCKETS.find(([, max]) => days <= max)?.[0] || '> 1y'
      activity.set(bucket, activity.get(bucket) + 1)
    }
  }

  kpis.ai_cost = usage?.totals?.costUsd || 0
  kpis.ai_sessions = usage?.totals?.sessions || 0

  const desc = (a, b) => b[1] - a[1]
  const topAiCost = Object.entries(usage?.projects || {})
    .map(([dir, u]) => ({
      project: dir.split('/').filter(Boolean).at(-1) || dir,
      cost_usd: u.costUsd || 0,
      sessions: u.sessions || 0,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, 8)

  return {
    kpis,
    byCategory: [...byCategory.entries()].sort(desc).map(([category, count]) => ({ category, count })),
    byMaturity: [...byMaturity.entries()].sort(desc).map(([maturity, count]) => ({ maturity, count })),
    topLanguages: [...byLanguage.entries()].sort(desc).slice(0, 10).map(([name, code]) => ({ name, code })),
    activity: [...activity.entries()].map(([bucket, count]) => ({ bucket, count })),
    topAiCost,
  }
}
