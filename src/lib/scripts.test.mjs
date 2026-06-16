import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { listScripts, runScript } from './scripts.mjs'

test('listScripts returns package.json scripts and .sh files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scripts-'))
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', build: 'next build' } }))
    await writeFile(path.join(dir, 'deploy.sh'), '#!/bin/bash\necho hi\n')
    const s = await listScripts(dir)
    assert.equal(s.dev, 'next dev')
    assert.equal(s.build, 'next build')
    assert.equal(s['deploy.sh'], './deploy.sh')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('listScripts on empty dir returns empty object', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scripts-'))
  try {
    assert.deepEqual(await listScripts(dir), {})
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('runScript spawns a detached process and returns pid + logFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-run-'))
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { noop: 'true' } }))
    const r = await runScript(dir, 'noop', { now: 12345 })
    assert.ok(r.pid > 0)
    assert.match(r.logFile, /noop-12345\.log$/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
