import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utimes, readFile } from 'node:fs/promises';
import { openStore, getSession, listSessions } from './store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ingestAll } from './ingest-run.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccp-'));
  const proj = join(root, 'projects', '-p-a');
  await mkdir(proj, { recursive: true });
  const lines = [
    { type: 'user', cwd: '/p/a', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:00Z' },
    { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(proj, 'sess-1.jsonl'), lines, 'utf8');
  await writeFile(join(proj, 'notes.txt'), 'ignored', 'utf8');
  const guard = join(root, 'audit.jsonl');
  await writeFile(guard, JSON.stringify({ ts: 't', action: 'deny', rule: 'r', command: 'rm -rf /', session_id: 'sess-1' }) + '\n', 'utf8');
  return { root, guard };
}

test('ingestAll ingests every transcript and attaches guard hits', async () => {
  const { root, guard } = await fixture();
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db });
  assert.equal(res.sessions, 1);
  const got = getSession(db, 'sess-1');
  assert.equal(got.tools.find((t) => t.tool === 'Bash').count, 1);
  assert.equal(got.guard_hits[0].action, 'deny');
});

test('ingestAll is idempotent and tolerates a missing guard audit', async () => {
  const { root } = await fixture();
  const db = openStore(':memory:');
  await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope.jsonl'), db });
  await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope.jsonl'), db });
  assert.equal(listSessions(db).length, 1);
  assert.equal(getSession(db, 'sess-1').guard_hits.length, 0);
});

test('ingestAll with a missing claudeDir ingests nothing', async () => {
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: '/nonexistent/x', guardAudit: '/nonexistent/y', db });
  assert.equal(res.sessions, 0);
});

test('subagent transcripts are folded into the parent session', async () => {
  const { root } = await fixture();
  const sa = join(root, 'projects', '-p-a', 'sess-1', 'subagents');
  await mkdir(sa, { recursive: true });
  const sub = [
    { type: 'user', sessionId: 'sess-1', isSidechain: true, agentId: 'a1', timestamp: '2026-08-21T10:00:06Z' },
    { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:07Z', message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 50 }, content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }, { type: 'tool_use', name: 'Grep', input: {} } ] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(sa, 'agent-a1.jsonl'), sub, 'utf8');
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope'), db });
  assert.equal(res.sessions, 1);
  const got = getSession(db, 'sess-1');
  assert.equal(got.session.input_tokens, 110);
  assert.equal(got.session.output_tokens, 55);
  assert.equal(got.session.turns, 1, 'turns count only the main transcript');
  assert.equal(got.tools.find((t) => t.tool === 'Bash').count, 2);
  assert.equal(got.tools.find((t) => t.tool === 'Grep').count, 1);
});

test('ingestAll stores work context and quality score', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccp-'));
  const proj = join(root, 'projects', '-p-a');
  await mkdir(proj, { recursive: true });
  const lines = [
    { type: 'user', cwd: '/p/a', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } },
    { type: 'assistant', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:09Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(proj, 'sess-q.jsonl'), lines, 'utf8');
  const db = openStore(':memory:');
  await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope'), db, env: {} });
  const s = getSession(db, 'sess-q').session;
  assert.equal(s.git_branch, 'feat/QA-12-x');
  assert.equal(s.ticket_id, 'QA-12');
  assert.equal(s.ticket_source, 'branch');
  assert.equal(s.quality_score, 100);
  assert.equal(JSON.parse(s.quality_detail).verified, true);
});

test('incremental: unchanged transcripts are skipped, changed ones re-parsed, guard hits still refreshed', async () => {
  const { root, guard } = await fixture();
  const db = openStore(':memory:');
  const claudeDir = join(root, 'projects');
  const r1 = await ingestAll({ claudeDir, guardAudit: guard, db, env: {} });
  assert.deepEqual([r1.changed, r1.skipped], [1, 0]);
  const r2 = await ingestAll({ claudeDir, guardAudit: guard, db, env: {} });
  assert.deepEqual([r2.sessions, r2.changed, r2.skipped], [1, 0, 1]);

  // guard audit grows → hits refresh even though the transcript is skipped
  await writeFile(guard, [
    JSON.stringify({ ts: 't', action: 'deny', rule: 'r', command: 'x', session_id: 'sess-1' }),
    JSON.stringify({ ts: 't2', action: 'warn', rule: 'r2', command: 'y', session_id: 'sess-1' }),
  ].join('\n') + '\n', 'utf8');
  const r3 = await ingestAll({ claudeDir, guardAudit: guard, db, env: {} });
  assert.equal(r3.skipped, 1);
  assert.equal(getSession(db, 'sess-1').guard_hits.length, 2);

  // transcript grows → re-parsed
  const file = join(claudeDir, '-p-a', 'sess-1.jsonl');
  const extra = JSON.stringify({ type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:09Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } });
  await writeFile(file, (await readFile(file, 'utf8')) + '\n' + extra, 'utf8');
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const r4 = await ingestAll({ claudeDir, guardAudit: guard, db, env: {} });
  assert.deepEqual([r4.changed, r4.skipped], [1, 0]);
  assert.equal(getSession(db, 'sess-1').tools.find((t) => t.tool === 'Read').count, 1);

  // full=true re-parses everything
  const r5 = await ingestAll({ claudeDir, guardAudit: guard, db, env: {}, full: true });
  assert.deepEqual([r5.changed, r5.skipped], [1, 0]);
});

