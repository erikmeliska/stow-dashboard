import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from './transcript.mjs';
import { scoreSession, verifyRegex } from './quality.mjs';

const J = (o) => JSON.stringify(o);
const asst = (content) => J({ type: 'assistant', message: { content } });
const use = (name, input) => ({ type: 'tool_use', name, input });
const res = (is_error = false) => J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error }] } });

test('perfect session scores 100 with every component earned', () => {
  const lines = parseLines([asst([use('Bash', { command: 'npm test' })]), res(false), asst([{ type: 'text', text: 'done' }])].join('\n'));
  const { score, detail } = scoreSession(lines);
  assert.equal(score, 100);
  assert.equal(detail.verified, true);
  assert.equal(detail.clean_finish, true);
  assert.equal(detail.error_rate_pct, 0);
  assert.equal(detail.loops, 0);
  assert.deepEqual(detail.points, { verified: 25, clean_finish: 25, error_rate: 25, no_loops: 15, guard_clean: 10 });
});

test('errors, loops, guard denies and an error ending cost points', () => {
  const loop = asst([use('Read', { file_path: '/a' })]);
  const lines = parseLines([
    asst([use('Bash', { command: 'ls' })]), res(true),
    loop, res(), loop, res(), loop, res(),
    asst([use('Bash', { command: 'some-failing-command' })]), res(true),
  ].join('\n'));
  const { score, detail } = scoreSession(lines, { guardHits: [{ action: 'deny' }] });
  assert.equal(detail.verified, false);
  assert.equal(detail.clean_finish, false);
  assert.equal(detail.loops, 1);
  assert.equal(detail.guard_incidents, 1);
  assert.equal(detail.error_rate_pct, 40);
  assert.equal(score, 0);
});

test('error rate is linear to zero at 20%', () => {
  const lines = parseLines([asst([use('Bash', { command: 'ls' })]), res(true), ...Array(9).fill(res())].join('\n'));
  const { detail } = scoreSession(lines);
  assert.equal(detail.error_rate_pct, 10);
  assert.equal(detail.points.error_rate, 12.5);
});

test('empty transcript scores without throwing', () => {
  const { score, detail } = scoreSession([]);
  assert.equal(detail.clean_finish, false);
  assert.equal(score, 50); // error_rate 25 + no_loops 15 + guard_clean 10
});

test('verifyRegex honours env and falls back on invalid', () => {
  assert.ok(verifyRegex({ CC_VERIFY_PATTERN: 'make check' }).test('make check'));
  assert.ok(verifyRegex({ CC_VERIFY_PATTERN: '(' }).test('npm test'));
});
