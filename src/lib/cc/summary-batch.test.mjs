import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, setParent, getSession } from './store.mjs';
import { selectMissing, estimateBatch, startBatch, readJob, batchModel, rangeBatch, STALE_MS } from './summary-batch.mjs';
import { fileURLToPath } from 'node:url';

// A file that exists, so selectMissing's transcript check keeps the rows.
const HERE = fileURLToPath(import.meta.url);

const NOW = Date.parse('2026-09-30T12:00:00Z');
const row = (id, over = {}) => ({ session_id: id, raw_ref: HERE, kind: 'main', started_at: '2026-09-10T10:00:00.000Z', ended_at: '2026-09-10T11:00:00.000Z', ...over });

function seeded() {
  const db = openStore(':memory:');
  upsertSession(db, row('w1'));
  upsertSession(db, row('w2', { started_at: '2026-09-11T10:00:00.000Z' }));
  upsertSession(db, row('sched', { kind: 'scheduled' }));
  upsertSession(db, row('kid'));
  setParent(db, 'kid', 'w1');
  upsertSession(db, row('fresh', { started_at: '2026-09-30T11:55:00.000Z', ended_at: '2026-09-30T11:58:00.000Z' }));
  upsertSession(db, row('done', { started_at: '2026-09-12T10:00:00.000Z' }));
  setSummary(db, 'done', { summary: JSON.stringify({ v: 2, what: 'x', outcome: 'done' }), model: 'claude-sonnet-5-5' });
  return db;
}

