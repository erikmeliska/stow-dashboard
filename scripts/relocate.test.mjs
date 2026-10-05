import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, formatPlan, formatResult } from './relocate.mjs'

test('dry-run is the default; --apply opts in', () => {
  assert.deepEqual(parseArgs(['--from', '/a', '--to', '/b']), { from: '/a', to: '/b', apply: false, force: false, resume: null })
  assert.equal(parseArgs(['--from', '/a', '--to', '/b', '--apply']).apply, true)
  assert.equal(parseArgs(['--from', '/a', '--to', '/b', '--force']).force, true)
  assert.throws(() => parseArgs(['--from', '/a']), /--to/)
  assert.throws(() => parseArgs(['--to', '/b']), /--from/)
  assert.throws(() => parseArgs(['--from', '/a', '--to', '/b', '--bogus']), /unknown/)
  assert.throws(() => parseArgs(['--from', '/a', '--to', '--apply']), /--to needs a value/)
})

test('--resume needs only a journal', () => {
  assert.deepEqual(parseArgs(['--resume', '/j.json']), { from: null, to: null, apply: false, force: false, resume: '/j.json' })
})

test('formatPlan shows blockers first and numbered steps', () => {
  const out = formatPlan({ ok: false, from: '/a', to: '/b', blockers: ['x exists'], warnings: ['w'], steps: [{ description: 'Move a → b' }] })
  assert.match(out, /BLOCKED[\s\S]*x exists[\s\S]*w[\s\S]*1\. Move a → b/)
  assert.match(formatPlan({ ok: true, from: '/a', to: '/b', blockers: [], warnings: [], steps: [] }), /dry-run/i)
})

test('formatResult reports rollback and the journal', () => {
  assert.match(formatResult({ ok: false, failed: { kind: 'db', error: 'boom' }, rolledBack: true, journal: '/j' }), /db[\s\S]*boom[\s\S]*rolled back[\s\S]*\/j/)
  assert.match(formatResult({ ok: false, failed: { kind: 'db', error: 'boom' }, rolledBack: false, journal: '/j' }), /manual fix[\s\S]*--resume \/j/)
  assert.match(formatResult({ ok: true, done: ['move-dir'], journal: '/j' }), /Moved/)
})
