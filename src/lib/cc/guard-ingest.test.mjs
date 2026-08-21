import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuardAudit } from './guard-ingest.mjs';

const text = [
  JSON.stringify({ ts: '2026-08-21T10:05:00Z', action: 'deny', rule: 'rm-rf-dangerous', command: 'rm -rf /', session_id: 'sess-1' }),
  JSON.stringify({ ts: '2026-08-21T10:06:00Z', action: 'warn', rule: 'git-reset-hard', command: 'git reset --hard', session_id: 'sess-1' }),
  'not json',
  JSON.stringify({ ts: '2026-08-21T10:07:00Z', action: 'deny', rule: 'mkfs', command: 'mkfs /dev/x' }),
].join('\n');

test('groups guard hits by session_id, skips bad lines', () => {
  const map = parseGuardAudit(text);
  assert.equal(map.get('sess-1').length, 2);
  assert.equal(map.get('sess-1')[0].action, 'deny');
  assert.deepEqual(map.get('sess-1')[1], { ts: '2026-08-21T10:06:00Z', command: 'git reset --hard', rule: 'git-reset-hard', action: 'warn' });
  assert.equal(map.get('').length, 1);
});

test('empty / missing text yields an empty map', () => {
  assert.equal(parseGuardAudit('').size, 0);
  assert.equal(parseGuardAudit(undefined).size, 0);
});
