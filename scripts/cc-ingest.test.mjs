import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, getSession, listSessions } from '../src/lib/cc/store.mjs';
import { ingestAll } from './cc-ingest.mjs';

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
