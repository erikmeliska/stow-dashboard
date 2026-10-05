/**
 * Session families for the /sessions page: pure over the rows the API returns.
 *
 * A *family* is one top-level session plus (a) its nested Agent-tool runs
 * (`subagents` rows — already folded into the parent's own numbers by the
 * ingest, so they are a breakdown, not an addition) and (b) its linked child
 * sessions (`parent_session_id` — separate transcripts whose numbers are NOT
 * in the parent's, so they add up). `rollup` is the whole package; `own` is
 * the top-level transcript without either.
 */

import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs';
import { UNASSIGNED } from './session-projects.mjs';

const SUM = ['cost_usd', 'active_s', 'duration_s', 'turns', 'input_tokens', 'output_tokens', 'cache_read'];

function zero() {
  const o = {};
  for (const k of SUM) o[k] = 0;
  return o;
}

function add(into, row) {
  for (const k of SUM) into[k] += row?.[k] || 0;
  return into;
}

/** Sum of `cost_usd`, `active_s`, … over rows (null-safe). */
export function sumRows(rows) {
  const out = zero();
  for (const r of rows || []) add(out, r);
  return out;
}

/**
 * @param {object[]} sessions  rows from GET /api/sessions (parents and children mixed)
 * @param {object[]} agents    rows from the `subagents` table for those sessions
 * @returns {Array<object & { agents: object[], children: object[], own: object, rollup: object, sub_count: number }>}
 *   top-level sessions, newest first; children keep their row fields untouched
 */
export function buildSessionTree(sessions, agents = []) {
  const byId = new Map();
  for (const s of sessions || []) byId.set(s.session_id, s);
  const kids = new Map();
  for (const s of sessions || []) {
    if (!s.parent_session_id || !byId.has(s.parent_session_id)) continue;
    if (!kids.has(s.parent_session_id)) kids.set(s.parent_session_id, []);
    kids.get(s.parent_session_id).push(s);
  }
  const ags = new Map();
  for (const a of agents || []) {
    if (!ags.has(a.session_id)) ags.set(a.session_id, []);
    ags.get(a.session_id).push(a);
  }
  const out = [];
  for (const s of sessions || []) {
    // A child whose parent isn't in the list (limit cut, or the parent row is gone) stays visible on its own.
    if (s.parent_session_id && byId.has(s.parent_session_id)) continue;
    out.push(familyOf(s, ags.get(s.session_id) || [], kids.get(s.session_id) || []));
  }
  return out.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
}

/** One family record; `agents`/`children` sorted oldest-first for display. */
export function familyOf(session, agents = [], children = []) {
  const byStart = (a, b) => String(a.started_at || '').localeCompare(String(b.started_at || ''));
  const ag = [...agents].sort(byStart);
  const ch = [...children].sort(byStart);
  const agentsSum = sumRows(ag);
  const childrenSum = sumRows(ch);
  const own = add(zero(), session);
  // Nested agents are folded into the parent row (tokens/cost/active), except turns/duration which the ingest keeps main-only.
  for (const k of ['cost_usd', 'active_s', 'input_tokens', 'output_tokens', 'cache_read']) own[k] = Math.max(0, own[k] - agentsSum[k]);
  own.turns = session.turns || 0;
  own.duration_s = session.duration_s || 0;
  const rollup = add(add(zero(), session), childrenSum);
  rollup.duration_s = session.duration_s || 0;
  return {
    ...session,
    agents: ag, children: ch,
    own, agents_sum: agentsSum, children_sum: childrenSum, rollup,
    sub_count: ag.length + ch.length,
  };
}

// ---- grouping and sorting (pure, over family rows) ----

function isoWeek(d) {
  // ISO-8601 week: Thursday of the same week decides the year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

/**
 * Group keys. `key` returns the bucket id (sorted descending for time keys,
 * by cost for the rest); `text(key, firstItem)` renders it. Local time for day/week so the
 * buckets match what the Started column shows.
 */
export const GROUP_BY = {
  none: { label: 'Group: none' },
  day: { label: 'Day', key: (f) => (f.started_at ? localDay(new Date(f.started_at)) : '—'), order: 'desc' },
  week: { label: 'Week', key: (f) => (f.started_at ? isoWeek(shiftLocal(new Date(f.started_at))) : '—'), order: 'desc' },
  // Register project first, so worktree/scratchpad sessions fold into their project (#12).
  project: { label: 'Project', key: (f) => sessionProjectKey(f) || '—', text: (k, f) => (f ? sessionProjectLabel(f) : k), order: 'cost' },
  // Register client (#13), joined at read time; `last` pins Unassigned to the bottom.
  client: { label: 'Client', key: (f) => f.client_id || UNASSIGNED, text: (k, f) => (k === UNASSIGNED ? 'Unassigned' : f?.client_name || k), order: 'cost', last: UNASSIGNED },
  branch: { label: 'Branch', key: (f) => f.git_branch || '(no branch)', order: 'cost' },
  ticket: { label: 'Ticket', key: (f) => f.ticket_id || '(no ticket)', order: 'cost' },
  model: { label: 'Model', key: (f) => f.model || '(unknown)', order: 'cost' },
};

export function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Shift a Date so its UTC fields equal the local fields (for local-time ISO weeks). */
function shiftLocal(d) { return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); }

/**
 * @returns {Array<{ key: string, label: string, items: object[], sum: object, count: number }>}
 *   groups in display order; `sum` is the rollup total of the group's families.
 */
export function groupFamilies(families, by) {
  const def = GROUP_BY[by];
  if (!def || !def.key) return [{ key: 'all', label: '', items: families, sum: sumRows(families.map((f) => f.rollup || f)), count: families.length }];
  const map = new Map();
  for (const f of families) {
    const k = def.key(f);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f);
  }
  const groups = [...map.entries()].map(([key, items]) => ({
    key, label: def.text ? def.text(key, items[0]) : key, items, sum: sumRows(items.map((f) => f.rollup || f)), count: items.length,
  }));
  if (def.order === 'desc') groups.sort((a, b) => b.key.localeCompare(a.key));
  else groups.sort((a, b) => (a.key === def.last) - (b.key === def.last) || (b.sum.cost_usd - a.sum.cost_usd) || a.label.localeCompare(b.label));
  return groups;
}

/** Sortable columns → value getter (package numbers where they exist). */
export const SORT_KEYS = {
  started_at: (f) => f.started_at || '',
  turns: (f) => (f.rollup || f).turns || 0,
  tokens: (f) => ((f.rollup || f).input_tokens || 0) + ((f.rollup || f).output_tokens || 0),
  cost_usd: (f) => (f.rollup || f).cost_usd || 0,
  active_s: (f) => (f.rollup || f).active_s || 0,
  quality_score: (f) => (f.quality_score == null ? -1 : f.quality_score),
  sub_count: (f) => f.sub_count || 0,
  // null = unassigned / unknown: sorts last in both directions.
  client: (f) => f.client_name || null,
  project: (f) => { const n = f.project_name || (sessionProjectKey(f) ? sessionProjectLabel(f) : null); return n && n !== '—' ? n : null; },
};

/** Stable sort by one of SORT_KEYS; `dir` 'asc' | 'desc'; null values last either way. Unknown key → input order. */
export function sortFamilies(families, { key = 'started_at', dir = 'desc' } = {}) {
  const get = SORT_KEYS[key];
  if (!get) return [...families];
  const sign = dir === 'asc' ? 1 : -1;
  return [...families]
    .map((f, i) => ({ f, i, v: get(f) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return (a.v == null) - (b.v == null) || a.i - b.i;
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.f);
}
