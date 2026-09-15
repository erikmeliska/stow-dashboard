import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionTree, familyOf, sumRows } from './session-tree.mjs';

const P = { session_id: 'p', started_at: '2026-09-15T10:00:00Z', cost_usd: 10, active_s: 600, duration_s: 3600, turns: 40, input_tokens: 1000, output_tokens: 500, cache_read: 100 };
const C1 = { session_id: 'c1', parent_session_id: 'p', kind: 'security-review', started_at: '2026-09-15T10:30:00Z', cost_usd: 1, active_s: 30, duration_s: 40, turns: 3, input_tokens: 50, output_tokens: 20, cache_read: 0 };
const C2 = { session_id: 'c2', parent_session_id: 'p', kind: 'security-review', started_at: '2026-09-15T10:10:00Z', cost_usd: 2, active_s: 20, duration_s: 25, turns: 2, input_tokens: 40, output_tokens: 10, cache_read: 0 };
const A1 = { agent_id: 'agent-1', session_id: 'p', agent_type: 'Explore', started_at: '2026-09-15T10:05:00Z', cost_usd: 3, active_s: 100, turns: 5, input_tokens: 300, output_tokens: 100, cache_read: 50 };
const O = { session_id: 'o', started_at: '2026-09-14T10:00:00Z', cost_usd: 5, active_s: 10, turns: 1 };

test('sumRows is null-safe', () => {
  assert.equal(sumRows([{ cost_usd: 1 }, { cost_usd: null }, null]).cost_usd, 1);
  assert.equal(sumRows([]).turns, 0);
});

test('familyOf: own = parent minus nested agents; rollup = parent plus linked children', () => {
  const f = familyOf(P, [A1], [C1, C2]);
  assert.equal(f.sub_count, 3);
  assert.deepEqual(f.children.map((c) => c.session_id), ['c2', 'c1'], 'children oldest-first');
  assert.equal(f.own.cost_usd, 7);
  assert.equal(f.own.active_s, 500);
  assert.equal(f.own.turns, 40, 'turns are main-only already');
  assert.equal(f.agents_sum.cost_usd, 3);
  assert.equal(f.children_sum.cost_usd, 3);
  assert.equal(f.rollup.cost_usd, 13);
  assert.equal(f.rollup.active_s, 650);
  assert.equal(f.rollup.turns, 45);
  assert.equal(f.rollup.input_tokens, 1090);
  assert.equal(f.rollup.duration_s, 3600, 'duration is wall-clock of the main session, not summed');
});

test('familyOf never reports negative own numbers', () => {
  const f = familyOf({ ...P, cost_usd: 1 }, [A1], []);
  assert.equal(f.own.cost_usd, 0);
});

test('buildSessionTree nests children under present parents, newest family first', () => {
  const tree = buildSessionTree([C1, O, P, C2], [A1]);
  assert.deepEqual(tree.map((f) => f.session_id), ['p', 'o']);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].agents.length, 1);
  assert.equal(tree[1].sub_count, 0);
  assert.equal(tree[1].rollup.cost_usd, 5);
});

test('buildSessionTree keeps a child whose parent is not in the list as its own top-level row', () => {
  const tree = buildSessionTree([C1], []);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].session_id, 'c1');
  assert.equal(tree[0].rollup.cost_usd, 1);
});

import { groupFamilies, sortFamilies, GROUP_BY } from './session-tree.mjs';

const fams = [
  { session_id: '1', started_at: '2026-09-15T10:00:00Z', project_dir: '/p/a', git_branch: 'main', ticket_id: 'AB-1', model: 'm1', rollup: { cost_usd: 1, active_s: 10, turns: 1, input_tokens: 10, output_tokens: 1, cache_read: 0, duration_s: 0 }, sub_count: 0, quality_score: 50 },
  { session_id: '2', started_at: '2026-09-14T10:00:00Z', project_dir: '/p/b', git_branch: 'main', ticket_id: null, model: 'm1', rollup: { cost_usd: 5, active_s: 5, turns: 9, input_tokens: 100, output_tokens: 1, cache_read: 0, duration_s: 0 }, sub_count: 2, quality_score: null },
  { session_id: '3', started_at: '2026-09-08T10:00:00Z', project_dir: '/p/a', git_branch: 'feat', ticket_id: 'AB-1', model: 'm2', rollup: { cost_usd: 3, active_s: 50, turns: 4, input_tokens: 1, output_tokens: 1, cache_read: 0, duration_s: 0 }, sub_count: 1, quality_score: 90 },
];

test('groupFamilies: none → one group with the grand total', () => {
  const g = groupFamilies(fams, 'none');
  assert.equal(g.length, 1);
  assert.equal(g[0].count, 3);
  assert.equal(g[0].sum.cost_usd, 9);
});

test('groupFamilies: by project sorted by cost, label is the dir name', () => {
  const g = groupFamilies(fams, 'project');
  assert.deepEqual(g.map((x) => [x.label, x.count, x.sum.cost_usd]), [['b', 1, 5], ['a', 2, 4]]);
});

test('groupFamilies: by ticket/branch buckets the missing ones', () => {
  assert.deepEqual(groupFamilies(fams, 'ticket').map((x) => x.key), ['(no ticket)', 'AB-1'], 'costliest bucket first');
  assert.deepEqual(groupFamilies(fams, 'branch').map((x) => x.key), ['main', 'feat']);
});

test('groupFamilies: by day/week newest first, ISO weeks', () => {
  const days = groupFamilies(fams, 'day').map((x) => x.key);
  assert.equal(days.length, 3);
  assert.ok(days[0] > days[1] && days[1] > days[2]);
  const weeks = groupFamilies(fams, 'week').map((x) => x.key);
  assert.equal(weeks.length, 2, '15th and 14th Sep 2026 share an ISO week? no — Sep 14 2026 is a Monday, so 14+15 share W38');
  assert.match(weeks[0], /^2026-W\d\d$/);
  assert.ok(Object.keys(GROUP_BY).includes('model'));
});

test('sortFamilies sorts by package numbers, stable, both directions', () => {
  assert.deepEqual(sortFamilies(fams, { key: 'cost_usd', dir: 'desc' }).map((f) => f.session_id), ['2', '3', '1']);
  assert.deepEqual(sortFamilies(fams, { key: 'active_s', dir: 'asc' }).map((f) => f.session_id), ['2', '1', '3']);
  assert.deepEqual(sortFamilies(fams, { key: 'quality_score', dir: 'desc' }).map((f) => f.session_id), ['3', '1', '2'], 'unscored last');
  assert.deepEqual(sortFamilies(fams, { key: 'sub_count', dir: 'desc' }).map((f) => f.session_id), ['2', '3', '1']);
  assert.deepEqual(sortFamilies(fams, { key: 'nope' }).map((f) => f.session_id), ['1', '2', '3']);
});
