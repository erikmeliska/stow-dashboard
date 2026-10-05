import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodRange, shiftPeriod, calendarSlot, daySegment, layoutDay, projectColor, harnessBadge,
  calendarFamilies, missingSummaryIds, periodStats, formatEta, loadKey, bannerIds, colorBy, colorLegend, COLOR_MODES,
  layoutPoints, defaultColorMode, periodLabel,
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
  const tiny = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 2)), active_s: 90 });
  assert.equal(+tiny.end, +L(9, 10, 15));
  assert.equal(tiny.point, undefined);
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

test('calendarSlot: ~0 active time and a short real span is a point, not a 15-min block', () => {
  const zero = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 0)), active_s: 0 });
  assert.deepEqual(zero, { start: L(9, 10), end: L(9, 10), point: true });
  const blip = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 4)), active_s: 22 });
  assert.equal(blip.point, true);
  // Rollup (children included) decides for a family.
  assert.equal(calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 1)), active_s: 0, rollup: { active_s: 600 } }).point, undefined);
  // A long real span stays a block even when idle; so does an open session.
  assert.equal(calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 6)), active_s: 0 }).point, undefined);
  assert.equal(calendarSlot({ started_at: iso(L(9, 10)), ended_at: null, active_s: 0 }).point, undefined);
});

test('daySegment: a point has no height and lands only on its start day', () => {
  const slot = calendarSlot({ started_at: iso(L(9, 23, 59)), ended_at: iso(L(9, 23, 59)), active_s: 0 });
  assert.deepEqual(daySegment(slot, L(9)), { top: 23 * 60 + 59, height: 0, point: true, continued: false, continues: false });
  assert.equal(daySegment(slot, L(10)), null);
  const midnight = calendarSlot({ started_at: iso(L(10)), ended_at: iso(L(10)), active_s: 0 });
  assert.equal(daySegment(midnight, L(9)), null);
  assert.equal(daySegment(midnight, L(10)).top, 0);
});

test('layoutPoints moves a dot that would overlap an earlier one into the next slot', () => {
  const lay = layoutPoints([
    { id: 'c', top: 605 }, { id: 'a', top: 600 }, { id: 'b', top: 602 }, { id: 'd', top: 630 },
  ]);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => lay.get(id)), [0, 1, 2, 0]);
});