const okImpl = async (db, id) => { setSummary(db, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done', ms: 1000 }), model: 'm' }); };
const shared = (db) => ({ openDb: () => db, closeDb: () => {} });

test('selectMissing by range keeps top-level work sessions without a summary, skips fresh ones', () => {
  const db = seeded();
  assert.deepEqual(selectMissing(db, { since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z', now: NOW }), ['w1', 'w2']);
  assert.deepEqual(selectMissing(db, { since: '2026-09-01T00:00:00Z', kinds: ['work', 'scheduled'], now: NOW }).sort(), ['sched', 'w1', 'w2']);
});

test('selectMissing by ids trusts the caller for visibility but still skips fresh and summarised rows', () => {
  const db = seeded();
  assert.deepEqual(selectMissing(db, { ids: ['kid', 'fresh', 'done', 'sched', 'nope'], now: NOW }).sort(), ['kid', 'sched']);
});

test('estimateBatch uses fallback per model, then the median of recorded ms', () => {
  const db = seeded();
  assert.deepEqual(estimateBatch(db, { count: 7, concurrency: 3, model: 'claude-sonnet-5-5' }), { count: 7, model: 'claude-sonnet-5-5', seconds: 90 });
  assert.equal(estimateBatch(db, { count: 3, concurrency: 3, model: 'haiku' }).seconds, 10);
  for (const [id, ms] of [['w1', 4000], ['w2', 8000], ['sched', 6000]]) setSummary(db, id, { summary: JSON.stringify({ v: 2, what: '', outcome: 'done', ms }), model: 'claude-sonnet-5-5' });
  assert.equal(estimateBatch(db, { count: 4, concurrency: 2, model: 'claude-sonnet-5-5' }).seconds, 12);
  assert.equal(batchModel({}), 'claude-sonnet-5-5');
  assert.equal(batchModel({ CC_SUMMARY_BATCH_MODEL: 'haiku' }), 'haiku');
});

test('startBatch summarises every id, records failures and finishes', async () => {
  const db = seeded();
  const impl = async (d, id) => { if (id === 'w2') { const e = new Error('boom'); e.kind = 'cli-failed'; throw e; } return okImpl(d, id); };
  const { job, started, done } = startBatch(db, { ids: ['w1', 'w2', 'sched'], model: 'm', summarizeImpl: impl, ...shared(db), now: () => NOW });
  assert.equal(started, true);
  assert.equal(job.status, 'running');
  const fin = await done;
  assert.equal(fin.status, 'done');
  assert.equal(fin.done, 2);
  assert.deepEqual(fin.failed.map((f) => [f.id, f.kind]), [['w2', 'cli-failed']]);
  assert.equal(JSON.parse(getSession(db, 'w1').session.summary).what, 'w1');
});

test('cli-missing stops the job without touching the remaining ids', async () => {
  const db = seeded();
  const calls = [];
  const impl = async (_d, id) => { calls.push(id); const e = new Error('no cli'); e.kind = 'cli-missing'; throw e; };
  const fin = await startBatch(db, { ids: ['w1', 'w2', 'sched'], model: 'm', concurrency: 1, summarizeImpl: impl, ...shared(db), now: () => NOW }).done;
  assert.deepEqual(calls, ['w1']);
  assert.equal(fin.status, 'stopped');
  assert.equal(fin.error, 'no cli');
});

test('a second start while a live job runs returns that job; a stale job does not block', async () => {
  const db = seeded();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (d, id) => { await gate; return okImpl(d, id); };
  const first = startBatch(db, { ids: ['w1'], model: 'm', summarizeImpl: slow, ...shared(db), now: () => NOW });
  const second = startBatch(db, { ids: ['w2'], model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW });
  assert.equal(second.started, false);
  assert.equal(second.job.job_id, first.job.job_id);
  release();
  await first.done;

  db.prepare("INSERT INTO summary_jobs (job_id, status, model, total, done, failed, ids, started_at, heartbeat_at) VALUES ('dead', 'running', 'm', 5, 1, '[]', '[]', ?, ?)")
    .run(new Date(NOW - 10 * 60_000).toISOString(), new Date(NOW - STALE_MS - 1000).toISOString());
  assert.equal(readJob(db, 'dead', NOW).status, 'stale');
  const third = startBatch(db, { ids: ['w2'], model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW });
  assert.equal(third.started, true);
  await third.done;
});

test('startBatch with no ids inserts no job row and returns the latest job', async () => {
  const db = seeded();
  const none = startBatch(db, { ids: [], model: 'm', ...shared(db), now: () => NOW });
  assert.equal(none.started, false);
  assert.equal(none.job, null);
  assert.equal(await none.done, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM summary_jobs').get().n, 0);

  const real = await startBatch(db, { ids: ['w1'], model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW }).done;
  const again = startBatch(db, { ids: [], model: 'm', ...shared(db), now: () => NOW });
  assert.equal(again.started, false);
  assert.equal(again.job.job_id, real.job_id);
  assert.equal(again.job.status, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM summary_jobs').get().n, 1);
});

test('rangeBatch: status_only never starts; nothing missing reports the last job; otherwise starts', async () => {
  const db = seeded();
  const range = { since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z' };
  const opts = { model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW, exists: () => true };

  const peek = rangeBatch(db, { ...range, statusOnly: true }, opts);
  assert.equal(peek.started, false);
  assert.equal(peek.job, null);
  assert.equal(peek.missing, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM summary_jobs').get().n, 0);

  const go = rangeBatch(db, range, opts);
  assert.equal(go.started, true);
  assert.equal(go.job.total, 2);
  await go.done;

  const status = rangeBatch(db, { ...range, statusOnly: true }, opts);
  assert.equal(status.started, false);
  assert.equal(status.job.job_id, go.job.job_id);
  assert.equal(status.job.status, 'done');
  assert.equal(status.missing, 0);

  const idle = rangeBatch(db, range, opts);
  assert.equal(idle.started, false);
  assert.equal(idle.job.job_id, go.job.job_id);
  assert.match(idle.note, /nothing/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM summary_jobs').get().n, 1);
});

test('a failing final write does not reject done and still closes the connection', async () => {
  const db = seeded();
  let closed = 0;
  const wrapped = {
    prepare: (sql) => {
      const st = db.prepare(sql);
      if (!/^\s*UPDATE/i.test(sql)) return st;
      return { run: () => { throw new Error('database is locked'); } };
    },
    exec: (sql) => db.exec(sql),
  };
  const r = startBatch(db, { ids: ['w1'], model: 'm', summarizeImpl: okImpl, openDb: () => wrapped, closeDb: () => { closed++; }, now: () => NOW });
  const fin = await r.done;
  assert.equal(fin.status, 'done');
  assert.equal(closed, 1);
});

test('openDb failing resolves done with a stopped job instead of rejecting', async () => {
  const db = seeded();
  const r = startBatch(db, { ids: ['w1'], model: 'm', summarizeImpl: okImpl, openDb: () => { throw new Error('cannot open'); }, closeDb: () => {}, now: () => NOW });
  const fin = await r.done;
  assert.equal(fin.status, 'stopped');
  assert.equal(fin.error, 'cannot open');
});

test('a throwing onProgress neither rejects nor double-counts', async () => {
  const db = seeded();
  const fin = await startBatch(db, { ids: ['w1', 'w2'], model: 'm', summarizeImpl: okImpl, onProgress: () => { throw new Error('cb'); }, ...shared(db), now: () => NOW }).done;
  assert.equal(fin.done, 2);
  assert.deepEqual(fin.failed, []);
});

test('two connections to one file: the second start sees the first connection\'s live job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-batch-'));
  const file = join(dir, 'cc.db');
  const a = openStore(file);
  const b = openStore(file);
  try {
    upsertSession(a, row('w1'));
    upsertSession(a, row('w2', { started_at: '2026-09-11T10:00:00.000Z' }));
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (d, id) => { await gate; return okImpl(d, id); };
    const first = startBatch(a, { ids: ['w1'], model: 'm', summarizeImpl: slow, openDb: () => a, closeDb: () => {}, now: () => NOW });
    const second = startBatch(b, { ids: ['w2'], model: 'm', summarizeImpl: okImpl, openDb: () => b, closeDb: () => {}, now: () => NOW });
    assert.equal(second.started, false);
    assert.equal(second.job.job_id, first.job.job_id);
    release();
    assert.equal((await first.done).status, 'done');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectMissing skips sessions whose transcript is gone (range and ids)', () => {
  const db = seeded();
  upsertSession(db, row('gone', { raw_ref: '/nowhere/gone.jsonl' }));
  upsertSession(db, row('gem', { raw_ref: '/g/conversations.db', model: 'gemini-3' }));
  const present = new Set([HERE, '/g/conversations.db']);
  const exists = (p) => present.has(p);
  assert.deepEqual(selectMissing(db, { since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z', now: NOW, exists }).sort(), ['gem', 'w1', 'w2']);
  assert.deepEqual(selectMissing(db, { ids: ['gone', 'w1'], now: NOW, exists }), ['w1']);
  // Default check hits the real filesystem.
  assert.deepEqual(selectMissing(db, { ids: ['gone', 'w1'], now: NOW }), ['w1']);
});
