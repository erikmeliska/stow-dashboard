import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseTasks, serializeTasks, readTasks, writeTasks, allocateTaskId, addTask } from './tasks.mjs'

test('parseTasks reads id, text, source, priority, done', () => {
  const ts = parseTasks('# Tasks\n\n## P1\n- [ ] [INV-CLM-0042] Add SSO logout — from Meetings/x.md\n- [x] [INV-CLM-0041] done thing\n\n## P2\n- [ ] no id task\n')
  assert.equal(ts.length, 3)
  assert.equal(ts[0].id, 'INV-CLM-0042')
  assert.equal(ts[0].text, 'Add SSO logout')
  assert.equal(ts[0].source, 'Meetings/x.md')
  assert.equal(ts[0].priority, 'P1')
  assert.equal(ts[0].done, false)
  assert.equal(ts[1].done, true)
  assert.equal(ts[2].id, null)
  assert.equal(ts[2].priority, 'P2')
})

test('serializeTasks round-trips through parseTasks, grouped by priority', () => {
  const tasks = [
    { done: false, id: 'A-0002', text: 'second', source: null, priority: 'P2' },
    { done: false, id: 'A-0001', text: 'first', source: 'm.md', priority: 'P1' },
  ]
  const parsed = parseTasks(serializeTasks(tasks))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].priority, 'P1')  // P1 group first
  assert.equal(parsed[0].id, 'A-0001')
  assert.equal(parsed[0].source, 'm.md')
  assert.equal(parsed[1].priority, 'P2')
})

test('parseTasks on empty returns []', () => {
  assert.deepEqual(parseTasks(''), [])
})

test('allocateTaskId increments and persists in .stow/seq', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-tasks-'))
  try {
    const a = await allocateTaskId(dir, 'INV-CLM')
    const b = await allocateTaskId(dir, 'INV-CLM')
    assert.equal(a, 'INV-CLM-0001')
    assert.equal(b, 'INV-CLM-0002')
    assert.match(await readFile(path.join(dir, '.stow', 'seq'), 'utf-8'), /2/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('addTask allocates an id and appends to TASKS.md', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-tasks-'))
  try {
    const t1 = await addTask(dir, { text: 'first task', priority: 'P1', source: 'Meetings/a.md', prefix: 'INV-CLM' })
    const t2 = await addTask(dir, { text: 'second task', priority: 'P2', prefix: 'INV-CLM' })
    assert.equal(t1.id, 'INV-CLM-0001')
    assert.equal(t2.id, 'INV-CLM-0002')
    const back = await readTasks(dir)
    assert.equal(back.length, 2)
    assert.equal(back.find(t => t.id === 'INV-CLM-0001').source, 'Meetings/a.md')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeTasks then readTasks round-trips', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-tasks-'))
  try {
    await writeTasks(dir, [{ done: false, id: 'X-0001', text: 'hi', source: null, priority: 'P3' }])
    const back = await readTasks(dir)
    assert.equal(back[0].priority, 'P3')
    assert.equal(back[0].id, 'X-0001')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
