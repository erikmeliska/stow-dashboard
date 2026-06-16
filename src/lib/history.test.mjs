import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { scanDoneCommits, verifyTask, auditTasks, generateChangelog } from './history.mjs'

const exec = promisify(execFile)

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-hist-'))
  await exec('git', ['init', '-q'], { cwd: dir })
  await exec('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
  await exec('git', ['config', 'user.name', 'T'], { cwd: dir })
  return dir
}
async function commit(dir, msg, file = 'f.txt') {
  await writeFile(path.join(dir, file), Math.random().toString())
  await exec('git', ['add', '-A'], { cwd: dir })
  await exec('git', ['commit', '-q', '-m', msg], { cwd: dir })
}

test('scanDoneCommits groups commits by task id', async () => {
  const dir = await makeRepo()
  try {
    await commit(dir, '[INV-CLM-0001] add logout')
    await commit(dir, 'no id here')
    await commit(dir, 'fix [INV-CLM-0001] follow-up')
    const map = await scanDoneCommits(dir)
    assert.equal(map['INV-CLM-0001'].length, 2)
    assert.ok(map['INV-CLM-0001'][0].hash)
    assert.ok(map['INV-CLM-0001'][0].date)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('scanDoneCommits on a non-git dir returns {}', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-nogit-'))
  try { assert.deepEqual(await scanDoneCommits(dir), {}) }
  finally { await rm(dir, { recursive: true, force: true }) }
})

test('verifyTask reports evidence presence', async () => {
  const dir = await makeRepo()
  try {
    await commit(dir, '[INV-CLM-0002] done')
    assert.equal((await verifyTask(dir, 'INV-CLM-0002')).hasEvidence, true)
    assert.equal((await verifyTask(dir, 'INV-CLM-9999')).hasEvidence, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('auditTasks flags done tasks without a commit', async () => {
  const dir = await makeRepo()
  try {
    await commit(dir, '[INV-CLM-0003] real work')
    // TASKS.md: one done WITH evidence, one done WITHOUT
    await writeFile(path.join(dir, 'TASKS.md'),
      '# Tasks\n\n## P1\n- [x] [INV-CLM-0003] real work\n- [x] [INV-CLM-0004] claimed but no commit\n')
    const audit = await auditTasks(dir)
    const byId = Object.fromEntries(audit.map(t => [t.id, t]))
    assert.equal(byId['INV-CLM-0003'].hasEvidence, true)
    assert.equal(byId['INV-CLM-0004'].hasEvidence, false)
    assert.equal(audit.length, 2)   // only done tasks
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('generateChangelog lists task-id commits', async () => {
  const dir = await makeRepo()
  try {
    await commit(dir, '[INV-CLM-0005] shipped thing')
    const cl = await generateChangelog(dir)
    assert.match(cl, /# Changelog/)
    assert.match(cl, /INV-CLM-0005/)
    assert.match(cl, /shipped thing/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
