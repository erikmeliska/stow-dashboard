import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits, listSessions, getSession } from './store.mjs';

function seed() {
  const db = openStore(':memory:');
  upsertSession(db, {
    session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'claude-opus-5',
    started_at: '2026-08-21T10:00:00Z', ended_at: '2026-08-21T10:30:00Z',
    duration_s: 1800, active_s: 900, input_tokens: 100, output_tokens: 200,
    cache_read: 50, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0.42,
    turns: 12, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: '2026-08-21T11:00:00Z',
  });
  replaceTools(db, 's1', { Bash: 5, Read: 2 });
  replaceSkills(db, 's1', { 'superpowers:brainstorming': 1 }, new Set(['superpowers:brainstorming']));
  replaceGuardHits(db, 's1', [{ ts: '2026-08-21T10:05:00Z', command: 'rm -rf /', rule: 'rm-rf-dangerous', action: 'deny' }]);
  return db;
}

test('upsert + get returns the full session', () => {
  const db = seed();
  const got = getSession(db, 's1');
  assert.equal(got.session.cost_usd, 0.42);
  assert.equal(got.tools.find((t) => t.tool === 'Bash').count, 5);
  assert.equal(got.skills[0].edited, 1);
  assert.equal(got.guard_hits[0].action, 'deny');
});

test('upsert is idempotent (replace, not duplicate)', () => {
  const db = seed();
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'x', started_at: null, ended_at: null, duration_s: 0, active_s: 0, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: 'now' });
  replaceTools(db, 's1', { Bash: 9 });
  assert.equal(listSessions(db, {}).length, 1);
  assert.equal(getSession(db, 's1').tools.find((t) => t.tool === 'Bash').count, 9);
});

test('listSessions filters by project and orders newest first', () => {
  const db = seed();
  upsertSession(db, { session_id: 's2', project_dir: '/p/b', cwd: '/p/b', model: 'x', started_at: '2026-08-21T12:00:00Z', ended_at: '2026-08-21T12:10:00Z', duration_s: 600, active_s: 100, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: '/t/s2.jsonl', ingested_at: 'now' });
  assert.equal(listSessions(db, { project: '/p/a' }).length, 1);
  assert.equal(listSessions(db, {})[0].session_id, 's2');
});

test('getSession returns null for unknown id', () => {
  assert.equal(getSession(seed(), 'nope'), null);
});

import { DatabaseSync } from 'node:sqlite';
import { setSummary } from './store.mjs';

test('openStore migrates an old phase-1 DB in place', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_dir TEXT, started_at TEXT, jira_ticket TEXT, quality_score REAL, summary TEXT)');
  raw.exec("INSERT INTO sessions (session_id) VALUES ('old')");
  const db = openStore(raw);
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  for (const c of ['ticket_id', 'ticket_source', 'pr', 'quality_detail', 'summary_model', 'summarized_at']) assert.ok(cols.includes(c), c);
  assert.equal(getSession(db, 'old').session.session_id, 'old');
});

test('re-upsert keeps the summary, setSummary writes it', () => {
  const db = seed();
  setSummary(db, 's1', { summary: '{"what":"x"}', model: 'claude-haiku-4-5', at: '2026-08-21T12:00:00Z' });
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', model: 'y', ticket_id: 'ABC-1', ticket_source: 'branch', git_branch: 'feat/ABC-1', quality_score: 80, quality_detail: '{"verified":true}' });
  const s = getSession(db, 's1').session;
  assert.equal(s.summary, '{"what":"x"}');
  assert.equal(s.summary_model, 'claude-haiku-4-5');
  assert.equal(s.model, 'y');
  assert.equal(s.ticket_id, 'ABC-1');
  assert.equal(s.quality_score, 80);
});

import { getIngestState, setIngestState, clearIngestState } from './store.mjs';

test('ingest state round-trips and upserts by path', () => {
  const db = openStore(':memory:');
  setIngestState(db, '/t/a.jsonl', 'a', 'sig1');
  setIngestState(db, '/t/a.jsonl', 'a', 'sig2');
  setIngestState(db, '/t/b.jsonl', 'b', 'sigb');
  const st = getIngestState(db);
  assert.equal(st.size, 2);
  assert.deepEqual(st.get('/t/a.jsonl'), { session_id: 'a', signature: 'sig2' });
  clearIngestState(db);
  assert.equal(getIngestState(db).size, 0);
});
