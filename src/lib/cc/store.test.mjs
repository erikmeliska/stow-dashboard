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

import { replaceSubagents, listSubagents, setParent, listUnlinked, listParentCandidates } from './store.mjs';

function row(id, extra = {}) {
  return { session_id: id, project_dir: '/p/a', cwd: '/p/a', model: 'x', started_at: '2026-09-15T10:00:00Z', ended_at: '2026-09-15T11:00:00Z', duration_s: 3600, active_s: 100, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 1, turns: 1, status: 'done', raw_ref: `/t/${id}.jsonl`, ingested_at: 'now', kind: 'main', entrypoint: 'cli', ...extra };
}

test('subagents are stored per session and replaced whole', () => {
  const db = openStore(':memory:');
  upsertSession(db, row('s1'));
  replaceSubagents(db, 's1', [{ agent_id: 'agent-a1', agent_type: 'Explore', description: 'find callers', model: 'claude-haiku-4-5', cost_usd: 0.1, active_s: 30, turns: 4, input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0, started_at: '2026-09-15T10:05:00Z', ended_at: '2026-09-15T10:05:30Z', raw_ref: '/t/a1' }]);
  assert.equal(getSession(db, 's1').agents[0].description, 'find callers');
  replaceSubagents(db, 's1', [{ agent_id: 'agent-a2', agent_type: 'general-purpose' }]);
  assert.deepEqual(listSubagents(db, ['s1']).map((a) => a.agent_id), ['agent-a2']);
  assert.deepEqual(listSubagents(db, []), []);
});

test('parent links: upsert never clears them, listSessions returns children alongside parents', () => {
  const db = openStore(':memory:');
  upsertSession(db, row('p'));
  upsertSession(db, row('c', { kind: 'security-review', entrypoint: 'sdk-py', started_at: '2026-09-15T10:30:00Z', ended_at: '2026-09-15T10:30:40Z' }));
  assert.deepEqual(listUnlinked(db, ['security-review']).map((s) => s.session_id), ['c']);
  setParent(db, 'c', 'p');
  upsertSession(db, row('c', { kind: 'security-review', entrypoint: 'sdk-py' }));
  assert.equal(getSession(db, 'c').session.parent_session_id, 'p', 're-parse keeps the link');
  assert.equal(getSession(db, 'c').parent.session_id, 'p');
  assert.deepEqual(getSession(db, 'p').children.map((s) => s.session_id), ['c']);
  assert.deepEqual(listUnlinked(db, ['security-review']), []);

  upsertSession(db, row('other', { project_dir: '/p/b', started_at: '2026-09-16T10:00:00Z' }));
  const list = listSessions(db, { limit: 1 });
  assert.deepEqual(list.map((s) => s.session_id), ['other'], 'limit counts top-level rows only');
  const forA = listSessions(db, { project: '/p/a' });
  assert.deepEqual(forA.map((s) => s.session_id).sort(), ['c', 'p'], 'children ride along with their parent');
});

test('listParentCandidates: Claude main sessions running at the child start, any directory, with slack past ended_at', () => {
  const db = openStore(':memory:');
  upsertSession(db, row('running', { started_at: '2026-09-15T09:00:00Z', ended_at: '2026-09-15T12:00:00Z' }));
  upsertSession(db, row('just-ended', { started_at: '2026-09-15T09:00:00Z', ended_at: '2026-09-15T10:29:30Z' }));
  upsertSession(db, row('long-ended', { started_at: '2026-09-15T08:00:00Z', ended_at: '2026-09-15T09:00:00Z' }));
  upsertSession(db, row('later', { started_at: '2026-09-15T10:45:00Z', ended_at: '2026-09-15T12:00:00Z' }));
  upsertSession(db, row('elsewhere', { project_dir: '/p/b', started_at: '2026-09-15T09:00:00Z', ended_at: '2026-09-15T12:00:00Z' }));
  upsertSession(db, row('gemini', { entrypoint: 'antigravity', started_at: '2026-09-15T09:00:00Z', ended_at: '2026-09-15T12:00:00Z' }));
  upsertSession(db, row('sibling-child', { kind: 'security-review', started_at: '2026-09-15T09:00:00Z', ended_at: '2026-09-15T12:00:00Z' }));
  const c = listParentCandidates(db, { project_dir: '/p/a', started_at: '2026-09-15T10:30:00Z' });
  assert.deepEqual(c.map((s) => s.session_id).sort(), ['elsewhere', 'just-ended', 'running']);
  assert.deepEqual(listParentCandidates(db, { started_at: 'x' }), []);
});

test('listUnlinked honours the retry window', () => {
  const db = openStore(':memory:');
  upsertSession(db, row('old', { kind: 'security-review', started_at: '2026-09-01T10:00:00Z' }));
  upsertSession(db, row('new', { kind: 'security-review', started_at: '2026-09-15T10:00:00Z' }));
  assert.deepEqual(listUnlinked(db, ['security-review']).map((s) => s.session_id).sort(), ['new', 'old']);
  assert.deepEqual(listUnlinked(db, ['security-review'], { since: '2026-09-10T00:00:00Z' }).map((s) => s.session_id), ['new']);
});

test('openStore adding the kind column forgets incremental ingest state (forces one re-parse)', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_dir TEXT, started_at TEXT, quality_score REAL, summary TEXT)');
  raw.exec("CREATE TABLE ingest_state (path TEXT PRIMARY KEY, session_id TEXT, signature TEXT, ingested_at TEXT)");
  raw.exec("INSERT INTO ingest_state VALUES ('/t/x', 'x', 'sig', 'now')");
  const db = openStore(raw);
  assert.equal(db.prepare('SELECT count(*) n FROM ingest_state').get().n, 0);
  assert.ok(db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'parent_session_id'));
});

test('listSessions carries a guard_hits count per row', () => {
  const db = seed();
  assert.equal(listSessions(db)[0].guard_hits, 1);
});

test('openStore migrates title/title_source/user_prompts and forces a re-parse', () => {
  const raw = new DatabaseSync(':memory:');
  // An older DB: has kind (phase 1b) but not the title columns. project_dir/started_at are needed by SCHEMA's indexes.
  raw.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_dir TEXT, started_at TEXT, kind TEXT, entrypoint TEXT, parent_session_id TEXT)");
  raw.exec("CREATE TABLE ingest_state (path TEXT PRIMARY KEY, session_id TEXT, signature TEXT, ingested_at TEXT)");
  raw.exec("INSERT INTO ingest_state VALUES ('/f', 's', 'sig', 'now')");
  const db = openStore(raw);
  const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  for (const c of ['title', 'title_source', 'user_prompts']) assert.ok(cols.has(c), c);
  assert.equal(db.prepare('SELECT count(*) n FROM ingest_state').get().n, 0);
});

test('upsertSession stores title columns; scheduled sessions are parent candidates', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'p', kind: 'scheduled', entrypoint: 'claude-desktop', started_at: '2026-09-01T05:00:00Z', ended_at: '2026-09-01T05:30:00Z', title: 'yt', title_source: 'prompt', user_prompts: 0 });
  assert.equal(getSession(db, 'p').session.title, 'yt');
  const c = listParentCandidates(db, { started_at: '2026-09-01T05:10:00Z' });
  assert.deepEqual(c.map((r) => r.session_id), ['p']);
});
