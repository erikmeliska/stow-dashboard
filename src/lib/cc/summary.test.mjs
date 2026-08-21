import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLines } from './transcript.mjs';
import { distill, summarize, summarizeSession, SummaryError } from './summary.mjs';
import { openStore, upsertSession, getSession } from './store.mjs';

const J = (o) => JSON.stringify(o);
const lines = parseLines([
  J({ type: 'user', message: { content: 'Please add a login page' } }),
  J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
  J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  J({ type: 'assistant', message: { content: [{ type: 'text', text: 'Login page added and tests pass.' }] } }),
].join('\n'));

const okResult = { what: 'Added login', outcome: 'done', improvements: [], followups: ['add tests'] };
const fakeExec = (structured_output) => async () => ({ stdout: JSON.stringify({ type: 'result', is_error: false, structured_output }) });

test('distill keeps prompts, tool calls and assistant text, and respects maxChars', () => {
  const d = distill(lines);
  assert.match(d, /USER: Please add a login page/);
  assert.match(d, /TOOL Bash: npm test/);
  assert.match(d, /ASSISTANT: Login page added/);
  assert.ok(distill(lines, { maxChars: 40 }).length <= 40);
});

test('summarize calls claude -p with the safety/cost flags and parses structured output', async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push([cmd, args, opts]); return fakeExec(okResult)(); };
  const r = await summarize('text', { exec, model: 'claude-haiku-4-5', cwd: '/tmp/x' });
  assert.deepEqual(r, { ...okResult, model: 'claude-haiku-4-5' });
  const [cmd, args, opts] = calls[0];
  assert.equal(cmd, 'claude');
  for (const f of ['-p', '--no-session-persistence', '--output-format', '--json-schema', '--tools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--system-prompt', '--model']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5');
  assert.match(args.at(-1), /^Transcript:\ntext$/);
  assert.equal(opts.cwd, '/tmp/x');
});

test('summarize surfaces CLI and JSON failures as SummaryError', async () => {
  await assert.rejects(summarize('x', { exec: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } }), (e) => e instanceof SummaryError && e.kind === 'cli-missing');
  await assert.rejects(summarize('x', { exec: async () => { const e = new Error('boom'); e.code = 1; e.stderr = 'auth failed\nmore'; throw e; } }), (e) => e.kind === 'cli-failed' && e.detail === 'auth failed');
  await assert.rejects(summarize('x', { exec: async () => ({ stdout: 'not json' }) }), (e) => e.kind === 'bad-json');
  await assert.rejects(summarize('x', { exec: async () => ({ stdout: JSON.stringify({ type: 'result', result: 'plain text' }) }) }), (e) => e.kind === 'bad-json');
  await assert.rejects(summarize('x', { exec: async () => ({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }) }) }), (e) => e.kind === 'cli-failed' && e.detail === 'rate limited');
  await assert.rejects(summarize('x', { exec: fakeExec({ what: 'x', outcome: 'maybe' }) }), (e) => e.kind === 'bad-json');
});

test('summarizeSession reads raw_ref, stores the summary, and reports a missing transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccs-'));
  const file = join(dir, 's.jsonl');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 's', raw_ref: file });
  upsertSession(db, { session_id: 'gone', raw_ref: join(dir, 'missing.jsonl') });
  const got = await summarizeSession(db, 's', { exec: fakeExec(okResult), model: 'm' });
  assert.equal(JSON.parse(got.session.summary).what, 'Added login');
  assert.equal(got.session.summary_model, 'm');
  assert.ok(got.session.summarized_at);
  assert.equal(JSON.parse(getSession(db, 's').session.summary).outcome, 'done');
  await assert.rejects(summarizeSession(db, 'gone', { exec: fakeExec(okResult) }), (e) => e.kind === 'not-found');
  await assert.rejects(summarizeSession(db, 'nope', { exec: fakeExec(okResult) }), (e) => e.kind === 'not-found');
});
