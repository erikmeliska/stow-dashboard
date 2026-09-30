import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary, summaryVersion, displayTitle, needsSummary, MIN_AGE_MS } from './summary-view.mjs';

const v2 = JSON.stringify({ v: 2, title: 'LLM title', what: 'w', outcome: 'done' });
const v1 = JSON.stringify({ what: 'w', outcome: 'done' });

test('parseSummary / summaryVersion tolerate null, v1 and broken JSON', () => {
  assert.equal(parseSummary({ summary: null }), null);
  assert.equal(parseSummary({ summary: '{nope' }), null);
  assert.equal(parseSummary({ summary: '"str"' }), null);
  assert.equal(summaryVersion({ summary: null }), 0);
  assert.equal(summaryVersion({ summary: '{nope' }), 0);
  assert.equal(summaryVersion({ summary: v1 }), 1);
  assert.equal(summaryVersion({ summary: v2 }), 2);
});

test('displayTitle: custom > summary > ai > prompt', () => {
  assert.equal(displayTitle({ title: 'Mine', title_source: 'custom', summary: v2 }), 'Mine');
  assert.equal(displayTitle({ title: 'AI', title_source: 'ai', summary: v2 }), 'LLM title');
  assert.equal(displayTitle({ title: 'AI', title_source: 'ai', summary: v1 }), 'AI');
  assert.equal(displayTitle({ title: 'first prompt', title_source: 'prompt', summary: '{bad' }), 'first prompt');
  assert.equal(displayTitle({}), null);
});

test('needsSummary skips fresh sessions, rows without transcript, and already summarised ones', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const old = { raw_ref: '/t', ended_at: '2026-09-30T11:00:00Z' };
  assert.equal(needsSummary(old, { now }), true);
  assert.equal(needsSummary({ ...old, raw_ref: null }, { now }), false);
  assert.equal(needsSummary({ raw_ref: '/t', ended_at: new Date(now - MIN_AGE_MS + 1000).toISOString() }, { now }), false);
  assert.equal(needsSummary({ raw_ref: '/t', ended_at: null, started_at: '2026-09-30T11:00:00Z' }, { now }), true);
  assert.equal(needsSummary({ ...old, summary: v1 }, { now }), false);
  assert.equal(needsSummary({ ...old, summary: v1 }, { now, force: 'upgrade' }), true);
  assert.equal(needsSummary({ ...old, summary: v2 }, { now, force: 'upgrade' }), false);
  assert.equal(needsSummary({ ...old, summary: v2 }, { now, force: true }), true);
});
