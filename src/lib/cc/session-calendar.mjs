/**
 * Calendar maths for /sessions (week and month views). Pure and client-safe;
 * all day boundaries are LOCAL time, weeks start on Monday.
 *
 * Placement (spec F4): a session is drawn from `started_at` to `ended_at` when
 * that span is at most 5 h; longer spans are desktop sessions left open (often
 * overnight), drawn as start + max(active time, 30 min). Minimum height 15 min.
 */
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format,
  startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs';
import { effectiveKind } from './session-link.mjs';
import { needsSummary, parseSummary, summaryVersion } from './summary-view.mjs';
import { sourceOf } from './session-filters.mjs';
import { UNASSIGNED } from './session-projects.mjs';

const WEEK = { weekStartsOn: 1 };
export const MAX_SPAN_MS = 5 * 3600_000;
export const FALLBACK_MS = 30 * 60_000;
export const MIN_MS = 15 * 60_000;
const DAY_MIN = 24 * 60;
const MIN_HEIGHT = 15;

export function periodRange(date, span = 'week') {
  if (span === 'month') {
    const since = startOfMonth(date);
    const days = eachDayOfInterval({ start: startOfWeek(since, WEEK), end: endOfWeek(endOfMonth(since), WEEK) });
    return { span: 'month', since, until: addMonths(since, 1), days };
  }
  const since = startOfWeek(date, WEEK);
  return { span: 'week', since, until: addDays(since, 7), days: eachDayOfInterval({ start: since, end: addDays(since, 6) }) };
}

export function shiftPeriod(date, span, dir) {
  return span === 'month' ? addMonths(date, dir) : addWeeks(date, dir);
}

export function periodLabel(range) {
  if (range.span === 'month') return format(range.since, 'LLLL yyyy');
  return `${format(range.since, 'd MMM')} – ${format(addDays(range.since, 6), 'd MMM yyyy')}`;
}

export function calendarSlot(s) {
  const start = Date.parse(s?.started_at || '');
  if (!Number.isFinite(start)) return null;
  const endRaw = Date.parse(s.ended_at || '');
  let end = Number.isFinite(endRaw) && endRaw > start && endRaw - start <= MAX_SPAN_MS
    ? endRaw
    : start + Math.max((s.active_s || 0) * 1000, FALLBACK_MS);
  if (end - start < MIN_MS) end = start + MIN_MS;
  return { start: new Date(start), end: new Date(end) };
}

/** The part of `slot` on local `day`, in minutes from midnight; null when they don't meet. */
export function daySegment(slot, day) {
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  const a = Math.max(slot.start.getTime(), d0);
  const b = Math.min(slot.end.getTime(), d1);
  if (b <= a) return null;
  const height = Math.min(Math.max((b - a) / 60000, MIN_HEIGHT), DAY_MIN);
  const top = Math.min((a - d0) / 60000, DAY_MIN - height);
  return { top, height, continued: slot.start.getTime() < d0, continues: slot.end.getTime() > d1 };
}

