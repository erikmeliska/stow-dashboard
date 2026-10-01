import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLines } from './transcript.mjs';
import { distill, distillGemini, distillGeminiDb, resolveGeminiTranscriptPath, summarize, summarizeSession, resolveClaudeBin, resolveHarnessBin, summaryHarness, summaryModel, codexArgs, codexReportedModel, SummaryError, sessionMeta, commitMessage, factsHeader, claudeFacts, codexFacts, distillCodex, SUMMARY_SCHEMA } from './summary.mjs';
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
  assert.equal(r.what, okResult.what);
  assert.equal(r.outcome, okResult.outcome);
  assert.deepEqual(r.improvements, okResult.improvements);
  assert.deepEqual(r.followups, okResult.followups);
  assert.equal(r.model, 'claude-haiku-4-5');
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


test('summarize returns summary v2 with title, kind_hint and timing', async () => {
  let t = 1000;
  const r = await summarize('x', { exec: fakeExec({ title: 'Port change', what: 'Set port.', outcome: 'exploration', improvements: ['a', 'b', 'c', 'd', 'e', 'f'], followups: [], kind_hint: 'trivial' }), clock: () => (t += 1500), model: 'm' });
  assert.equal(r.v, 2);
  assert.equal(r.title, 'Port change');
  assert.equal(r.outcome, 'exploration');
  assert.equal(r.kind_hint, 'trivial');
  assert.equal(r.improvements.length, 5, 'clipped to 5');
  assert.equal(r.ms, 1500);
  assert.equal(r.model, 'm');
});

test('summarize tolerates model output without title/kind_hint', async () => {
  const r = await summarize('x', { exec: fakeExec(okResult) });
  assert.equal(r.title, null);
  assert.equal(r.kind_hint, 'work');
});

test('claudeArgs sends the v2 schema; the prompt starts with session metadata', async () => {
  let seen = null;
  const exec = async (_bin, args) => { seen = args; return { stdout: JSON.stringify({ structured_output: okResult }) }; };
  await summarize('TRANSCRIPT', { exec, meta: 'Project: app' });
  const schema = JSON.parse(seen[seen.indexOf('--json-schema') + 1]);
  assert.ok(schema.required.includes('kind_hint'));
  assert.ok(schema.properties.outcome.enum.includes('exploration'));
  assert.match(seen.at(-1), /^Project: app\n\nTranscript:\nTRANSCRIPT/);
});

test('sessionMeta / commitMessage / factsHeader / claudeFacts', () => {
  assert.match(sessionMeta({ project_dir: '/p/app', entrypoint: 'cli', active_s: 600, turns: 4, git_branch: 'main', started_at: '2026-09-09T10:00:00Z' }), /Project: app[\s\S]*active 10 min · 4 turns · branch main/);
  assert.equal(commitMessage('git commit -m "feat: x" && git push'), 'feat: x');
  assert.equal(commitMessage("git commit -m \"$(cat <<'EOF'\nfix: y\n\nbody\nEOF\n)\""), 'fix: y');
  assert.equal(commitMessage('git status'), null);
  assert.equal(factsHeader({}), '');
  assert.match(factsHeader({ edited: ['a/b.js', 'a/b.js'], commits: ['feat: x'], finals: ['1', '2', '3', '4'] }), /^FILES EDITED: a\/b\.js\nCOMMITS: feat: x\nFINAL ANSWER: 2\nFINAL ANSWER: 3\nFINAL ANSWER: 4\n---\n$/);
  const facts = claudeFacts([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/lib/x.mjs' } }, { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "feat: z"' } }, { type: 'text', text: 'Done.' }] } },
  ]);
  assert.deepEqual(facts, { edited: ['lib/x.mjs'], commits: ['feat: z'], finals: ['Done.'] });
});

test('distill prepends the facts header and still respects maxChars', () => {
  const withEdit = [...lines, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/r/a/b.md' } }] } }];
  assert.match(distill(withEdit), /^FILES EDITED: a\/b\.md\n/);
  assert.ok(distill(withEdit, { maxChars: 40 }).length <= 40);
});

const codexLines = [
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'set port 3371' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git commit -m \\"chore: port\\""}' } },
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /r/app/package.json\n*** End Patch' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Port changed.' }] } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'All done.' } },
];