test('ingestAll ingests Gemini conversation SQLite databases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-ingest-'));
  const geminiDir = join(root, 'gemini');
  await mkdir(geminiDir, { recursive: true });

  const dbFile = join(geminiDir, 'gemini-uuid-123.db');
  const gdb = new DatabaseSync(dbFile);
  gdb.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
  gdb.exec('CREATE TABLE steps (idx INT, metadata BLOB)');
  gdb.exec('CREATE TABLE gen_metadata (idx INT, data BLOB)');

  // Tag 7 is (7 << 3) | 2 = 58
  const traj = Buffer.concat([Buffer.from([58, 11]), Buffer.from('file:///p/g')]);
  gdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', traj);

  // Step with tool
  const tsMsg = Buffer.concat([Buffer.from([8]), Buffer.from([200, 1])]); // tag 1 wire 0
  const toolCall = Buffer.concat([
    Buffer.from([10, 6]), Buffer.from('call_1'),
    Buffer.from([18, 9]), Buffer.from('view_file'),
  ]);
  const step = Buffer.concat([
    Buffer.from([10, tsMsg.length]), tsMsg,
    Buffer.from([34, toolCall.length]), toolCall,
  ]);
  gdb.prepare('INSERT INTO steps VALUES (?, ?)').run(0, step);

  // Gen metadata: model
  const f1 = Buffer.concat([
    Buffer.from([154, 1, 16]), Buffer.from('gemini-3.8-flash'),
  ]);
  gdb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, Buffer.concat([Buffer.from([10, f1.length]), f1]));
  gdb.close();

  const db = openStore(':memory:');
  const res = await ingestAll({
    claudeDir: null,
    geminiDir,
    guardAudit: join(root, 'guard.jsonl'),
    db,
    projectDirs: ['/p/g'],
  });

  assert.equal(res.sessions, 1);
  assert.equal(res.changed, 1);
  const s = getSession(db, 'gemini-uuid-123');
  assert.equal(s.session.session_id, 'gemini-uuid-123');
  assert.equal(s.session.model, 'gemini-3.8-flash');
  assert.equal(s.session.project_dir, '/p/g');
  assert.equal(s.tools.find((t) => t.tool === 'view_file').count, 1);
});


import { listSubagents } from './store.mjs';

