import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexSession, normalizeOriginator, deepestProject, codexUserPrompts } from './codex-ingest.mjs';
import { costForCodex } from '../usage-pricing.mjs';

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const meta = (payload) => ({ timestamp: '2026-09-09T10:00:00.000Z', type: 'session_meta', payload: { id: 'thr-1', session_id: 'thr-1', cwd: '/p/app/src', originator: 'codex_work_desktop', source: 'vscode', git: { branch: 'feat/TRI-12-login', repository_url: 'git@github.com:o/r.git' }, ...payload } });
const msg = (ts, role, text) => ({ timestamp: ts, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const tokens = (ts, input, cached, output) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
const ev = (ts, type, extra = {}) => ({ timestamp: ts, type: 'event_msg', payload: { type, ...extra } });

const main = jl([
  meta({}),
  msg('2026-09-09T10:00:01Z', 'user', '# AGENTS.md instructions for /p/app\n<INSTRUCTIONS>x</INSTRUCTIONS>'),
  msg('2026-09-09T10:00:01Z', 'user', '<environment_context>\n<cwd>/p/app</cwd>\n</environment_context>'),
  { timestamp: '2026-09-09T10:00:02Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
  ev('2026-09-09T10:00:02Z', 'task_started'),
  msg('2026-09-09T10:00:02Z', 'user', 'set the default dev port to 3371'),
  { timestamp: '2026-09-09T10:00:05Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg PORT"}' } },
  { timestamp: '2026-09-09T10:00:09Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /p/app/package.json\n*** End Patch' } },
  tokens('2026-09-09T10:00:10Z', 1000, 400, 50),
  ev('2026-09-09T10:00:11Z', 'task_complete', { last_agent_message: 'Port set to 3371.' }),
  msg('2026-09-09T10:02:00Z', 'user', 'and update the README'),
  tokens('2026-09-09T10:02:10Z', 1500, 900, 80),
  ev('2026-09-09T10:02:11Z', 'task_complete', { last_agent_message: 'README updated.' }),
]);

test('parseCodexSession: main desktop session', () => {
  const r = parseCodexSession(main, { rawRef: '/r.jsonl', projectDirs: ['/p', '/p/app'] });
  assert.equal(r.session_id, 'thr-1');
  assert.equal(r.kind, 'main');
  assert.equal(r._parent, null);
  assert.equal(r.entrypoint, 'codex-desktop');
  assert.equal(r.project_dir, '/p/app');
  assert.equal(r.cwd, '/p/app/src');
  assert.equal(r.git_branch, 'feat/TRI-12-login');
  assert.equal(r.git_repo, 'git@github.com:o/r.git');
  assert.deepEqual([r.ticket_id, r.ticket_source], ['TRI-12', 'branch']);
  assert.equal(r.model, 'gpt-5.5');
  assert.equal(r.turns, 2);
  assert.deepEqual(r._tools, { exec_command: 1, apply_patch: 1 });
  assert.equal(r.title, 'set the default dev port to 3371');
  assert.equal(r.title_source, 'prompt');
  assert.equal(r.user_prompts, 2);
  assert.equal(r.input_tokens, 1500 - 900);
  assert.equal(r.cache_read, 900);
  assert.equal(r.output_tokens, 80);
  assert.equal(r.cost_usd, costForCodex({ input: 1500, cachedInput: 900, output: 80 }, 'gpt-5.5'));
  assert.equal(r.started_at, '2026-09-09T10:00:00.000Z');
  assert.equal(r.ended_at, '2026-09-09T10:02:11Z');
  assert.equal(r.quality_score, null);
  assert.equal(r.raw_ref, '/r.jsonl');
});

test('parseCodexSession: subagents link to the root thread, not the direct parent', () => {
  const sub = jl([meta({ id: 'thr-3', session_id: 'thr-1', source: { subagent: { thread_spawn: { parent_thread_id: 'thr-2', depth: 2 } } } })]);
  const r = parseCodexSession(sub);
  assert.equal(r.kind, 'codex-subagent');
  assert.equal(r._parent, 'thr-1');
  const legacy = jl([meta({ id: 'thr-3', session_id: undefined, source: { subagent: { thread_spawn: { parent_thread_id: 'thr-2' } } } })]);
  assert.equal(parseCodexSession(legacy)._parent, 'thr-2');
});

test('parseCodexSession: token reset keeps the last cumulative; truncated tail is ignored', () => {
  const text = jl([meta({}), { timestamp: '2026-09-09T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    tokens('2026-09-09T10:00:02Z', 100, 0, 10), tokens('2026-09-09T10:00:03Z', 30, 0, 5)]) + '\n{"timestamp":"2026-09-09T10:00:04Z","type":"ev';
  const r = parseCodexSession(text);
  assert.equal(r.input_tokens, 30);
  assert.equal(r.output_tokens, 5);
});

test('parseCodexSession: no session_meta → null', () => {
  assert.equal(parseCodexSession(jl([msg('2026-09-09T10:00:00Z', 'user', 'hi')])), null);
  assert.equal(parseCodexSession(''), null);
});

test('normalizeOriginator / deepestProject / codexUserPrompts', () => {
  assert.equal(normalizeOriginator('codex_work_desktop'), 'desktop');
  assert.equal(normalizeOriginator('Codex Desktop'), 'desktop');
  assert.equal(normalizeOriginator('codex-tui'), 'cli');
  assert.equal(normalizeOriginator('codex_cli_rs'), 'cli');
  assert.equal(normalizeOriginator('t3code_desktop'), 't3code');
  assert.equal(normalizeOriginator(undefined), 'other');
  assert.equal(deepestProject('/p/app/src', ['/p', '/p/app']), '/p/app');
  assert.equal(deepestProject('/q', ['/p']), null);
  assert.equal(deepestProject('/p/appx', ['/p/app']), null);
  assert.deepEqual(codexUserPrompts([JSON.parse(JSON.stringify(msg('t', 'user', 'real')))]), ['real']);
});
