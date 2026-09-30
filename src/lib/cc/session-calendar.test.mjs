import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodRange, shiftPeriod, calendarSlot, daySegment, layoutDay, projectColor, harnessBadge,
  calendarFamilies, missingSummaryIds, periodStats, formatEta, loadKey, bannerIds, colorBy, colorLegend, COLOR_MODES,
} from './session-calendar.mjs';

const L = (d, h = 0, m = 0) => new Date(2026, 8, d, h, m); // September 2026, local
const iso = (d) => d.toISOString();

test('periodRange: week starts Monday even for a Sunday; month covers full weeks', () => {
  const w = periodRange(L(13, 15), 'week'); // Sunday 13 Sep
  assert.equal(+w.since, +L(7));
  assert.equal(+w.until, +L(14));
  assert.equal(w.days.length, 7);
  const m = periodRange(L(9), 'month');
  assert.equal(+m.since, +L(1));
  assert.equal(+m.until, +new Date(2026, 9, 1));
  assert.equal(+m.days[0], +new Date(2026, 7, 31)); // Mon 31 Aug
  assert.equal(m.days.length % 7, 0);
  assert.equal(+shiftPeriod(L(9), 'week', 1), +L(16));
  assert.equal(shiftPeriod(L(9), 'month', -1).getMonth(), 7);
});

test('calendarSlot: real end up to 5 h, else max(active, 30 min); at least 15 min', () => {
  const s = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 12)), active_s: 600 });
  assert.equal(+s.end, +L(9, 12));
  const overnight = calendarSlot({ started_at: iso(L(9, 18)), ended_at: iso(L(10, 9)), active_s: 3600 });
  assert.equal(+overnight.end, +L(9, 19));
  const idle = calendarSlot({ started_at: iso(L(9, 18)), ended_at: iso(L(10, 9)), active_s: 60 });
  assert.equal(+idle.end, +L(9, 18, 30));
  const tiny = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 2)) });
  assert.equal(+tiny.end, +L(9, 10, 15));
  const open = calendarSlot({ started_at: iso(L(9, 10)), ended_at: null, active_s: 0 });
  assert.equal(+open.end, +L(9, 10, 30));
  assert.equal(calendarSlot({ started_at: null }), null);
});

test('daySegment clips a session that crosses midnight onto both days', () => {
  const slot = calendarSlot({ started_at: iso(L(9, 23)), ended_at: iso(L(10, 1)) });
  assert.deepEqual(daySegment(slot, L(9)), { top: 23 * 60, height: 60, continued: false, continues: true });
  assert.deepEqual(daySegment(slot, L(10)), { top: 0, height: 60, continued: true, continues: false });
  assert.equal(daySegment(slot, L(11)), null);
  const edge = daySegment({ start: L(9, 23, 55), end: L(10, 0, 0) }, L(9));
  assert.equal(edge.top + edge.height, 1440, 'min height never spills past midnight');
});

test('layoutDay puts overlapping events side by side, separate clusters full width', () => {
  const lay = layoutDay([
    { id: 'a', start: 60, end: 180 }, { id: 'b', start: 120, end: 150 }, { id: 'c', start: 130, end: 200 },
    { id: 'd', start: 300, end: 360 },
  ]);
  assert.deepEqual(lay.get('a'), { col: 0, cols: 3 });
  assert.deepEqual(lay.get('b'), { col: 1, cols: 3 });
  assert.deepEqual(lay.get('c'), { col: 2, cols: 3 });
  assert.deepEqual(lay.get('d'), { col: 0, cols: 1 });
});

test('projectColor is stable; harnessBadge maps sources', () => {
  assert.equal(projectColor('/p/app'), projectColor('/p/app'));
  assert.match(projectColor('/p/app'), /^var\(--viz-[1-6]\)$/);
  assert.match(projectColor(null), /^var\(--viz-[1-6]\)$/);
  assert.equal(harnessBadge({ entrypoint: 'codex-desktop' }).letter, 'X');
  assert.equal(harnessBadge({ entrypoint: 'antigravity' }).letter, 'G');
  assert.equal(harnessBadge({ entrypoint: 'claude-desktop' }).letter, 'C');
});

test('calendarFamilies hides non-work unless showAll, then mutes it', () => {
  const fams = [{ session_id: 'w', kind: 'main' }, { session_id: 's', kind: 'scheduled' }];
  assert.deepEqual(calendarFamilies(fams, { showAll: false }).map((f) => f.session_id), ['w']);
  const all = calendarFamilies(fams, { showAll: true });
  assert.deepEqual(all.map((f) => [f.session_id, f.ek, f.muted]), [['w', 'work', false], ['s', 'scheduled', true]]);
});

