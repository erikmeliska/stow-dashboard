import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKind, pickParent, turnEndTimestamps } from './session-link.mjs';

test('classifyKind: SDK security reviews are children, everything else is main', () => {
  assert.equal(classifyKind({ entrypoint: 'sdk-py', firstPrompt: 'Review this change for security vulnerabilities.\n\nChanged files' }), 'security-review');
  assert.equal(classifyKind({ entrypoint: 'sdk-py', firstPrompt: 'You previously flagged these candidate vulnerabilities…' }), 'security-review');
  assert.equal(classifyKind({ entrypoint: 'cli', firstPrompt: 'Review this change for security vulnerabilities.' }), 'main', 'a human asking for a review is not a hook child');
  assert.equal(classifyKind({ entrypoint: 'sdk-py', firstPrompt: 'Summarise this repo' }), 'main', 'a plain SDK script is its own session');
  assert.equal(classifyKind({ entrypoint: null, firstPrompt: '' }), 'main');
});

test('turnEndTimestamps collects assistant timestamps without JSON-parsing', () => {
  const text = [
    '{"type":"user","timestamp":"2026-09-15T10:00:00.000Z"}',
    '{"type":"assistant","timestamp":"2026-09-15T10:00:09.000Z","message":{}}',
    'garbage line',
    '{"type":"assistant","timestamp":"2026-09-15T10:00:05.000Z"}',
  ].join('\n');
  assert.deepEqual(turnEndTimestamps(text), [Date.parse('2026-09-15T10:00:05Z'), Date.parse('2026-09-15T10:00:09Z')]);
});

const child = { session_id: 'c', project_dir: '/p/a', started_at: '2026-09-15T10:00:10.000Z' };
const at = (iso) => Date.parse(iso);

test('pickParent: none/no timing → null', () => {
  assert.equal(pickParent(child, [], { turnEndsOf: () => [] }), null);
  assert.equal(pickParent(child, [{ session_id: 'p1', project_dir: '/p/a' }]), null, 'no turnEndsOf → no evidence → no link');
  assert.equal(pickParent(child, [{ session_id: 'p1', project_dir: '/p/a' }], { turnEndsOf: () => [] }), null);
});

test('pickParent: the candidate whose line ended closest before the child wins, whatever its directory', () => {
  const ends = {
    idle: [at('2026-09-15T09:30:00Z')],                                       // idle half an hour → beyond MAX_GAP
    other: [at('2026-09-15T09:59:00Z'), at('2026-09-15T10:00:09.500Z')],     // sibling repo, stopped 0.5 s before
    after: [at('2026-09-15T10:00:30Z')],                                      // only lines after the child
  };
  const candidates = [{ session_id: 'after', project_dir: '/p/x' }, { session_id: 'other', project_dir: '/p/b' }, { session_id: 'idle', project_dir: '/p/a' }];
  const r = pickParent(child, candidates, { turnEndsOf: (c) => ends[c.session_id] });
  assert.equal(r.parent_session_id, 'other');
  assert.equal(r.method, 'timing');
  assert.equal(r.gap_ms, 500);
});

test('pickParent: a same-directory candidate with a plausible gap beats a closer one elsewhere', () => {
  const ends = { same: [at('2026-09-15T09:59:40Z')], other: [at('2026-09-15T10:00:09Z')] };
  const r = pickParent(child, [{ session_id: 'other', project_dir: '/p/b' }, { session_id: 'same', project_dir: '/p/a' }], { turnEndsOf: (c) => ends[c.session_id] });
  assert.deepEqual(r, { parent_session_id: 'same', method: 'same-dir', gap_ms: 30000 });
});

test('pickParent: a line stamped within the grace window after the child start still counts', () => {
  const ends = { p1: [at('2026-09-15T10:00:12Z')], p2: [at('2026-09-15T09:00:00Z')] };
  const r = pickParent(child, [{ session_id: 'p1', project_dir: '/q' }, { session_id: 'p2', project_dir: '/q' }], { turnEndsOf: (c) => ends[c.session_id] });
  assert.equal(r.parent_session_id, 'p1');
});
