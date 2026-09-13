import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSessions, QUALITY_FILTERS } from './session-filters.mjs'

const SESSIONS = [
  { session_id: 'a', ticket_id: 'TRI-STOW-0003', project_dir: '/p/stow-dashboard', model: 'claude-opus-4-8', quality_score: 92 },
  { session_id: 'b', ticket_id: 'INT-42', project_dir: '/p/intelimail', model: 'gemini-3.8-flash', quality_score: 61 },
  { session_id: 'c', ticket_id: null, project_dir: '/p/vydavatelstvo/repos/singularita-24-tempo', model: 'gemini-3.8-flash', quality_score: 40 },
  { session_id: 'd', ticket_id: null, project_dir: '/p/sandbox', model: 'claude-sonnet-4-6', quality_score: null },
]
const ids = (rows) => rows.map((s) => s.session_id)

test('no filters returns everything', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, {})), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: '', quality: 'any', model: 'any' })), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: '', quality: 'any', model: 'any' })), ['a', 'b', 'c', 'd'])
})

test('ticket filter matches substring, case-insensitively', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'stow' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'INT' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'nope' })), [])
})

test('search filter matches either ticket or project directory', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'stow' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'singularita' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'vydavatelstvo' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'INT-42' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'SANDBOX' })), ['d'])
})

test('model filter matches exact model case-insensitively or any', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'gemini-3.8-flash' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'GEMINI-3.8-FLASH' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'claude-opus-4-8' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { model: 'any' })), ['a', 'b', 'c', 'd'])
})

test('ticket filter ignores surrounding whitespace', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: '  int-42  ' })), ['b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: '  singularita-24  ' })), ['c'])
})

test('quality thresholds include only scored sessions', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'q90' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'q50' })), ['a', 'b'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'low' })), ['c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'unscored' })), ['d'])
})

test('filters combine (AND)', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'p/', quality: 'q90' })), ['a'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'p/', model: 'gemini-3.8-flash' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(SESSIONS, { search: 'singularita', model: 'claude-opus-4-8' })), [])
  assert.deepEqual(ids(filterSessions(SESSIONS, { ticket: 'INT', quality: 'q90' })), [])
})

test('unknown quality key behaves like any', () => {
  assert.deepEqual(ids(filterSessions(SESSIONS, { quality: 'junk' })), ['a', 'b', 'c', 'd'])
})

test('QUALITY_FILTERS exposes labels for the UI in menu order', () => {
  assert.deepEqual(Object.keys(QUALITY_FILTERS), ['any', 'q90', 'q75', 'q50', 'low', 'unscored'])
  for (const { label } of Object.values(QUALITY_FILTERS)) assert.equal(typeof label, 'string')
})
