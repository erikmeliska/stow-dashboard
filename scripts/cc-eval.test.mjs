import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary } from '../src/lib/cc/store.mjs';
import { evalSummaries } from './cc-eval.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
function db1() {
  const db = openStore(':memory:');
  for (const [id, day] of [['a', '01'], ['b', '02'], ['c', '03']]) upsertSession(db, { session_id: id, kind: 'main', raw_ref: `/t/${id}`, started_at: `2026-09-${day}T10:00:00.000Z`, ended_at: `2026-09-${day}T11:00:00.000Z` });
  setSummary(db, 'b', { summary: JSON.stringify({ what: 'old', outcome: 'done' }), model: 'haiku' });
  return db;
}
const ok = async (db, id) => setSummary(db, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done' }), model: 'm' });

test('evalSummaries without a range takes the newest `limit` missing sessions', async () => {
  const db = db1();
  const r = await evalSummaries(db, { limit: 1, log: () => {}, summarizeImpl: ok, now: NOW });
  assert.deepEqual(r, { ok: 1, failed: 0, total: 1 });
  assert.equal(JSON.parse(db.prepare("SELECT summary FROM sessions WHERE session_id = 'c'").get().summary).what, 'c');
});

test('evalSummaries with a range and --upgrade redoes v1 summaries too', async () => {
  const db = db1();
  const r = await evalSummaries(db, { since: '2026-09-01', until: '2026-10-01', force: 'upgrade', log: () => {}, summarizeImpl: ok, now: NOW });
  assert.equal(r.total, 3);
});

test('evalSummaries --id runs one session and reports cli-missing', async () => {
  const db = db1();
  const r = await evalSummaries(db, { id: 'a', log: () => {}, summarizeImpl: async () => { const e = new Error('x'); e.kind = 'cli-missing'; throw e; }, now: NOW });
  assert.deepEqual(r, { ok: 0, failed: 1, total: 1 });
});
