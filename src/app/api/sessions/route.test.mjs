import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setPlacements } from '../../../lib/cc/store.mjs';
import { handle } from './route.js';

function db1() {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'm', started_at: '2026-08-21T10:00:00Z', ended_at: '2026-08-21T10:10:00Z', duration_s: 600, active_s: 60, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0.01, turns: 3, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: 'now' });
  upsertSession(db, { session_id: 's2', project_dir: '/p/b', cwd: '/p/b', model: 'm', started_at: '2026-08-21T11:00:00Z', ended_at: null, duration_s: 0, active_s: 0, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: null, turns: 1, status: 'unknown', raw_ref: '/t/s2.jsonl', ingested_at: 'now' });
  return db;
}

test('list returns sessions newest first', () => {
  const res = handle(new URLSearchParams(''), db1());
  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].session_id, 's2');
});

test('list honours project and limit', () => {
  assert.equal(handle(new URLSearchParams('project=/p/a'), db1()).sessions[0].session_id, 's1');
  assert.equal(handle(new URLSearchParams('limit=1'), db1()).sessions.length, 1);
});

test('detail returns one session by id, null when unknown', () => {
  const res = handle(new URLSearchParams('id=s1'), db1());
  assert.equal(res.session.session_id, 's1');
  assert.deepEqual(res.tools, []);
  assert.equal(handle(new URLSearchParams('id=zzz'), db1()).session, null);
});

import { replaceSubagents, setParent } from '../../../lib/cc/store.mjs';

test('list returns children of returned parents and their nested agents', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'p', project_dir: '/p/a', started_at: '2026-09-15T10:00:00Z', kind: 'main' });
  upsertSession(db, { session_id: 'c', project_dir: '/p/a', started_at: '2026-09-15T10:30:00Z', kind: 'security-review' });
  setParent(db, 'c', 'p');
  replaceSubagents(db, 'p', [{ agent_id: 'agent-1', agent_type: 'Explore' }]);
  const r = handle(new URLSearchParams('limit=1'), db);
  assert.deepEqual(r.sessions.map((s) => s.session_id), ['p', 'c']);
  assert.deepEqual(r.agents.map((a) => a.agent_id), ['agent-1']);
  const d = handle(new URLSearchParams('id=c'), db);
  assert.equal(d.parent.session_id, 'p');
  assert.equal(handle(new URLSearchParams('id=p'), db).children[0].session_id, 'c');
});

test('list honours since/until', () => {
  const res = handle(new URLSearchParams('since=2026-08-21T10:30:00Z&until=2026-08-22T00:00:00Z'), db1());
  assert.deepEqual(res.sessions.map((s) => s.session_id), ['s2']);
});

const prow = (id, dir, t) => ({ session_id: id, project_dir: dir, cwd: dir, model: 'm', started_at: t, ended_at: t, duration_s: 0, active_s: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: `/t/${id}`, ingested_at: 'now' });

test('?project_key= returns every session of the project; rows carry project_name', () => {
  const db = openStore(':memory:');
  upsertSession(db, prow('a', '/p/blog', '2026-10-01T10:00:00Z'));
  upsertSession(db, prow('b', '/p/blog/.agent-office/worktrees/x', '2026-10-01T11:00:00Z'));
  setPlacements(db, [
    { session_id: 'a', project_key: 'P', workspace: null, base_dir: '/p/blog' },
    { session_id: 'b', project_key: 'P', workspace: 'agent-office:x', base_dir: '/p/blog' },
  ]);
  const names = new Map([['P', 'Blog']]);
  const out = handle(new URLSearchParams('project_key=P'), db, { projectNames: names });
  assert.equal(out.sessions.length, 2);
  assert.ok(out.sessions.every((s) => s.project_name === 'Blog'));
  const byDir = handle(new URLSearchParams('project=/p/blog'), db);
  assert.equal(byDir.sessions.length, 2);
  assert.equal(byDir.sessions[0].project_name, 'blog');
  const detail = handle(new URLSearchParams('id=b'), db, { projectNames: names });
  assert.equal(detail.session.project_name, 'Blog');
  assert.equal(detail.session.workspace, 'agent-office:x');
});

test('?project=<dir> does not pull in a nested register project', () => {
  const db = openStore(':memory:');
  upsertSession(db, prow('root', '/p/app', '2026-10-01T10:00:00Z'));
  upsertSession(db, prow('sub', '/p/app/packages/web', '2026-10-01T11:00:00Z'));
  setPlacements(db, [
    { session_id: 'root', project_key: 'A', workspace: null, base_dir: '/p/app' },
    { session_id: 'sub', project_key: 'W', workspace: null, base_dir: '/p/app/packages/web' },
  ]);
  const projectKeyOf = (dir) => ({ '/p/app': 'A', '/p/app/packages/web': 'W' })[dir] ?? null;
  assert.deepEqual(handle(new URLSearchParams('project=/p/app'), db, { projectKeyOf }).sessions.map((s) => s.session_id), ['root']);
});

import { projectIndex } from '../../../lib/cc/session-projects.mjs';

test('handle annotates list, detail, children and parent rows with client and virtual project', () => {
  const db = openStore(':memory:');
  upsertSession(db, prow('s1', '/p/blog-huha', '2026-10-01T10:00:00Z'));
  upsertSession(db, prow('c1', '/p/blog-huha', '2026-10-01T10:30:00Z'));
  setParent(db, 'c1', 's1');
  setPlacements(db, [{ session_id: 's1', project_key: 'git:x/blog', workspace: null, base_dir: '/p/blog-huha' }]);
  const index = projectIndex({ projects: [{ key: 'git:x/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail' } }] });
  const out = handle(new URLSearchParams(), db, { index });
  const s1 = out.sessions.find((s) => s.session_id === 's1');
  assert.equal(s1.client_name, 'Intelimail');
  assert.equal(s1.client_id, 'intelimail');
  assert.equal(s1.project_name, 'blog');
  assert.equal(out.sessions.find((s) => s.session_id === 'c1').client_id, null);
  const d = handle(new URLSearchParams('id=s1'), db, { index });
  assert.equal(d.session.client_name, 'Intelimail');
  assert.ok('client_id' in d.children[0]);
  assert.equal(handle(new URLSearchParams('id=c1'), db, { index }).parent.client_name, 'Intelimail');
  assert.equal(handle(new URLSearchParams(), db).sessions[0].client_id, null, 'no index → unassigned, not a crash');
});
