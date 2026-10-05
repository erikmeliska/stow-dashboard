import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, concurrencyProfile, onDay, packTracks, POINT_MIN, timelineBars, timeWindow } from './session-timeline.mjs';
import { UNASSIGNED } from './session-projects.mjs';

const L = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m); // October 2026, local
const iso = (d) => d.toISOString();
const DAY = L(5);
let n = 0;
const S = (h0, m0, h1, m1, extra = {}) => ({
  session_id: extra.session_id || `s${++n}`,
  started_at: iso(L(5, h0, m0)), ended_at: iso(L(5, h1, m1)), active_s: 600,
  project_key: 'git:a', project_name: 'A', client_id: 'acme', client_name: 'Acme', workspace: null,
  agents: [], children: [], ...extra,
});

test('timelineBars: minutes from midnight, same placement as the week view', () => {
  const [b] = timelineBars([S(9, 0, 10, 30)], DAY);
  assert.equal(b.start, 540);
  assert.equal(b.end, 630);
  assert.equal(b.point, false);
  const [tiny] = timelineBars([S(9, 0, 9, 2)], DAY); // 2 min, 600 s active → 15-min minimum
  assert.equal(tiny.end - tiny.start, 15);
});

test('timelineBars: a session from the previous evening is clipped at 0:00, other days dropped', () => {
  const prev = { ...S(0, 0, 0, 0), started_at: iso(L(4, 23)), ended_at: iso(L(5, 1)) };
  const other = { ...S(0, 0, 0, 0), started_at: iso(L(6, 9)), ended_at: iso(L(6, 10)) };
  const bars = timelineBars([prev, other], DAY);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].start, 0);
  assert.equal(bars[0].end, 60);
  assert.equal(bars[0].continued, true);
});

test('timelineBars: a zero-minute session is a point; its extent reserves POINT_MIN', () => {
  const [p] = timelineBars([S(9, 0, 9, 1, { active_s: 10 })], DAY);
  assert.equal(p.point, true);
  assert.equal(p.start, p.end);
  assert.equal(p.extentEnd, p.start + POINT_MIN);
});

test('timelineBars: children and agents become subs at their own times and widen the extent', () => {
  const e = S(9, 0, 10, 0, {
    agents: [{ agent_id: 'a1', started_at: iso(L(5, 9, 10)), ended_at: iso(L(5, 9, 40)), active_s: 300 }],
    children: [{ session_id: 'c1', started_at: iso(L(5, 10, 5)), ended_at: iso(L(5, 10, 30)), active_s: 120 }],
  });
  const [b] = timelineBars([e], DAY);
  assert.deepEqual(b.subs.map((s) => [s.id, s.kind, s.start, s.end]), [['a1', 'agent', 550, 580], ['c1', 'child', 605, 630]]);
  assert.equal(b.extentStart, 540);
  assert.equal(b.extentEnd, 630);
});

test('packTracks: overlapping bars stack, touching ones share a track', () => {
  const bars = timelineBars([S(9, 0, 10, 0, { session_id: 'x' }), S(9, 30, 11, 0, { session_id: 'y' }), S(10, 0, 10, 30, { session_id: 'z' })], DAY);
  const tracks = packTracks(bars);
  assert.deepEqual(tracks.map((t) => t.map((b) => b.id)), [['x', 'z'], ['y']]);
});

test('packTracks: a child outside the parent keeps its space', () => {
  const parent = S(9, 0, 9, 30, { session_id: 'p', children: [{ session_id: 'c', started_at: iso(L(5, 9, 45)), ended_at: iso(L(5, 10, 15)), active_s: 120 }] });
  const tracks = packTracks(timelineBars([parent, S(9, 50, 10, 30, { session_id: 'q' })], DAY));
  assert.equal(tracks.length, 2);
});

