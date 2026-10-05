import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyAction, removeLedgerRows } from './reorg-apply.mjs'

const spy = (exists = () => true) => {
  const calls = []
  return {
    calls,
    writers: {
      writeStowMeta: async (dir, patch) => { calls.push(['meta', dir, patch]) },
      removeLedgerRows: async (dirs) => { calls.push(['remove', dirs]) },
      exists,
    },
  }
}

test('each action maps onto the #8 writers', async () => {
  const { calls, writers } = spy((d) => d !== '/P/gone')
  await applyAction({ type: 'confirm-client', client: 'Acme', directory: '/P/x' }, writers)
  await applyAction({ type: 'set-role', directory: '/P/x-old', role: 'stale' }, writers)
  await applyAction({ type: 'archive-project', directories: ['/P/x', '/P/gone', '/P/x-old'] }, writers)
  await applyAction({ type: 'remove-project', directories: ['/P/gone'] }, writers)
  assert.deepEqual(calls, [
    ['meta', '/P/x', { client: 'Acme' }],
    ['meta', '/P/x-old', { role: 'stale' }],
    ['meta', '/P/x', { role: 'stale' }],
    ['meta', '/P/x-old', { role: 'stale' }],
    ['remove', ['/P/gone']],
  ])
})

test('unknown action type and missing targets are rejected', async () => {
  await assert.rejects(applyAction({ type: 'mv' }, spy().writers), /unknown reorg action/)
  await assert.rejects(applyAction({ type: 'set-role', role: 'stale' }, spy().writers), /directory/)
  await assert.rejects(applyAction({ type: 'remove-project', directories: [] }, spy().writers), /directories/)
})

test('removeLedgerRows drops the rows of the given checkouts and keeps every other line verbatim', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reorg-apply-'))
  const file = path.join(dir, 'projects_metadata.jsonl')
  try {
    const keep = '{"directory":"/P/keep","x":1}'
    const lines = [keep, '{"directory":"/P/gone"}', '{"directory":"/P/gone/sub","checkout":{"root":"/P/gone"}}', 'not json', '{"directory":"/P/gonex"}']
    await writeFile(file, lines.join('\n') + '\n')
    const removed = await removeLedgerRows(['/P/gone'], { file })
    assert.equal(removed, 2)
    assert.equal(await readFile(file, 'utf8'), [keep, 'not json', '{"directory":"/P/gonex"}'].join('\n') + '\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('removeLedgerRows waits for the ledger lock (#11 review I-2)', async () => {
  const { acquireLedgerLock } = await import('./ledger-lock.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'reorg-apply-'))
  const file = path.join(dir, 'projects_metadata.jsonl')
  try {
    await writeFile(file, '{"directory":"/P/gone"}\n{"directory":"/P/keep"}\n')
    const release = await acquireLedgerLock()
    const p = removeLedgerRows(['/P/gone'], { file })
    await new Promise((r) => setTimeout(r, 20))
    // a holder (e.g. the quick refresh) rewrites the ledger meanwhile; the removal must see it
    await writeFile(file, '{"directory":"/P/gone"}\n{"directory":"/P/keep"}\n{"directory":"/P/new"}\n')
    release()
    assert.equal(await p, 1)
    assert.equal(await readFile(file, 'utf8'), '{"directory":"/P/keep"}\n{"directory":"/P/new"}\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
