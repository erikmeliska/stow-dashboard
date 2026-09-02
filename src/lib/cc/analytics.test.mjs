import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits } from './store.mjs'
import { sessionAnalytics, portfolioAnalytics, sinceForRange } from './analytics.mjs'

function seedStore() {
  const db = openStore(':memory:')
  const base = {
    project_dir: '/p/alpha', cwd: '/p/alpha', model: 'claude-opus-5',
    duration_s: 600, active_s: 300, input_tokens: 100, output_tokens: 200,
    cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 1.5,
    turns: 10, status: 'done', raw_ref: 'x', ingested_at: '2026-09-01T00:00:00Z',
    quality_score: 90,
  }
  upsertSession(db, { ...base, session_id: 's1', started_at: '2026-09-01T10:00:00Z', ended_at: '2026-09-01T10:10:00Z' })
  upsertSession(db, {
    ...base, session_id: 's2', started_at: '2026-09-01T15:00:00Z', ended_at: '2026-09-01T15:10:00Z',
    model: 'claude-fable-5', project_dir: '/p/beta', cost_usd: 3.0, quality_score: 50,
  })
  // Old session, outside any recent `since`
  upsertSession(db, {
    ...base, session_id: 's3', started_at: '2026-01-05T10:00:00Z', ended_at: '2026-01-05T10:10:00Z',
    model: 'claude-sonnet-5', cost_usd: 10, quality_score: null,
  })
  replaceTools(db, 's1', { Bash: 5, Read: 3 })
  replaceTools(db, 's2', { Bash: 2, Edit: 4 })
  replaceTools(db, 's3', { Bash: 100 })
  replaceSkills(db, 's1', { 'superpowers:brainstorming': 2 })
  replaceGuardHits(db, 's1', [{ ts: '2026-09-01T10:05:00Z', command: 'rm -rf /', rule: 'r', action: 'deny' }])
  replaceGuardHits(db, 's3', [{ ts: '2026-01-05T10:05:00Z', command: 'x', rule: 'r', action: 'deny' }])
  return db
}

test('sessionAnalytics aggregates KPIs over all sessions', () => {
  const db = seedStore()
  const a = sessionAnalytics(db)
  assert.equal(a.kpis.sessions, 3)
  assert.equal(a.kpis.cost_usd, 14.5)
  assert.equal(a.kpis.input_tokens, 300)
  assert.equal(a.kpis.output_tokens, 600)
  assert.equal(a.kpis.turns, 30)
  assert.equal(a.kpis.tool_calls, 114)
  assert.equal(a.kpis.guard_hits, 2)
  assert.equal(a.kpis.avg_quality, 70) // (90+50)/2, null excluded
  assert.equal(a.kpis.avg_active_s, 300)
  db.close()
})

test('sessionAnalytics respects since — sessions, tools and guard hits all filtered', () => {
  const db = seedStore()
  const a = sessionAnalytics(db, { since: '2026-08-01T00:00:00Z' })
  assert.equal(a.kpis.sessions, 2)
  assert.equal(a.kpis.cost_usd, 4.5)
  assert.equal(a.kpis.tool_calls, 14) // s3's 100 Bash calls excluded
  assert.equal(a.kpis.guard_hits, 1)
  assert.deepEqual({ ...a.topTools[0] }, { tool: 'Bash', count: 7 })
  db.close()
})

test('sessionAnalytics perDay fills gaps with zero days', () => {
  const db = openStore(':memory:')
  const base = {
    project_dir: '/p', model: 'm', duration_s: 1, active_s: 1, input_tokens: 1,
    output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
    cost_usd: 1, turns: 1, status: 'done', raw_ref: 'x', ingested_at: 'x',
  }
  upsertSession(db, { ...base, session_id: 'a', started_at: '2026-09-01T10:00:00Z' })
  upsertSession(db, { ...base, session_id: 'b', started_at: '2026-09-03T10:00:00Z' })
  const a = sessionAnalytics(db)
  assert.deepEqual(a.perDay.map((d) => [d.day, d.sessions]), [
    ['2026-09-01', 1], ['2026-09-02', 0], ['2026-09-03', 1],
  ])
  assert.equal(a.perDay[1].cost_usd, 0)
  db.close()
})

test('sessionAnalytics folds models past top 5 into Other', () => {
  const db = openStore(':memory:')
  const base = {
    project_dir: '/p', duration_s: 1, active_s: 1, input_tokens: 10, output_tokens: 20,
    cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 1, turns: 1,
    status: 'done', raw_ref: 'x', ingested_at: 'x',
  }
  // 7 models: m1 gets 3 sessions, the rest 1 each → top5 = m1..m5, Other = m6+m7
  let n = 0
  for (const [model, count] of [['m1', 3], ['m2', 2], ['m3', 2], ['m4', 2], ['m5', 2], ['m6', 1], ['m7', 1]]) {
    for (let i = 0; i < count; i++) {
      upsertSession(db, { ...base, session_id: `s${n++}`, model, started_at: '2026-09-01T10:00:00Z' })
    }
  }
  const a = sessionAnalytics(db)
  assert.equal(a.byModel.length, 6)
  assert.equal(a.byModel[0].model, 'm1')
  const other = a.byModel.at(-1)
  assert.equal(other.model, 'Other')
  assert.equal(other.sessions, 2)
  assert.equal(other.input_tokens, 20)
  db.close()
})

