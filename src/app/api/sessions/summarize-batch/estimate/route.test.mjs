import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession } from '../../../../../lib/cc/store.mjs';
import { handleEstimate } from './route.js';

test('estimate counts only ids that need a summary', () => {
  const db = openStore(':memory:');
  const now = Date.parse('2026-09-30T12:00:00Z');
  upsertSession(db, { session_id: 'old', raw_ref: '/t', started_at: '2026-09-10T10:00:00Z', ended_at: '2026-09-10T11:00:00Z' });
  upsertSession(db, { session_id: 'live', raw_ref: '/t', started_at: '2026-09-30T11:50:00Z', ended_at: '2026-09-30T11:59:00Z' });
  const r = handleEstimate({ ids: ['old', 'live'] }, db, now);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.ids, ['old']);
  assert.equal(r.estimateSeconds, 30);
  assert.equal(r.job, null);
});
