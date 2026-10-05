import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { newProjectId, parseStowMeta, readStowMeta, writeStowMeta, excludeFromGit } from './stow-meta.mjs'

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'stow-meta-')) }

test('newProjectId: format and uniqueness', () => {
  const a = newProjectId(), b = newProjectId()
  assert.match(a, /^p_[a-z2-7]{12}$/)
  assert.notEqual(a, b)
})

test('parseStowMeta: valid, invalid fields, malformed', () => {
  assert.deepEqual(parseStowMeta('{"version":1,"id":"p_abcdefghijkl","client":"Intelimail","role":"deploy","x":1}'),
    { meta: { version: 1, id: 'p_abcdefghijkl', client: 'Intelimail', role: 'deploy', x: 1 }, warnings: [] })
  const r = parseStowMeta('{"id":"p_abcdefghijkl","client":"  ","role":"prod"}')
  assert.deepEqual(r.meta, { id: 'p_abcdefghijkl' })
  assert.equal(r.warnings.length, 2)
  assert.equal(parseStowMeta('{nope').meta, null)
  assert.equal(parseStowMeta('[]').meta, null)
  assert.equal(parseStowMeta('{"client":"X"}').meta, null) // id required
})

test('readStowMeta: missing file is no meta, no warning', async () => {
  const dir = await tmp()
  try { assert.deepEqual(await readStowMeta(dir), { meta: null, warnings: [] }) }
  finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('writeStowMeta: creates id, merges, deletes on null, keeps unknown keys, excludes from git once', async () => {
  const dir = await tmp()
  const exclude = path.join(dir, 'fakegit', 'info', 'exclude')
  const calls = []
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return 'fakegit/info/exclude\n' }
  try {
    const m1 = await writeStowMeta(dir, { client: 'Intelimail' }, { exec })
    assert.match(m1.id, /^p_[a-z2-7]{12}$/)
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.stow', 'project.json'), 'utf8'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), JSON.stringify({ ...raw, extra: true }))
    const m2 = await writeStowMeta(dir, { role: 'stale', client: null }, { exec })
    assert.deepEqual(m2, { version: 1, id: m1.id, extra: true, role: 'stale' })
    assert.equal(await fs.readFile(exclude, 'utf8'), '.stow/\n')
    assert.deepEqual(calls[0], ['git', '-C', dir, 'rev-parse', '--git-path', 'info/exclude'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('writeStowMeta: refuses to overwrite a malformed file and rejects a bad role', async () => {
  const dir = await tmp()
  const exec = async () => { throw new Error('not a repo') }
  try {
    await assert.rejects(writeStowMeta(dir, { role: 'prod' }, { exec }), /role/)
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), '{broken')
    await assert.rejects(writeStowMeta(dir, { client: 'X' }, { exec }), /malformed/)
    assert.equal(await fs.readFile(path.join(dir, '.stow', 'project.json'), 'utf8'), '{broken')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('excludeFromGit: not a repo → false; appends after a line without newline; skips if present', async () => {
  const dir = await tmp()
  try {
    assert.equal(await excludeFromGit(dir, { exec: async () => { throw new Error('x') } }), false)
    const ex = path.join(dir, 'exclude')
    await fs.writeFile(ex, '# git ls-files\n*.log')
    const exec = async () => `${ex}\n`
    assert.equal(await excludeFromGit(dir, { exec }), true)
    assert.equal(await fs.readFile(ex, 'utf8'), '# git ls-files\n*.log\n.stow/\n')
    assert.equal(await excludeFromGit(dir, { exec }), false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
