import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary } from '../../../../lib/cc/store.mjs';
import { handleGet, handlePost } from './route.js';
import { fileURLToPath } from 'node:url';

// A file that exists, so selectMissing's transcript check keeps the rows.
const HERE = fileURLToPath(import.meta.url);

const NOW = Date.parse('2026-09-30T12:00:00Z');
function db1() {
  const db = openStore(':memory:');
  for (const id of ['a', 'b']) upsertSession(db, { session_id: id, kind: 'main', raw_ref: HERE, started_at: '2026-09-10T10:00:00.000Z', ended_at: '2026-09-10T11:00:00.000Z' });
  return db;
}
const deps = (db) => ({ openDb: () => db, closeDb: () => {}, now: () => NOW, summarizeImpl: async (d, id) => setSummary(d, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done' }), model: 'm' }) });

test('GET without a job; with a range it reports missing + estimate', () => {
  const db = db1();
  assert.deepEqual(handleGet(new URLSearchParams(''), db, NOW), { job: null });
  const r = handleGet(new URLSearchParams('since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z'), db, NOW);
  assert.equal(r.missing, 2);
  assert.equal(r.estimateSeconds, 30);
});

test('POST with ids starts a job over the ids that still need a summary', async () => {
  const db = db1();
  const r = handlePost({ ids: ['a', 'zzz'] }, db, deps(db));
  assert.equal(r.started, true);
  assert.equal(r.total, 1);
  assert.throws(() => handlePost({}, db, deps(db)), /ids or since\/until required/);
});

test('POST clamps concurrency to an integer in 1..8', async () => {
  for (const [given, want] of [[-1, 1], [0, 3], [2.7, 2], [100, 8], ['x', 3]]) {
    const db = db1();
    const r = handlePost({ ids: ['a', 'b'], concurrency: given }, db, deps(db));
    assert.equal(r.job.concurrency, want, `concurrency ${given}`);
  }
});
