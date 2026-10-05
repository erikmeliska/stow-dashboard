import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withLedgerLock, acquireLedgerLock, writeFileAtomic } from './ledger-lock.mjs'

test('withLedgerLock runs holders one at a time, in order', async () => {
  const log = []
  let release
  const gate = new Promise((r) => { release = r })
  const a = withLedgerLock(async () => { log.push('a:start'); await gate; log.push('a:end') })
  const b = withLedgerLock(async () => { log.push('b') })
  const c = withLedgerLock(async () => { log.push('c') })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(log, ['a:start'])
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(log, ['a:start', 'a:end', 'b', 'c'])
})

test('a throwing holder releases the lock; release is idempotent', async () => {
  await assert.rejects(withLedgerLock(async () => { throw new Error('x') }), /x/)
  const release = await acquireLedgerLock()
  release(); release()
  assert.equal(await withLedgerLock(async () => 'next'), 'next')
})

test('writeFileAtomic replaces the file without leaving temp files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'llock-'))
  try {
    const f = path.join(dir, 'l.jsonl')
    await writeFileAtomic(f, 'a\n'); await writeFileAtomic(f, 'b\n')
    assert.equal(await readFile(f, 'utf8'), 'b\n')
    assert.deepEqual(await readdir(dir), ['l.jsonl'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