test('sessionAnalytics buckets quality scores', () => {
  const db = seedStore()
  const a = sessionAnalytics(db)
  // 90 → 80–100 bucket, 50 → 40–60 bucket; null unscored
  const byLabel = Object.fromEntries(a.quality.map((b) => [b.bucket, b.count]))
  assert.equal(byLabel['80–100'], 1)
  assert.equal(byLabel['40–59'], 1)
  assert.equal(a.quality.length, 5)
  db.close()
})

test('sessionAnalytics lists top projects by cost', () => {
  const db = seedStore()
  const a = sessionAnalytics(db, { since: '2026-08-01T00:00:00Z' })
  assert.deepEqual({ ...a.topProjects[0] }, { project: 'beta', project_dir: '/p/beta', sessions: 1, cost_usd: 3.0 })
  assert.equal(a.topProjects.length, 2)
  db.close()
})

test('sinceForRange maps ranges to cutoffs', () => {
  const now = Date.parse('2026-09-02T12:00:00Z')
  assert.equal(sinceForRange('7d', now), '2026-08-26T12:00:00.000Z')
  assert.equal(sinceForRange('30d', now), '2026-08-03T12:00:00.000Z')
  assert.equal(sinceForRange('all', now), null)
  assert.equal(sinceForRange('junk', now), null)
})

// ---- portfolio ----

const PROJECTS = [
  {
    project_name: 'a', directory: '/p/a',
    ai_analysis: { category: '_Bizz', maturity: 'production' },
    scc: { total_code: 1000, estimated_cost: 500, languages: [{ name: 'JavaScript', code: 800 }, { name: 'CSS', code: 200 }] },
    git_info: { git_detected: true, is_clean: false, last_total_commit_date: '2026-09-01T00:00:00Z' },
  },
  {
    project_name: 'b', directory: '/p/b',
    ai_analysis: { category: '_Bizz', maturity: 'prototype' },
    scc: { total_code: 50, estimated_cost: 100, languages: [{ name: 'JavaScript', code: 50 }] },
    git_info: { git_detected: true, is_clean: true, last_total_commit_date: '2020-01-01T00:00:00Z' },
  },
  { project_name: 'c', directory: '/p/c', git_info: { git_detected: false } },
]

const USAGE = {
  totals: { sessions: 5, costUsd: 42.5 },
  projects: {
    '/p/a': { sessions: 3, costUsd: 40 },
    '/p/b': { sessions: 2, costUsd: 2.5 },
  },
}

test('portfolioAnalytics computes KPIs', () => {
  const a = portfolioAnalytics(PROJECTS, USAGE, Date.parse('2026-09-02T00:00:00Z'))
  assert.equal(a.kpis.projects, 3)
  assert.equal(a.kpis.total_code, 1050)
  assert.equal(a.kpis.est_value, 600)
  assert.equal(a.kpis.dirty, 1)
  assert.equal(a.kpis.ai_cost, 42.5)
  assert.equal(a.kpis.ai_sessions, 5)
})

test('portfolioAnalytics groups categories and maturity', () => {
  const a = portfolioAnalytics(PROJECTS, USAGE, Date.parse('2026-09-02T00:00:00Z'))
  assert.deepEqual(a.byCategory[0], { category: 'Bizz', count: 2 })
  assert.deepEqual(a.byCategory.at(-1), { category: 'unanalyzed', count: 1 })
  const mat = Object.fromEntries(a.byMaturity.map((m) => [m.maturity, m.count]))
  assert.equal(mat.production, 1)
  assert.equal(mat.prototype, 1)
})

test('portfolioAnalytics aggregates languages across projects', () => {
  const a = portfolioAnalytics(PROJECTS, USAGE, Date.parse('2026-09-02T00:00:00Z'))
  assert.deepEqual(a.topLanguages[0], { name: 'JavaScript', code: 850 })
  assert.deepEqual(a.topLanguages[1], { name: 'CSS', code: 200 })
})

test('portfolioAnalytics buckets commit activity', () => {
  const a = portfolioAnalytics(PROJECTS, USAGE, Date.parse('2026-09-02T00:00:00Z'))
  const act = Object.fromEntries(a.activity.map((b) => [b.bucket, b.count]))
  assert.equal(act['≤ 1w'], 1)   // project a committed yesterday
  assert.equal(act['> 1y'], 1)   // project b in 2020
  assert.equal(act['no git'], 1) // project c
})

test('portfolioAnalytics ranks projects by AI cost', () => {
  const a = portfolioAnalytics(PROJECTS, USAGE, Date.parse('2026-09-02T00:00:00Z'))
  assert.deepEqual(a.topAiCost[0], { project: 'a', cost_usd: 40, sessions: 3 })
})

test('portfolioAnalytics survives missing usage', () => {
  const a = portfolioAnalytics(PROJECTS, null, Date.parse('2026-09-02T00:00:00Z'))
  assert.equal(a.kpis.ai_cost, 0)
  assert.deepEqual(a.topAiCost, [])
})