test('nested agents are recorded in the subagents table with meta.json type + description', async () => {
  const { root } = await fixture();
  const sa = join(root, 'projects', '-p-a', 'sess-1', 'subagents');
  await mkdir(sa, { recursive: true });
  const sub = [
    { type: 'user', sessionId: 'sess-1', isSidechain: true, agentId: 'a1', timestamp: '2026-08-21T10:00:06Z' },
    { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:16Z', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'x' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(sa, 'agent-a1.jsonl'), sub, 'utf8');
  await writeFile(join(sa, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find callers', spawnDepth: 1 }), 'utf8');
  const db = openStore(':memory:');
  await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope'), db });
  const [a] = listSubagents(db, ['sess-1']);
  assert.equal(a.agent_id, 'agent-a1');
  assert.equal(a.agent_type, 'Explore');
  assert.equal(a.description, 'Find callers');
  assert.equal(a.model, 'claude-haiku-4-5-20251001');
  assert.equal(a.output_tokens, 50);
  assert.equal(a.active_s, 10);
  assert.equal(getSession(db, 'sess-1').agents.length, 1);
});

/** A main session + a hook-spawned review inside its window, in the same project. */
async function familyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccf-'));
  const proj = join(root, 'projects', '-p-a');
  await mkdir(proj, { recursive: true });
  const write = (id, lines) => writeFile(join(proj, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const asst = (id, ts, entrypoint = 'cli') => ({ type: 'assistant', sessionId: id, entrypoint, timestamp: ts, message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] } });
  await write('main-a', [
    { type: 'user', cwd: '/p/a', sessionId: 'main-a', entrypoint: 'cli', timestamp: '2026-09-15T10:00:00Z', message: { content: 'build it' } },
    asst('main-a', '2026-09-15T10:00:05Z'), asst('main-a', '2026-09-15T10:09:59Z'), asst('main-a', '2026-09-15T10:20:00Z'),
  ]);
  await write('main-b', [
    { type: 'user', cwd: '/p/b', sessionId: 'main-b', entrypoint: 'claude-desktop', timestamp: '2026-09-15T09:00:00Z', message: { content: 'other work' } },
    asst('main-b', '2026-09-15T09:00:05Z', 'claude-desktop'), asst('main-b', '2026-09-15T10:05:00Z', 'claude-desktop'), asst('main-b', '2026-09-15T10:30:00Z', 'claude-desktop'),
  ]);
  await write('rev-1', [
    { type: 'user', cwd: '/p/a', sessionId: 'rev-1', entrypoint: 'sdk-py', timestamp: '2026-09-15T10:10:00Z', message: { content: 'Review this change for security vulnerabilities.\n\nChanged files' } },
    asst('rev-1', '2026-09-15T10:10:03Z', 'sdk-py'),
  ]);
  return { root, claudeDir: join(root, 'projects') };
}

test('ingestAll links a hook-spawned review to the parent whose turn ended right before it', async () => {
  const { root, claudeDir } = await familyFixture();
  const db = openStore(':memory:');
  const r = await ingestAll({ claudeDir, guardAudit: join(root, 'nope'), db, env: {}, full: true });
  assert.equal(r.sessions, 3);
  assert.equal(r.linked, 1);
  const rev = getSession(db, 'rev-1');
  assert.equal(rev.session.kind, 'security-review');
  assert.equal(rev.session.parent_session_id, 'main-a', 'main-a stopped a turn 1 s before the review, main-b was mid-turn');
  assert.equal(getSession(db, 'main-a').children[0].session_id, 'rev-1');
  assert.equal(listSessions(db).filter((s) => !s.parent_session_id).length, 2, 'two top-level sessions');
  const again = await ingestAll({ claudeDir, guardAudit: join(root, 'nope'), db, env: {}, full: true });
  assert.equal(again.linked, 0, 'nothing left to link on the next run');
  assert.equal(getSession(db, 'rev-1').session.parent_session_id, 'main-a');
});

test('a first (or post-migration) ingest links children older than the retry window', async () => {
  const { root, claudeDir } = await familyFixture(); // fixture dates are 2026-09-15, far outside any 24 h window
  const db = openStore(':memory:');
  const r = await ingestAll({ claudeDir, guardAudit: join(root, 'nope'), db, env: {} });
  assert.equal(r.linked, 1);
});

test('a review in a sibling repo links to the session whose line preceded it (timing beats directory)', async () => {
  const { root, claudeDir } = await familyFixture();
  const proj = join(claudeDir, '-p-b');
  await mkdir(proj, { recursive: true });
  // rev-2 runs in /p/b at 10:05:01 — main-b's line at 10:05:00 is the trigger; main-a (same dir as nothing) is idle.
  await writeFile(join(proj, 'rev-2.jsonl'), [
    { type: 'user', cwd: '/p/b', sessionId: 'rev-2', entrypoint: 'sdk-py', timestamp: '2026-09-15T10:05:01Z', message: { content: 'Review this change for security vulnerabilities.' } },
    { type: 'assistant', sessionId: 'rev-2', entrypoint: 'sdk-py', timestamp: '2026-09-15T10:05:03Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] } },
  ].map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const db = openStore(':memory:');
  await ingestAll({ claudeDir, guardAudit: join(root, 'nope'), db, env: {}, full: true });
  assert.equal(getSession(db, 'rev-2').session.parent_session_id, 'main-b');
  assert.equal(getSession(db, 'rev-1').session.parent_session_id, 'main-a');
});

async function codexFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccx-'));
  const day = join(root, 'sessions', '2026', '09', '09');
  await mkdir(day, { recursive: true });
  const line = (o) => JSON.stringify(o);
  const meta = (p) => ({ timestamp: '2026-09-09T10:00:00.000Z', type: 'session_meta', payload: { cwd: '/p/app', originator: 'codex-tui', source: 'cli', ...p } });
  await writeFile(join(day, 'rollout-a-root.jsonl'), [
    line(meta({ id: 'root', session_id: 'root' })),
    line({ timestamp: '2026-09-09T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] } }),
    line({ timestamp: '2026-09-09T10:00:09Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));
  await writeFile(join(day, 'rollout-b-sub.jsonl'), [
    line(meta({ id: 'sub', session_id: 'root', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } })),
    line({ timestamp: '2026-09-09T10:00:05Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));
  return join(root, 'sessions');
}

test('ingestAll ingests Codex rollouts and links subagents to their root thread', async () => {
  const codexDir = await codexFixture();
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: null, codexDir, guardAudit: '/nope', db, projectDirs: ['/p/app'] });
  assert.equal(res.changed, 2);
  const got = getSession(db, 'root');
  assert.equal(got.session.entrypoint, 'codex-cli');
  assert.equal(got.session.project_dir, '/p/app');
  assert.deepEqual(got.children.map((c) => c.session_id), ['sub']);
  assert.deepEqual(listSessions(db).filter((s) => !s.parent_session_id).map((s) => s.session_id), ['root']);
  const again = await ingestAll({ claudeDir: null, codexDir, guardAudit: '/nope', db, projectDirs: ['/p/app'] });
  assert.equal(again.skipped, 2);
  assert.equal(getSession(db, 'sub').session.parent_session_id, 'root', 'link survives the incremental run');
});

test('ingest places sessions (worktree → main project) and reports it', async () => {
  const { root, guard } = await fixture();
  const wt = join(root, 'projects', '-p-a--agent-office-worktrees-pixel-1');
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, 'sess-2.jsonl'), [
    { type: 'user', cwd: '/p/a/.agent-office/worktrees/pixel-1', sessionId: 'sess-2', timestamp: '2026-08-21T11:00:00Z' },
    { type: 'assistant', sessionId: 'sess-2', timestamp: '2026-08-21T11:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
  ].map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const { buildProjectIndex } = await import('./project-key.mjs');
  const placement = { index: buildProjectIndex({ register: { projects: [{ key: 'P-a', locations: [{ directory: '/p/a' }] }] } }), exists: () => false, exec: async () => { throw new Error(); } };
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db, placement });
  assert.deepEqual(res.placed, { checked: 2, updated: 2 });
  const s = getSession(db, 'sess-2').session;
  assert.equal(s.project_key, 'P-a');
  assert.equal(s.workspace, 'agent-office:pixel-1');
  assert.equal(s.base_dir, '/p/a');
  assert.equal(s.project_dir, '/p/a/.agent-office/worktrees/pixel-1'); // unchanged
});

test('a placement failure does not fail the ingest', async () => {
  const { root, guard } = await fixture();
  const db = openStore(':memory:');
  const placement = { index: { lookup() { throw new Error('boom'); }, knownDirs: [], covers: () => true }, exists: () => false, exec: async () => ({}) };
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db, placement });
    assert.equal(res.sessions, 1);
    assert.equal(res.placed, null);
    assert.match(res.placement_error, /boom/);
  } finally { console.warn = warn; }
});

test('ingestAll without a placement context skips placement', async () => {
  const { root, guard } = await fixture();
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db });
  assert.equal(res.placed, null);
  assert.equal(getSession(db, 'sess-1').session.workspace, null);
});
