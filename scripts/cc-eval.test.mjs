import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, getSession } from '../src/lib/cc/store.mjs';
import { evalSummaries } from './cc-eval.mjs';

test('evalSummaries picks only sessions without a summary, newest first, and stops on cli-missing', async () => {
  const db = openStore(':memory:');
  for (const [id, at] of [['a', '2026-08-21T10:00:00Z'], ['b', '2026-08-21T11:00:00Z'], ['c', '2026-08-21T12:00:00Z']]) {
    upsertSession(db, { session_id: id, started_at: at, raw_ref: '/t/' + id });
  }
  setSummary(db, 'c', { summary: '{}', model: 'm' });
  const seen = [];
  const fake = async (d, sid) => { seen.push(sid); setSummary(d, sid, { summary: '{"what":"w","outcome":"done"}', model: 'm' }); return getSession(d, sid); };
  const r = await evalSummaries(db, { limit: 5, log: () => {}, summarizeImpl: fake });
  assert.deepEqual(seen, ['b', 'a']);
  assert.deepEqual([r.ok, r.failed, r.total], [2, 0, 2]);

  const r2 = await evalSummaries(db, { id: 'a', log: () => {}, summarizeImpl: async () => { const e = new Error('x'); e.kind = 'cli-missing'; throw e; } });
  assert.deepEqual([r2.ok, r2.failed], [0, 1]);
});