test('concurrencyProfile: peak of overlapping sessions, touching ones not counted together, points ignored', () => {
  const bars = timelineBars([S(9, 0, 10, 0), S(9, 30, 10, 30), S(9, 45, 9, 50, { active_s: 600 }), S(10, 30, 11, 0), S(9, 40, 9, 41, { active_s: 5 })], DAY);
  const { peak, steps } = concurrencyProfile(bars);
  assert.equal(peak, 3);
  assert.equal(steps[0].start, 540);
  assert.equal(steps.at(-1).end, 660);
  assert.ok(steps.every((s) => s.count > 0 && s.end > s.start));
  assert.deepEqual(concurrencyProfile([]), { steps: [], peak: 0 });
});

test('buildTimeline: client → project → workspace, cost order, Unassigned and main checkout first/last', () => {
  const events = [
    S(9, 0, 10, 0, { session_id: 'a-main', cost_usd: 1 }),
    S(9, 10, 10, 0, { session_id: 'a-w2', workspace: 'agent-office:zeta', cost_usd: 1 }),
    S(9, 20, 10, 0, { session_id: 'a-w1', workspace: 'agent-office:byte-22a4', cost_usd: 1 }),
    S(9, 0, 10, 0, { session_id: 'b', project_key: 'git:b', project_name: 'B', cost_usd: 5 }),
    S(9, 0, 10, 0, { session_id: 'u', project_key: null, project_name: null, base_dir: '/x/loose', client_id: null, client_name: null, cost_usd: 99 }),
    S(9, 0, 10, 0, { session_id: 'z', project_key: 'git:z', project_name: 'Z', client_id: 'zed', client_name: 'Zed', cost_usd: 2 }),
  ];
  const tl = buildTimeline(events, DAY);
  assert.deepEqual(tl.map((c) => c.id), ['acme', 'zed', UNASSIGNED]);
  assert.equal(tl[2].name, 'Unassigned');
  assert.equal(tl[2].unassigned, true);
  assert.equal(tl[2].projects[0].name, 'loose');
  const acme = tl[0];
  assert.deepEqual(acme.projects.map((p) => p.key), ['git:b', 'git:a']);
  const a = acme.projects[1];
  assert.deepEqual(a.lanes.map((l) => l.label), ['main checkout', 'agent-office: byte-22a4', 'agent-office: zeta']);
  assert.equal(a.peak, 3);
  assert.equal(a.stats.sessions, 3);
  assert.equal(acme.peak, 4);
  assert.equal(acme.stats.sessions, 4);
});

test('buildTimeline: same workspace overlapping sessions get two tracks in one lane', () => {
  const tl = buildTimeline([S(9, 0, 10, 0), S(9, 30, 10, 30)], DAY);
  assert.equal(tl[0].projects[0].lanes.length, 1);
  assert.equal(tl[0].projects[0].lanes[0].tracks.length, 2);
});

test('timeWindow: whole hours around the bars, minimum span, default for an empty day', () => {
  assert.deepEqual(timeWindow([]), { startHour: 8, endHour: 18 });
  const bars = timelineBars([S(9, 15, 13, 40)], DAY);
  assert.deepEqual(timeWindow(bars), { startHour: 9, endHour: 14 });
  assert.deepEqual(timeWindow(timelineBars([S(10, 0, 10, 30)], DAY)), { startHour: 10, endHour: 14 });
  assert.deepEqual(timeWindow(timelineBars([S(22, 0, 23, 30)], DAY)), { startHour: 20, endHour: 24 });
});

test('onDay: keeps families that reach the day, incl. one from the previous evening', () => {
  const prev = { ...S(0, 0, 0, 0, { session_id: 'prev' }), started_at: iso(L(4, 23)), ended_at: iso(L(5, 1)) };
  const before = { ...S(0, 0, 0, 0, { session_id: 'before' }), started_at: iso(L(4, 9)), ended_at: iso(L(4, 10)) };
  assert.deepEqual(onDay([prev, before, S(9, 0, 10, 0, { session_id: 'today' })], DAY).map((e) => e.session_id), ['prev', 'today']);
});