test('layoutDay puts overlapping events side by side, separate clusters full width', () => {
  const { placed: lay, overflow } = layoutDay([
    { id: 'a', start: 60, end: 180 }, { id: 'b', start: 120, end: 150 }, { id: 'c', start: 130, end: 200 },
    { id: 'd', start: 300, end: 360 },
  ]);
  assert.deepEqual(overflow, [], 'no cap by default');
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

test('Color by project: main and worktree session share one bucket', () => {
  const a = colorBy({ project_key: 'P', base_dir: '/p', project_dir: '/p' }, 'project');
  const b = colorBy({ project_key: 'P', base_dir: '/p', project_dir: '/p/.agent-office/worktrees/x' }, 'project');
  assert.equal(a.key, b.key); assert.equal(a.color, b.color); assert.equal(b.label, 'p');
});

import { UNASSIGNED } from './session-projects.mjs';

test('colorBy client: hashed hue per client id, neutral for unassigned', () => {
  const a = colorBy({ client_id: 'intelimail', client_name: 'Intelimail' }, 'client');
  assert.equal(a.key, 'intelimail');
  assert.equal(a.label, 'Intelimail');
  assert.match(a.color, /^var\(--viz-[1-6]\)$/);
  assert.deepEqual(colorBy({ client_id: null }, 'client'), { key: UNASSIGNED, label: 'Unassigned', color: 'var(--viz-axis)' });
  assert.equal(COLOR_MODES.client.label, 'Client');
});

test('colorLegend client: most frequent first, Unassigned last, capped with +N more', () => {
  const ev = [
    ...Array(3).fill({ client_id: 'a', client_name: 'A' }),
    ...Array(5).fill({ client_id: null }),
    ...'bcdefghij'.split('').map((c) => ({ client_id: c, client_name: c.toUpperCase() })),
  ];
  const legend = colorLegend(ev, 'client');
  assert.equal(legend[0].label, 'A');
  assert.equal(legend.at(-1).key, UNASSIGNED);
  assert.equal(legend.at(-1).count, 5);
  assert.equal(legend.at(-2).key, 'more');
  assert.equal(legend.length, 10);
});

test('defaultColorMode: project when most shown sessions have no summary, else outcome', () => {
  const sum = { summary: JSON.stringify({ v: 2, outcome: 'done' }) };
  assert.equal(defaultColorMode([{}, {}, sum]), 'project');
  assert.equal(defaultColorMode([{}, sum]), 'outcome');
  assert.equal(defaultColorMode([sum, sum, {}]), 'outcome');
  assert.equal(defaultColorMode([]), 'outcome');
  assert.equal(defaultColorMode(null), 'outcome');
});

// ---- clusters + column cap (#30) ----

import {
  mergeKey, clusterDay, MAX_COLS, MERGE_MODES, DEFAULT_MERGE, clusterColor, workspaceLanes, clusterStats,
} from './session-calendar.mjs';

const seg = (id, top, end, e = {}) => ({ top, height: end - top, e: { session_id: id, project_key: 'P', ...e } });
const ids = (item) => item.segs.map((s) => s.e.session_id);

test('mergeKey: project key, client id (Unassigned shared), none = per session, muted kept apart', () => {
  assert.deepEqual(MERGE_MODES, ['project', 'client', 'none']);
  assert.equal(DEFAULT_MERGE, 'project');
  assert.equal(mergeKey({ session_id: 's', project_key: 'P' }, 'project'), 'P');
  assert.equal(mergeKey({ session_id: 's', base_dir: '/b' }, 'project'), '/b');
  assert.equal(mergeKey({ session_id: 's', client_id: 'acme' }, 'client'), 'acme');
  assert.equal(mergeKey({ session_id: 's' }, 'client'), mergeKey({ session_id: 't' }, 'client'));
  assert.notEqual(mergeKey({ session_id: 's', project_key: 'P' }, 'none'), mergeKey({ session_id: 't', project_key: 'P' }, 'none'));
  assert.notEqual(mergeKey({ session_id: 's', project_key: 'P', muted: true }, 'project'), 'P');
});

test('clusterDay merges a chain of overlapping same-project sessions, keeps others apart', () => {
  const items = clusterDay([
    seg('a', 60, 120), seg('b', 100, 200), seg('c', 190, 250), // chain → one cluster
    seg('d', 300, 330), // later, same project → alone
    seg('x', 70, 110, { project_key: 'Q' }), // other project overlapping a
    seg('t', 250, 280), // touches c's end → does not merge
    seg('m', 80, 90, { muted: true }), // muted twin of the same project
  ], 'project');
  const byFirst = Object.fromEntries(items.map((it) => [ids(it)[0], it]));
  assert.deepEqual(ids(byFirst.a), ['a', 'b', 'c']);
  assert.equal(byFirst.a.start, 60); assert.equal(byFirst.a.end, 250);
  assert.match(byFirst.a.id, /^c:/);
  assert.equal(byFirst.d.id, 'd');
  assert.deepEqual(ids(byFirst.x), ['x']);
  assert.deepEqual(ids(byFirst.t), ['t']);
  assert.deepEqual(ids(byFirst.m), ['m']);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((it) => it.start), [...items.map((it) => it.start)].sort((p, q) => p - q), 'sorted by start');
});

test('clusterDay: none never merges; client merges two projects of one client', () => {
  const segs = [seg('a', 60, 120, { client_id: 'k' }), seg('b', 90, 150, { project_key: 'Q', client_id: 'k' })];
  assert.equal(clusterDay(segs, 'none').length, 2);
  assert.equal(clusterDay(segs, 'project').length, 2);
  const [c] = clusterDay(segs, 'client');
  assert.deepEqual(ids(c), ['a', 'b']);
});

test('layoutDay caps columns: extra items fold into +N chips in the last column', () => {
  assert.equal(MAX_COLS, 4);
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, start: 60 + i, end: 200 }));
  const { placed, overflow } = layoutDay([...ten, { id: 'late', start: 300, end: 360 }], { maxCols: 4 });
  assert.deepEqual([...placed.keys()].sort(), ['late', 's0', 's1', 's2']);
  assert.deepEqual(placed.get('s2'), { col: 2, cols: 4 });
  assert.deepEqual(placed.get('late'), { col: 0, cols: 1 });
  assert.equal(overflow.length, 1);
  assert.deepEqual(overflow[0], { id: '+0', col: 3, cols: 4, start: 63, end: 200, ids: ['s3', 's4', 's5', 's6', 's7', 's8', 's9'] });
});

test('layoutDay cap: no chip when the group fits; disjoint hidden ranges give separate chips', () => {
  const four = Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, start: 0, end: 50 }));
  const fit = layoutDay(four, { maxCols: 4 });
  assert.equal(fit.overflow.length, 0);
  assert.deepEqual(fit.placed.get('f3'), { col: 3, cols: 4 });
  // a long anchor keeps one overlap group; two bursts of 4 short ones far apart
  const items = [
    { id: 'long', start: 0, end: 1000 },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, start: 100, end: 150 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, start: 600, end: 650 })),
  ];
  const { overflow } = layoutDay(items, { maxCols: 4 });
  assert.equal(overflow.length, 2);
  assert.deepEqual(overflow.map((o) => [o.start, o.end, o.ids.length]), [[100, 150, 2], [600, 650, 2]]);
});

