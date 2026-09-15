import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText, SKILL_PATH_RE } from './ingest.mjs';

const lines = [
  { type: 'user', cwd: '/p/a', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:00Z' },
  { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:05Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:20Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 10 },
      content: [
        { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/x/.claude/skills/foo/SKILL.md' } },
      ] } },
];
const text = lines.map((l) => JSON.stringify(l)).join('\n');

test('parseSessionText extracts tokens, tools, skills, skill_edited', () => {
  const row = parseSessionText(text, { fileName: 'sess-1.jsonl', rawRef: '/t/sess-1.jsonl' });
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.project_dir, '/p/a');
  assert.equal(row.model, 'claude-opus-5');
  assert.equal(row.input_tokens, 105);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.cache_read, 10);
  assert.equal(row.turns, 2);
  assert.equal(row._tools.Bash, 1);
  assert.equal(row._tools.Edit, 1);
  assert.equal(row._skills['superpowers:brainstorming'], 1);
  assert.ok(row._editedSkills.has('superpowers:brainstorming'));
  assert.equal(row.started_at, '2026-08-21T10:00:00Z');
  assert.equal(row.ended_at, '2026-08-21T10:00:20Z');
  assert.equal(row.duration_s, 20);
  assert.equal(row.status, 'done');
  assert.equal(row.raw_ref, '/t/sess-1.jsonl');
  assert.ok(typeof row.cost_usd === 'number' || row.cost_usd === null);
});

test('session id falls back to filename stem when absent on lines', () => {
  const row = parseSessionText('{"type":"user","cwd":"/p"}', { fileName: 'abc-123.jsonl', rawRef: '/t/abc-123.jsonl' });
  assert.equal(row.session_id, 'abc-123');
  assert.equal(row.turns, 0);
  assert.equal(row.cost_usd, null);
});

test('skill edit without a preceding Skill call is not attributed', () => {
  const t = JSON.stringify({ type: 'assistant', sessionId: 's', message: { model: 'm', usage: {}, content: [
    { type: 'tool_use', name: 'Write', input: { file_path: '/r/.claude/skills/bar/SKILL.md' } } ] } });
  const row = parseSessionText(t, {});
  assert.equal(row._editedSkills.size, 0);
  assert.equal(row._tools.Write, 1);
});

test('SKILL_PATH_RE matches skill dirs only', () => {
  assert.ok(SKILL_PATH_RE.test('/r/.claude/skills/foo/SKILL.md'));
  assert.ok(SKILL_PATH_RE.test('/r/skills/foo/scripts/x.sh'));
  assert.ok(!SKILL_PATH_RE.test('/r/src/skills.mjs'));
});

test('parseSessionText records entrypoint and classifies hook-spawned SDK reviews as children', () => {
  const sdk = [
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'rev-1', content: 'Review this change for security vulnerabilities.\n\nChanged files' },
    { type: 'user', cwd: '/p/a', sessionId: 'rev-1', entrypoint: 'sdk-py', timestamp: '2026-09-15T10:00:00Z', message: { role: 'user', content: 'Review this change for security vulnerabilities.\n\nChanged files' } },
    { type: 'assistant', sessionId: 'rev-1', entrypoint: 'sdk-py', timestamp: '2026-09-15T10:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const r = parseSessionText(sdk, { fileName: 'rev-1.jsonl' });
  assert.equal(r.entrypoint, 'sdk-py');
  assert.equal(r.kind, 'security-review');
  const main = parseSessionText(text, { fileName: 'sess-1.jsonl' });
  assert.equal(main.kind, 'main');
  assert.equal(main.entrypoint, null);
});