test('codexFacts and distillCodex', () => {
  assert.deepEqual(codexFacts(codexLines), { edited: ['app/package.json'], commits: ['chore: port'], finals: ['All done.'] });
  const d = distillCodex(codexLines);
  assert.match(d, /^FILES EDITED: app\/package\.json\nCOMMITS: chore: port\nFINAL ANSWER: All done\.\n---\n/);
  assert.match(d, /USER: set port 3371/);
  assert.doesNotMatch(d, /environment_context/);
  assert.match(d, /TOOL exec_command: git commit/);
  assert.match(d, /TOOL apply_patch: app\/package\.json/);
  assert.match(d, /ASSISTANT: Port changed\./);
});

test('summarizeSession reads Codex rollouts with distillCodex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sumx-'));
  const f = join(dir, 'rollout.jsonl');
  await writeFile(f, codexLines.map((l) => JSON.stringify(l)).join('\n'));
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'cx', entrypoint: 'codex-desktop', raw_ref: f, project_dir: '/r/app' });
  let prompt = null;
  const exec = async (_b, args) => { prompt = args.at(-1); return { stdout: JSON.stringify({ structured_output: okResult }) }; };
  await summarizeSession(db, 'cx', { exec });
  assert.match(prompt, /Harness: codex-desktop/);
  assert.match(prompt, /USER: set port 3371/);
});

test('summaryHarness / summaryModel / resolveHarnessBin read the settings', () => {
  assert.equal(summaryHarness({}), 'claude');
  assert.equal(summaryHarness({ CC_SUMMARY_HARNESS: ' Codex ' }), 'codex');
  assert.equal(summaryHarness({ CC_SUMMARY_HARNESS: 'gemini' }), 'claude', 'unknown → default');
  assert.equal(summaryModel({}), 'haiku');
  assert.equal(summaryModel({ CC_SUMMARY_HARNESS: 'codex' }), '');
  assert.equal(summaryModel({ CC_SUMMARY_HARNESS: 'codex', CC_SUMMARY_MODEL: 'gpt-x' }), 'gpt-x');
  assert.equal(resolveHarnessBin('codex', { CC_CODEX_BIN: '/x/codex' }, '/h', () => false), '/x/codex');
  assert.equal(resolveHarnessBin('codex', {}, '/h', (p) => p === '/h/.local/bin/codex'), '/h/.local/bin/codex');
  assert.equal(resolveHarnessBin('codex', {}, '/h', () => false), 'codex');
});

test('codexArgs: ephemeral, no user config, read-only, -m only when a model is set', () => {
  const a = codexArgs({ model: '', prompt: 'P', dir: '/d' });
  for (const f of ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(a[a.indexOf('--output-schema') + 1], '/d/schema.json');
  assert.equal(a[a.indexOf('-o') + 1], '/d/answer.json');
  assert.ok(!a.includes('-m'));
  assert.ok(a.at(-1).endsWith('\n\nP') && a.at(-1).startsWith('You summarise'), 'instructions lead the prompt');
  const b = codexArgs({ model: 'gpt-x', prompt: 'P', dir: '/d' });
  assert.equal(b[b.indexOf('-m') + 1], 'gpt-x');
  assert.equal(codexReportedModel('workdir: /x\nmodel: gpt-6-astra\nprovider: openai'), 'gpt-6-astra');
  assert.equal(codexReportedModel(''), null);
});

test('summarize with harness codex reads the -o answer file and cleans up', async () => {
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const { existsSync: ex } = await import('node:fs');
  let call;
  const exec = async (bin, args, opts) => {
    call = { bin, args, opts };
    const schema = JSON.parse(await rf(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.deepEqual(schema, SUMMARY_SCHEMA);
    await wf(args[args.indexOf('-o') + 1], JSON.stringify({ title: 'T', what: 'W', outcome: 'done', improvements: [], followups: [], kind_hint: 'work' }));
    return { stdout: '', stderr: 'model: gpt-6-astra\n' };
  };
  const r = await summarize('text', { exec, harness: 'codex', model: '', bin: 'codex' });
  assert.equal(call.bin, 'codex');
  assert.equal(call.opts.cwd, call.args[call.args.indexOf('-C') + 1]);
  assert.ok(!ex(call.opts.cwd), 'temp dir removed');
  assert.equal(r.harness, 'codex');
  assert.equal(r.model, 'gpt-6-astra', 'the reported model is recorded when none was set');
  assert.equal(r.title, 'T');
  await assert.rejects(summarize('x', { harness: 'codex', bin: 'codex', exec: async () => ({ stdout: '' }) }), (e) => e.kind === 'bad-json');
  await assert.rejects(summarize('x', { harness: 'codex', bin: 'codex', exec: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } }),
    (e) => e.kind === 'cli-missing' && /CC_CODEX_BIN/.test(e.message));
});
