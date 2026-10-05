import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadDismissed, dismiss, undismiss } from './reorg-dismissed.mjs'

async function withFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reorg-dis-'))
  try { await fn(path.join(dir, 'reorg-dismissed.json')) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('dismiss → load has it with its fingerprint', () => withFile(async (file) => {
  assert.deepEqual(await loadDismissed({ file }), {})
  await dismiss('stale-copy:p1:/P/a', '{"x":1}', { file, now: '2026-10-05T00:00:00Z' })
  assert.deepEqual(await loadDismissed({ file }), { 'stale-copy:p1:/P/a': { at: '2026-10-05T00:00:00Z', fingerprint: '{"x":1}' } })
}))

test('undismiss removes it', () => withFile(async (file) => {
  await dismiss('a', 'f1', { file })
  await dismiss('b', 'f2', { file })
  await undismiss('a', { file })
  assert.deepEqual(Object.keys(await loadDismissed({ file })), ['b'])
}))

test('a malformed file loads as {} and the next dismiss rewrites it (dismissals are disposable UI state)', () => withFile(async (file) => {
  await writeFile(file, '{broken')
  assert.deepEqual(await loadDismissed({ file }), {})
  await dismiss('a', 'f', { file })
  assert.deepEqual(Object.keys(await loadDismissed({ file })), ['a'])
}))
