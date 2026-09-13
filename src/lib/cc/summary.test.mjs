import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLines } from './transcript.mjs';
import { distill, distillGemini, distillGeminiDb, resolveGeminiTranscriptPath, summarize, summarizeSession, resolveClaudeBin, SummaryError } from './summary.mjs';
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
  const r = await summarize('text', { exec, model: 'claude-haiku-4-5', cwd: '/tmp/x', bin: 'claude' });
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

test('resolveClaudeBin: env override, then well-known paths, then bare name', () => {
  assert.equal(resolveClaudeBin({ CC_CLAUDE_BIN: '/x/claude' }, '/h', () => false), '/x/claude');
  assert.equal(resolveClaudeBin({}, '/h', (p) => p === '/h/.local/bin/claude'), '/h/.local/bin/claude');
  assert.equal(resolveClaudeBin({}, '/h', (p) => p === '/opt/homebrew/bin/claude'), '/opt/homebrew/bin/claude');
  assert.equal(resolveClaudeBin({}, '/h', () => false), 'claude');
});

const geminiLines = [
  { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nFix the authentication redirect bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>' },
  { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] },
  { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Tests now pass and redirect is resolved.' },
];

test('distillGemini and polymorphic distill extract prompt, tool calls and assistant text', () => {
  const d = distill(geminiLines);
  assert.match(d, /USER: Fix the authentication redirect bug/);
  assert.match(d, /TOOL run_command: npm test/);
  assert.match(d, /ASSISTANT: Tests now pass and redirect is resolved\./);
});

test('resolveGeminiTranscriptPath finds candidate files', () => {
  const p = resolveGeminiTranscriptPath('/tmp/test.db', 'sess-123', (candidate) => candidate.endsWith('transcript.jsonl'));
  assert.ok(p);
  assert.ok(p.endsWith('transcript.jsonl'));
});

test('distillGeminiDb extracts steps directly from sqlite database', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  function encodeVarint(n) {
    const bytes = [];
    while (n > 0x7f) {
      bytes.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    bytes.push(n & 0x7f);
    return Buffer.from(bytes);
  }

  function makeProtoField(fieldNum, val) {
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(val);
    const tag = (fieldNum << 3) | 2;
    return Buffer.concat([encodeVarint(tag), encodeVarint(buf.length), buf]);
  }

  const dir = await mkdtemp(join(tmpdir(), 'gemini-db-'));
  const dbFile = join(dir, 'gem-session.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER,
      step_payload BLOB,
      metadata BLOB
    );
  `);

  const p19 = makeProtoField(2, '<USER_REQUEST>Add dark mode toggle</USER_REQUEST>');
  const payloadUser = makeProtoField(19, p19);

  const f4 = Buffer.concat([makeProtoField(2, 'write_to_file'), makeProtoField(3, JSON.stringify({ TargetFile: 'styles.css' }))]);
  const metaTool = makeProtoField(4, f4);

  const p20 = makeProtoField(1, 'Dark mode toggle added.');
  const payloadAssistant = makeProtoField(20, p20);

  db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)').run(0, 14, payloadUser, null);
  db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)').run(1, 15, null, metaTool);
  db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)').run(2, 15, payloadAssistant, null);
  db.close();

  const { distillGeminiDb } = await import('./summary.mjs');
  const d = distillGeminiDb(dbFile);
  assert.match(d, /USER: Add dark mode toggle/);
  assert.match(d, /TOOL write_to_file: styles\.css/);
  assert.match(d, /ASSISTANT: Dark mode toggle added\./);
});

test('summarizeSession handles Gemini sessions from disk', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'gem-sess-'));
  const transcriptFile = join(dir, 'transcript.jsonl');
  await writeFile(transcriptFile, geminiLines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

  const dbFile = join(dir, 'sess-gemini.db');
  const sdb = new DatabaseSync(dbFile);
  sdb.exec('CREATE TABLE dummy (id INT)');
  sdb.close();

  const store = openStore(':memory:');
  upsertSession(store, {
    session_id: 'sess-gemini',
    raw_ref: dbFile,
    model: 'gemini-3.8-flash',
  });

  const got = await summarizeSession(store, 'sess-gemini', { exec: fakeExec(okResult), model: 'haiku' });
  assert.equal(JSON.parse(got.session.summary).what, 'Added login');
  assert.equal(got.session.summary_model, 'haiku');
  assert.ok(got.session.summarized_at);
});

