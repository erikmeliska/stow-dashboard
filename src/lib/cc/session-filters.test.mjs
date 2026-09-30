import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSessions, QUALITY_FILTERS } from './session-filters.mjs'

const SESSIONS = [
  { session_id: 'a', ticket_id: 'TRI-STOW-0003', project_dir: '/p/stow-dashboard', model: 'claude-opus-4-8', quality_score: 92 },
  { session_id: 'b', ticket_id: 'INT-42', project_dir: '/p/intelimail', model: 'gemini-3.8-flash', quality_score: 61 },
  { session_id: 'c', ticket_id: null, project_dir: '/p/vydavatelstvo/repos/singularita-24-tempo', model: 'gemini-3.8-flash', quality_score: 40 },
  { session_id: 'd', ticket_id: null, project_dir: '/p/sandbox', model: 'claude-sonnet-4-6', quality_score: null },
]
const ids = (rows) => rows.map((s) => s.session_id)

test('no filters returns everything', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, {})), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: '', quality: 'any', model: 'any' })), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: '', quality: 'any', model: 'any' })), ['a', 'b', 'c', 'd'])
})

test('ticket filter matches substring, case-insensitively', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'stow' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'INT' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'nope' })), [])
})

test('search filter matches either ticket or project directory', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'stow' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'singularita' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'vydavatelstvo' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'INT-42' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'SANDBOX' })), ['d'])
})

test('model filter matches exact model case-insensitively or any', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'gemini-3.8-flash' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'GEMINI-3.8-FLASH' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'claude-opus-4-8' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'any' })), ['a', 'b', 'c', 'd'])
})

test('ticket filter ignores surrounding whitespace', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: '  int-42  ' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: '  singularita-24  ' })), ['c'])
})

test('quality thresholds include only scored sessions', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'q90' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'q50' })), ['a', 'b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'low' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'unscored' })), ['d'])
})

test('filters combine (AND)', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'p/', quality: 'q90' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'p/', model: 'gemini-3.8-flash' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'singularita', model: 'claude-opus-4-8' })), [])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'INT', quality: 'q90' })), [])
})

test('unknown quality key behaves like any', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'junk' })), ['a', 'b', 'c', 'd'])
})

test('QUALITY_FILTERS exposes labels for the UI in menu order', () => {
  assert.deepEqual(Object.keys(QUALITY_FILTERS), ['any', 'q90', 'q75', 'q50', 'low', 'unscored'])
  for (const { label } of Object.values(QUALITY_FILTERS)) assert.equal(typeof label, 'string')
})

import { QUICK_FILTERS, SOURCE_FILTERS, sourceOf } from './session-filters.mjs';

test('sourceOf buckets entrypoints', () => {
  assert.equal(sourceOf({ entrypoint: 'cli' }), 'cli');
  assert.equal(sourceOf({ entrypoint: 'claude-desktop' }), 'desktop');
  assert.equal(sourceOf({ entrypoint: 'sdk-py' }), 'sdk');
  assert.equal(sourceOf({ entrypoint: 'antigravity-cli' }), 'antigravity');
  assert.equal(sourceOf({}), 'other');
  assert.ok(Object.keys(SOURCE_FILTERS).includes('sdk'));
});

test('source and quick filters', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const rows = [
    { session_id: 'a', entrypoint: 'cli', sub_count: 3, guard_hits: 0, rollup: { cost_usd: 80, active_s: 100 }, summary: null, ended_at: '2026-09-15T11:55:00Z' },
    { session_id: 'b', entrypoint: 'claude-desktop', sub_count: 0, guard_hits: 2, rollup: { cost_usd: 5, active_s: 9000 }, summary: '{}', ended_at: '2026-09-15T09:00:00Z' },
  ];
  const ids = (o) => filterSessions(rows, { ...o, now }).map((r) => r.session_id);
  assert.deepEqual(ids({ source: 'cli' }), ['a']);
  assert.deepEqual(ids({ source: 'desktop' }), ['b']);
  assert.deepEqual(ids({ quick: ['subs'] }), ['a']);
  assert.deepEqual(ids({ quick: ['guard'] }), ['b']);
  assert.deepEqual(ids({ quick: ['expensive'] }), ['a']);
  assert.deepEqual(ids({ quick: ['long'] }), ['b']);
  assert.deepEqual(ids({ quick: ['nosummary'] }), ['a']);
  assert.deepEqual(ids({ quick: ['active'] }), ['a']);
  assert.deepEqual(ids({ quick: ['subs', 'guard'] }), [], 'quick filters AND together');
  assert.deepEqual(ids({ search: 'feat/x' }), [], 'search also covers branch');
  assert.deepEqual(filterSessions([{ git_branch: 'feat/x-1' }], { search: 'feat/x' }).length, 1);
  assert.ok(Object.keys(QUICK_FILTERS).length >= 6);
});

test('sourceOf buckets Codex entrypoints', () => {
  assert.equal(sourceOf({ entrypoint: 'codex-desktop' }), 'codex')
  assert.equal(SOURCE_FILTERS.codex, 'Codex')
  assert.equal(filterSessions([{ entrypoint: 'codex-cli' }, { entrypoint: 'cli' }], { source: 'codex' }).length, 1)
})

test('search also matches the display title', () => {
  const rows = [{ session_id: 'a', title: 'Fix login redirect', title_source: 'prompt' }, { session_id: 'b', summary: JSON.stringify({ v: 2, title: 'Pricing sync' }) }];
  assert.deepEqual(filterSessions(rows, { search: 'login' }).map((r) => r.session_id), ['a']);
  assert.deepEqual(filterSessions(rows, { search: 'pricing' }).map((r) => r.session_id), ['b']);
});
