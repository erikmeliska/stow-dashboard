import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveMovedPath, loadPathMoves, appendPathMove, removePathMove, PathMovesError } from './path-moves.mjs'

const M = (from, to, id = from) => ({ id, from, to, at: '2026-10-05T00:00:00Z' })

test('exact and nested paths are rewritten', () => {
  const moves = [M('/P/old', '/P/_Bizz/Acme/old')]
  assert.equal(resolveMovedPath('/P/old', moves), '/P/_Bizz/Acme/old')
  assert.equal(resolveMovedPath('/P/old/src/x', moves), '/P/_Bizz/Acme/old/src/x')
})

test('prefix needs a path boundary', () => {
  assert.equal(resolveMovedPath('/P/oldish', [M('/P/old', '/Q')]), '/P/oldish')
})

test('chained moves resolve in order', () => {
  assert.equal(resolveMovedPath('/a/x', [M('/a', '/b'), M('/b', '/c')]), '/c/x')
})

test('null and no moves pass through', () => {
  assert.equal(resolveMovedPath(null, [M('/a', '/b')]), null)
  assert.equal(resolveMovedPath('/a', []), '/a')
})

test('load: missing → [], malformed → PathMovesError, append/remove round-trip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pm-'))
  const file = path.join(dir, 'path-moves.json')
  try {
    assert.deepEqual(await loadPathMoves({ file }), [])
    await appendPathMove(M('/a', '/b', 'm1'), { file })
    await appendPathMove(M('/b', '/c', 'm2'), { file })
    assert.deepEqual((await loadPathMoves({ file })).map(m => m.id), ['m1', 'm2'])
    await removePathMove('m2', { file })
    assert.deepEqual((await loadPathMoves({ file })).map(m => m.id), ['m1'])
    await writeFile(file, '{nope')
    await assert.rejects(loadPathMoves({ file }), PathMovesError)
    await assert.rejects(appendPathMove(M('/x', '/y'), { file }), PathMovesError)
    assert.equal(await readFile(file, 'utf8'), '{nope') // never overwritten
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('state-dir default: the file lives in data/ of the resolved state dir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pm-'))
  try {
    const opts = { env: { STOW_STATE_DIR: dir } }
    await appendPathMove(M('/a', '/b', 'm1'), opts)
    assert.deepEqual((await loadPathMoves(opts)).map(m => m.id), ['m1'])
    assert.ok((await readFile(path.join(dir, 'data', 'path-moves.json'), 'utf8')).includes('"m1"'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('time-scoped: a move only applies to records from before it (a new project at the old path stays put)', () => {
  const moves = [
    { id: 'm1', from: '/P/foo', to: '/P/bar', at: '2026-01-01T00:00:00Z' },
    { id: 'm2', from: '/P/foo', to: '/P/baz', at: '2026-06-01T00:00:00Z' },
  ]
  assert.equal(resolveMovedPath('/P/foo/x', moves, { at: '2025-12-01T00:00:00Z' }), '/P/bar/x')
  assert.equal(resolveMovedPath('/P/foo/x', moves, { at: '2026-03-01T00:00:00Z' }), '/P/baz/x')
  assert.equal(resolveMovedPath('/P/foo/x', moves, { at: '2026-07-01T00:00:00Z' }), '/P/foo/x')
  // chain: bar moved on later still follows for an old record
  const chain = [moves[0], { id: 'm3', from: '/P/bar', to: '/P/qux', at: '2026-02-01T00:00:00Z' }]
  assert.equal(resolveMovedPath('/P/foo', chain, { at: '2025-12-01T00:00:00Z' }), '/P/qux')
})
