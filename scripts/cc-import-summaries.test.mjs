import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, getSession } from '../src/lib/cc/store.mjs';
import { importSummaries, pocToSummary } from './cc-import-summaries.mjs';

const entry = (id, over = {}) => ({ session_id: id, title: 'T', what: 'W', outcome: 'exploration', improvements: ['a'], followups: [], kind: 'agent-spawn', skip_reason: 'x', ...over });

test('importSummaries fills missing and v1 summaries, keeps v2, counts unknown ids', () => {
  const db = openStore(':memory:');
  for (const id of ['none', 'v1', 'v2']) upsertSession(db, { session_id: id });
  setSummary(db, 'v1', { summary: JSON.stringify({ what: 'old', outcome: 'done' }), model: 'haiku' });
  setSummary(db, 'v2', { summary: JSON.stringify({ v: 2, what: 'keep', outcome: 'done' }), model: 'claude-sonnet-5-5' });
  const r = importSummaries(db, [entry('none'), entry('v1'), entry('v2'), entry('ghost')]);
  assert.deepEqual(r, { written: 2, kept: 1, missing: 1 });
  const s = JSON.parse(getSession(db, 'v1').session.summary);
  assert.deepEqual([s.v, s.title, s.outcome, s.kind_hint, s.model], [2, 'T', 'exploration', 'agent-spawn', 'sonnet-poc']);
  assert.equal(getSession(db, 'v1').session.summary_model, 'sonnet-poc');
  assert.equal(JSON.parse(getSession(db, 'v2').session.summary).what, 'keep');
});

test('pocToSummary normalises odd values', () => {
  const s = pocToSummary(entry('x', { outcome: 'weird', kind: 'nope', improvements: 'str', followups: [1, 'b'] }), 'm');
  assert.equal(s.outcome, 'partial');
  assert.equal(s.kind_hint, 'work');
  assert.deepEqual(s.improvements, []);
  assert.deepEqual(s.followups, ['b']);
});

test('dryRun writes nothing', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'none' });
  assert.equal(importSummaries(db, [entry('none')], { dryRun: true }).written, 1);
  assert.equal(getSession(db, 'none').session.summary, null);
});
