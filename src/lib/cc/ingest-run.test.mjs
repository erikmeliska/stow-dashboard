import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utimes, readFile } from 'node:fs/promises';
import { openStore, getSession, listSessions } from './store.mjs';
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