test('missingSummaryIds skips described and still-running sessions; periodStats sums rollups', () => {
  const now = +L(30, 12);
  const ev = [
    { session_id: 'a', raw_ref: '/t', ended_at: iso(L(9, 11)), rollup: { active_s: 600, cost_usd: 1 } },
    { session_id: 'b', raw_ref: '/t', ended_at: iso(L(9, 11)), summary: JSON.stringify({ v: 2, outcome: 'done' }), rollup: { active_s: 1200, cost_usd: 2 } },
    { session_id: 'c', raw_ref: '/t', ended_at: new Date(now - 60_000).toISOString(), rollup: { active_s: 0, cost_usd: 0 } },
    { session_id: 'd', raw_ref: '/t', ended_at: iso(L(9, 11)), summary: JSON.stringify({ outcome: 'partial' }), rollup: { active_s: 0, cost_usd: 0.5 } },
  ];
  assert.deepEqual(missingSummaryIds(ev, now), ['a']);
  assert.deepEqual(periodStats(ev), { sessions: 4, active_s: 1800, cost_usd: 3.5, done: 1, partial: 1, described: 2 });
});

test('formatEta', () => {
  assert.equal(formatEta(20), '<1 min');
  assert.equal(formatEta(240), '~4 min');
  assert.equal(formatEta(5400), '~1.5 h');
});

test('bannerIds: only the missing ids of data loaded for the displayed view+range+project', () => {
  const now = +L(30, 12);
  const ev = [{ session_id: 'a', raw_ref: '/t', ended_at: iso(L(9, 11)) }];
  const range = periodRange(L(9), 'week');
  const want = loadKey({ view: 'calendar', project: null, range });
  assert.deepEqual(bannerIds({ loadedKey: want, wantKey: want, events: ev, now }), ['a']);
  // Table data (newest 1000 rows) shown right after switching to the calendar.
  assert.deepEqual(bannerIds({ loadedKey: loadKey({ view: 'table', project: null, range }), wantKey: want, events: ev, now }), []);
  // Previous period still on screen while the new one loads.
  const prev = loadKey({ view: 'calendar', project: null, range: periodRange(L(2), 'week') });
  assert.deepEqual(bannerIds({ loadedKey: prev, wantKey: want, events: ev, now }), []);
  // Another project filter.
  assert.deepEqual(bannerIds({ loadedKey: loadKey({ view: 'calendar', project: '/p', range }), wantKey: want, events: ev, now }), []);
  assert.deepEqual(bannerIds({ loadedKey: null, wantKey: want, events: ev, now }), []);
});

test('colorBy: every mode buckets a session and exposes its colour', () => {
  const s = (o) => ({ session_id: 'x', project_dir: '/p/app', entrypoint: 'cli', kind: 'main', rollup: { cost_usd: 0 }, ...o });
  const sum = (outcome) => JSON.stringify({ v: 2, outcome });
  assert.equal(colorBy(s({ summary: sum('done') }), 'outcome').key, 'done');
  assert.equal(colorBy(s({ summary: sum('exploration') }), 'outcome').color, 'var(--viz-1)');
  assert.equal(colorBy(s({}), 'outcome').key, 'none');
  assert.equal(colorBy(s({ summary: '{broken' }), 'outcome').key, 'none');
  assert.equal(colorBy(s({ entrypoint: 'codex-desktop' }), 'harness').key, 'codex');
  assert.equal(colorBy(s({ entrypoint: 'antigravity' }), 'harness').key, 'antigravity');
  assert.equal(colorBy(s({ kind: 'scheduled' }), 'kind').key, 'scheduled');
  assert.equal(colorBy(s({ rollup: { cost_usd: 0.4 } }), 'cost').key, 'c1');
  assert.equal(colorBy(s({ rollup: { cost_usd: 5 } }), 'cost').key, 'c3');
  assert.equal(colorBy(s({ rollup: { cost_usd: 20 } }), 'cost').key, 'c4');
  assert.equal(colorBy(s({ quality_score: null }), 'quality').key, 'none');
  assert.equal(colorBy(s({ quality_score: 90 }), 'quality').key, 'q4');
  assert.equal(colorBy(s({ quality_score: 49 }), 'quality').key, 'q1');
  assert.equal(colorBy(s({}), 'project').color, projectColor('/p/app'));
  assert.equal(colorBy(s({ summary: sum('done') }), 'nonsense').key, 'done', 'unknown mode falls back to outcome');
});

test('colorLegend lists buckets in fixed order with counts; project legend by count, capped', () => {
  const ev = [
    { project_dir: '/p/a', summary: JSON.stringify({ v: 2, outcome: 'done' }) },
    { project_dir: '/p/a', summary: JSON.stringify({ v: 2, outcome: 'done' }) },
    { project_dir: '/p/b' },
  ];
  const out = colorLegend(ev, 'outcome');
  assert.deepEqual(out.map((b) => [b.key, b.count]), [['done', 2], ['partial', 0], ['abandoned', 0], ['exploration', 0], ['none', 1]]);
  const proj = colorLegend(ev, 'project');
  assert.deepEqual(proj.map((b) => [b.label, b.count]), [['a', 2], ['b', 1]]);
  const many = Array.from({ length: 12 }, (_, i) => ({ project_dir: `/p/x${i}` }));
  const capped = colorLegend(many, 'project');
  assert.equal(capped.length, 9);
  assert.equal(capped.at(-1).label, '+4 more');
  assert.ok(COLOR_MODES.outcome && COLOR_MODES.harness && COLOR_MODES.cost);
});