/** Greedy column layout for overlapping items of one day; `cols` is the width of the item's overlap cluster. */
export function layoutDay(items) {
  const sorted = [...items].sort((x, y) => x.start - y.start || y.end - x.end);
  const out = new Map();
  let cluster = [], colsEnd = [], clusterEnd = -Infinity;
  const flush = () => {
    for (const id of cluster) out.get(id).cols = colsEnd.length;
    cluster = []; colsEnd = []; clusterEnd = -Infinity;
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) flush();
    let col = colsEnd.findIndex((e) => e <= it.start);
    if (col === -1) { col = colsEnd.length; colsEnd.push(it.end); } else colsEnd[col] = it.end;
    out.set(it.id, { col, cols: 0 });
    cluster.push(it.id);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/** Deterministic project colour from the dataviz palette. */
export function projectColor(dir) {
  let h = 5381;
  for (const ch of String(dir || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `var(--viz-${1 + (h % 6)})`;
}

export function harnessBadge(s) {
  const src = sourceOf(s);
  if (src === 'codex') return { letter: 'X', label: 'Codex' };
  if (src === 'antigravity') return { letter: 'G', label: 'Antigravity' };
  return { letter: 'C', label: 'Claude Code' };
}

// ---- colour modes ("Color by") ----
//
// Each mode maps a session to a bucket with a fixed colour. Palettes follow the
// dataviz rules: outcome is a *status* encoding (status colours + the outcome
// icon on every block, so colour never carries it alone), harness and kind are
// categorical in fixed --viz order, cost and quality are one-hue ordinal ramps
// (--seq-1..4, light→dark). Colours are CSS variables defined per theme in
// globals.css. Project keeps its hashed colour (only 6 hues: projects can share).

const NEUTRAL = 'var(--viz-axis)';
const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'];
const bin = (v, edges) => edges.findIndex((edge) => v < edge);

export const COLOR_MODES = {
  outcome: {
    label: 'Outcome',
    buckets: [
      { key: 'done', label: 'Done', color: 'var(--status-good)' },
      { key: 'partial', label: 'Partial', color: 'var(--status-warning)' },
      { key: 'abandoned', label: 'Abandoned', color: 'var(--status-critical)' },
      { key: 'exploration', label: 'Exploration', color: 'var(--viz-1)' },
      { key: 'none', label: 'No summary', color: NEUTRAL },
    ],
    key: (e) => {
      const o = parseSummary(e)?.outcome;
      return ['done', 'partial', 'abandoned', 'exploration'].includes(o) ? o : 'none';
    },
  },
  project: { label: 'Project' },
  client: { label: 'Client' },
  harness: {
    label: 'Harness',
    buckets: [
      { key: 'claude', label: 'Claude Code', color: 'var(--viz-1)' },
      { key: 'codex', label: 'Codex', color: 'var(--viz-2)' },
      { key: 'antigravity', label: 'Antigravity', color: 'var(--viz-3)' },
    ],
    key: (e) => {
      const src = sourceOf(e);
      return src === 'codex' || src === 'antigravity' ? src : 'claude';
    },
  },
  kind: {
    label: 'Kind',
    buckets: [
      { key: 'work', label: 'Work', color: 'var(--viz-1)' },
      { key: 'scheduled', label: 'Scheduled', color: 'var(--viz-4)' },
      { key: 'agent-spawn', label: 'Agent spawn', color: 'var(--viz-5)' },
      { key: 'trivial', label: 'Trivial', color: NEUTRAL },
    ],
    key: (e) => e.ek || effectiveKind(e),
  },
  cost: {
    label: 'Cost',
    buckets: [
      { key: 'c1', label: '< $1', color: SEQ[0] },
      { key: 'c2', label: '$1–5', color: SEQ[1] },
      { key: 'c3', label: '$5–20', color: SEQ[2] },
      { key: 'c4', label: '≥ $20', color: SEQ[3] },
    ],
    key: (e) => {
      const i = bin((e.rollup || e).cost_usd || 0, [1, 5, 20]);
      return `c${i === -1 ? 4 : i + 1}`;
    },
  },
  quality: {
    label: 'Quality',
    buckets: [
      { key: 'q1', label: '< 50', color: SEQ[0] },
      { key: 'q2', label: '50–74', color: SEQ[1] },
      { key: 'q3', label: '75–89', color: SEQ[2] },
      { key: 'q4', label: '≥ 90', color: SEQ[3] },
      { key: 'none', label: 'Unscored', color: NEUTRAL },
    ],
    key: (e) => {
      if (e.quality_score == null) return 'none';
      const i = bin(e.quality_score, [50, 75, 90]);
      return `q${i === -1 ? 4 : i + 1}`;
    },
  },
};

export const DEFAULT_COLOR_MODE = 'outcome';
const PROJECT_LEGEND_MAX = 8;

// Open-ended modes: one hashed hue per value (6 hues, so values can share; the legend disambiguates).
// A client comes from the register join (#13); Unassigned is neutral grey.
const HASHED = {
  project: (e) => { const k = sessionProjectKey(e); return { key: k, label: sessionProjectLabel(e), color: projectColor(k) }; },
  client: (e) => (e.client_id
    ? { key: e.client_id, label: e.client_name || e.client_id, color: projectColor(e.client_id) }
    : { key: UNASSIGNED, label: 'Unassigned', color: NEUTRAL }),
};

/** The bucket (key, label, colour) a session falls into under `mode`. */
export function colorBy(e, mode) {
  if (HASHED[mode]) return HASHED[mode](e);
  const m = COLOR_MODES[mode]?.buckets ? COLOR_MODES[mode] : COLOR_MODES[DEFAULT_COLOR_MODE];
  const k = m.key(e);
  return m.buckets.find((b) => b.key === k) || m.buckets.at(-1);
}

/**
 * Legend for the shown events: fixed buckets in their order (with counts, empty
 * ones kept so the scale reads complete); for projects/clients the most frequent
 * ones, capped, with a "+N more" tail (Unassigned clients after it).
 */
export function colorLegend(events, mode) {
  const counts = new Map();
  for (const e of events || []) {
    const b = colorBy(e, mode);
    const c = counts.get(b.key) || { ...b, count: 0 };
    c.count++;
    counts.set(b.key, c);
  }
  if (HASHED[mode]) {
    const un = mode === 'client' ? counts.get(UNASSIGNED) : null;
    if (un) counts.delete(UNASSIGNED);
    const all = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const rest = all.slice(PROJECT_LEGEND_MAX);
    const head = all.length <= PROJECT_LEGEND_MAX + 1 ? all
      : [...all.slice(0, PROJECT_LEGEND_MAX), { key: 'more', label: `+${rest.length} more`, color: null, count: rest.reduce((a, b) => a + b.count, 0) }];
    return un ? [...head, un] : head;
  }
  const m = COLOR_MODES[mode]?.buckets ? COLOR_MODES[mode] : COLOR_MODES[DEFAULT_COLOR_MODE];
  return m.buckets.map((b) => ({ ...b, count: counts.get(b.key)?.count || 0 }));
}

/** Families to draw: work always, the rest only with showAll (muted). */
export function calendarFamilies(families, { showAll = false } = {}) {
  const out = [];
  for (const f of families || []) {
    const ek = effectiveKind(f);
    if (ek !== 'work' && !showAll) continue;
    out.push({ ...f, ek, muted: ek !== 'work' });
  }
  return out;
}

/** Shown events with no summary at all that a batch may process (not written to in the last 10 min). */
export function missingSummaryIds(events, now = Date.now()) {
  return (events || []).filter((e) => needsSummary(e, { now })).map((e) => e.session_id);
}

/**
 * Identity of a sessions load: what the page asked /api/sessions for. The
 * table loads the newest rows, the calendar one period, both per project.
 */
export function loadKey({ view, project = null, range = null }) {
  const period = view === 'calendar' && range ? `${range.since.toISOString()}|${range.until.toISOString()}` : '';
  return `${view}|${project || ''}|${period}`;
}

/**
 * The banner's ids: the displayed events' missing summaries, but only once
 * the loaded data is the displayed view/period/project (`loadedKey ===
 * wantKey`). Until then, e.g. right after Table → Calendar or a period
 * change, the events on hand belong to another load and nothing is counted.
 */
export function bannerIds({ loadedKey, wantKey, events, now = Date.now() }) {
  return loadedKey != null && loadedKey === wantKey ? missingSummaryIds(events, now) : [];
}

export function periodStats(events) {
  const out = { sessions: 0, active_s: 0, cost_usd: 0, done: 0, partial: 0, described: 0 };
  for (const e of events || []) {
    const r = e.rollup || e;
    out.sessions++;
    out.active_s += r.active_s || 0;
    out.cost_usd += r.cost_usd || 0;
    if (summaryVersion(e) > 0) out.described++;
    const o = parseSummary(e)?.outcome;
    if (o === 'done') out.done++;
    if (o === 'partial') out.partial++;
  }
  return out;
}

export function formatEta(seconds) {
  if (seconds < 60) return '<1 min';
  if (seconds >= 90 * 60) return `~${(seconds / 3600).toFixed(1)} h`;
  return `~${Math.round(seconds / 60)} min`;
}
