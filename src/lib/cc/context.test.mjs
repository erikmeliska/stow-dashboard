import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from './transcript.mjs';
import { extractContext, ticketRegex } from './context.mjs';

const J = (o) => JSON.stringify(o);
function asst(content, extra = {}) { return { type: 'assistant', gitBranch: 'main', message: { content }, ...extra }; }
function bash(command) { return { type: 'tool_use', name: 'Bash', input: { command } }; }
function result(text, is_error = false) {
  return { type: 'user', gitBranch: 'main', message: { content: [{ type: 'tool_result', content: text, is_error }] } };
}

test('branch: most common non-HEAD gitBranch; ticket from branch wins', () => {
  const lines = parseLines([
    J({ type: 'user', gitBranch: 'HEAD', message: { content: 'fix XYZ-9 please' } }),
    J({ type: 'user', gitBranch: 'feat/ABC-123-login', message: { content: 'hi' } }),
    J(asst([bash('ls')], { gitBranch: 'feat/ABC-123-login' })),
  ].join('\n'));
  const c = extractContext(lines);
  assert.equal(c.git_branch, 'feat/ABC-123-login');
  assert.equal(c.ticket_id, 'ABC-123');
  assert.equal(c.ticket_source, 'branch');
});

test('ticket from first prompt, then from commit message', () => {
  const p = parseLines([J({ type: 'user', gitBranch: 'main', message: { content: 'work on DEF-7 now' } })].join('\n'));
  assert.deepEqual([extractContext(p).ticket_id, extractContext(p).ticket_source], ['DEF-7', 'prompt']);
  const c = parseLines([J({ type: 'user', gitBranch: 'main', message: { content: 'hello' } }), J(asst([bash('git commit -m "GHI-42: fix"')]))].join('\n'));
  assert.deepEqual([extractContext(c).ticket_id, extractContext(c).ticket_source], ['GHI-42', 'commit']);
});

test('repo from git remote / push URL; PR number from gh output', () => {
  const lines = parseLines([
    J(asst([bash('git remote -v')])),
    J(result('origin\tgit@github.com:acme/widgets.git (fetch)\norigin\tgit@github.com:acme/widgets.git (push)')),
    J(asst([bash('gh pr create --fill')])),
    J(result('https://github.com/acme/widgets/pull/57')),
  ].join('\n'));
  const c = extractContext(lines);
  assert.equal(c.git_repo, 'github.com/acme/widgets');
  assert.equal(c.pr, '57');
});

test('no signals → all null; custom ticket pattern via env', () => {
  const c = extractContext(parseLines(J({ type: 'user', message: { content: 'x' } })));
  assert.deepEqual(c, { git_branch: null, git_repo: null, pr: null, ticket_id: null, ticket_source: null });
  assert.equal(ticketRegex({ CC_TICKET_PATTERN: '#(\\d+)' }).source, '#(\\d+)');
  assert.equal(ticketRegex({ CC_TICKET_PATTERN: '[' }).source, ticketRegex({}).source);
  const lines = parseLines(J({ type: 'user', gitBranch: 'main', message: { content: 'see #1234' } }));
  assert.equal(extractContext(lines, { ticketPattern: /#(\d+)/ }).ticket_id, '#1234');
});

test('default pattern: multi-segment keys match whole, hex ids and UTF-8 style tokens do not', () => {
  const mk = (t) => parseLines(J({ type: 'user', gitBranch: 'main', message: { content: t } }));
  assert.equal(extractContext(mk('see TRI-STOW-0003 and UTF-8')).ticket_id, 'TRI-STOW-0003');
  assert.equal(extractContext(mk('encode as UTF-8 or UTF-16')).ticket_id, null);
  assert.equal(extractContext(mk('id B1D63794-0002 is hex')).ticket_id, null);
  assert.equal(extractContext(mk('UTF-8 first, then real API-77')).ticket_id, 'API-77');
});