test('clusterColor: majority bucket, else a mixed stripe of the top colours', () => {
  const done = { summary: JSON.stringify({ v: 2, outcome: 'done' }) };
  const partial = { summary: JSON.stringify({ v: 2, outcome: 'partial' }) };
  const maj = clusterColor([done, done, done, partial], 'outcome');
  assert.equal(maj.mixed, false);
  assert.equal(maj.color, 'var(--status-good)');
  assert.equal(maj.label, 'Done');
  const mix = clusterColor([done, partial], 'outcome');
  assert.equal(mix.mixed, true);
  assert.deepEqual(mix.colors, ['var(--status-good)', 'var(--status-warning)']);
});

test('workspaceLanes: main checkout first, worktrees by name, spans as fractions', () => {
  const lanes = workspaceLanes([
    seg('w2', 150, 200, { workspace: 'agent-office:zeta' }),
    seg('m', 100, 200),
    seg('w1', 100, 150, { workspace: 'agent-office:alpha' }),
    seg('w1b', 150, 175, { workspace: 'agent-office:alpha' }),
  ], 100, 200);
  assert.deepEqual(lanes.map((l) => l.workspace), [null, 'agent-office:alpha', 'agent-office:zeta']);
  assert.equal(lanes[0].label, 'main checkout');
  assert.deepEqual(lanes[1].spans, [{ top: 0, height: 0.5 }, { top: 0.5, height: 0.25 }]);
  assert.deepEqual(lanes[2].spans, [{ top: 0.5, height: 0.5 }]);
});

test('clusterStats sums rollups', () => {
  assert.deepEqual(clusterStats([{ cost_usd: 1, active_s: 60 }, { rollup: { cost_usd: 2.5, active_s: 30 } }]), { sessions: 2, cost_usd: 3.5, active_s: 90 });
});

// ---- dots (#32) inside clusters (#30) ----

import { absorbPoints } from './session-calendar.mjs';

const dot = (id, top, e = {}) => ({ top, height: 0, point: true, e: { session_id: id, project_key: 'P', ...e } });

test('absorbPoints: a dot inside a same-project cluster is counted there and stays a dot member', () => {
  const items = clusterDay([seg('a', 60, 120), seg('b', 100, 200), seg('lone', 300, 360)], 'project');
  const { items: out, points } = absorbPoints(items, [
    dot('in', 150), // inside a+b → joins the cluster
    dot('edge', 200), // at the cluster's end → touching, stays a dot
    dot('other', 150, { project_key: 'Q' }), // other project → stays a dot
    dot('muted', 150, { muted: true }), // muted never merges with work
    dot('solo', 320), // inside a lone block → the block becomes a cluster of 2
  ], 'project');
  const ab = out.find((it) => ids(it).includes('a'));
  assert.deepEqual(ids(ab), ['a', 'b', 'in']);
  assert.equal(ab.start, 60); assert.equal(ab.end, 200, 'a dot never stretches the cluster');
  assert.equal(clusterStats(ab.segs.map((s) => s.e)).sessions, 3);
  const solo = out.find((it) => ids(it).includes('lone'));
  assert.deepEqual(ids(solo), ['lone', 'solo']);
  assert.match(solo.id, /^c:P:lone$/);
  assert.deepEqual(points.map((p) => p.e.session_id), ['edge', 'other', 'muted']);
  // Rendered as a dot when the cluster is expanded: its lane span has no height.
  const lane = workspaceLanes(ab.segs, ab.start, ab.end)[0];
  assert.deepEqual(lane.spans.find((sp) => sp.point), { top: 90 / 140, height: 0, point: true });
});

test('absorbPoints: Merge none keeps every dot standalone; untouched items keep their ids', () => {
  const items = clusterDay([seg('a', 60, 120)], 'none');
  const { items: out, points } = absorbPoints(items, [dot('d', 90)], 'none');
  assert.equal(out[0].id, 'a');
  assert.equal(out[0], items[0]);
  assert.equal(points.length, 1);
});

test('periodRange/shiftPeriod/periodLabel: day span loads from the previous day', () => {
  const d = periodRange(L(9, 15), 'day');
  assert.equal(d.span, 'day');
  assert.equal(+d.since, +L(9));
  assert.equal(+d.until, +L(10));
  assert.equal(d.days.length, 1);
  assert.equal(+d.loadSince, +L(8));
  assert.equal(+shiftPeriod(L(9), 'day', -1), +L(8));
  assert.equal(+shiftPeriod(L(9), 'day', 1), +L(10));
  assert.equal(periodLabel(d), 'Wed 9 Sep 2026');
});
