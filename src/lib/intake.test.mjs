import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseIntake, serializeIntake, readIntake, appendIntake, removeIntake } from './intake.mjs'

const tmpFile = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'stow-intake-')), 'INTAKE.md')

test('parseIntake reads routing, priority, text, source', () => {
  const items = parseIntake('## Inbox\n\n- [ ] (clm-backend, P1) Add SSO logout — from Meetings/x.md\n- [ ] some raw idea\n')
  assert.equal(items.length, 2)
  assert.equal(items[0].project, 'clm-backend')
  assert.equal(items[0].priority, 'P1')
  assert.equal(items[0].text, 'Add SSO logout')
  assert.equal(items[0].source, 'Meetings/x.md')
  assert.equal(items[1].project, null)
  assert.equal(items[1].text, 'some raw idea')
})

test('parseIntake on empty returns []', () => {
  assert.deepEqual(parseIntake(''), [])
})

test('serializeIntake round-trips through parseIntake', () => {
  const items = [{ done: false, project: 'pqq-ui', priority: 'P2', text: 'do thing', source: 'quick-capture' }]
  const parsed = parseIntake(serializeIntake(items))
  assert.equal(parsed[0].project, 'pqq-ui')
  assert.equal(parsed[0].priority, 'P2')
  assert.equal(parsed[0].source, 'quick-capture')
})

test('appendIntake adds an item to the file', async () => {
  const f = await tmpFile()
  try {
    await appendIntake(f, { text: 'first', project: 'clm-backend', priority: 'P1', source: 'Meetings/a.md' })
    await appendIntake(f, { text: 'second' })
    const items = await readIntake(f)
    assert.equal(items.length, 2)
    assert.equal(items[0].project, 'clm-backend')
    assert.equal(items[1].project, null)
  } finally { await rm(path.dirname(f), { recursive: true, force: true }) }
})

test('removeIntake removes matching items and returns them', async () => {
  const f = await tmpFile()
  try {
    await appendIntake(f, { text: 'keep me', project: 'a' })
    await appendIntake(f, { text: 'remove me', project: 'b' })
    const removed = await removeIntake(f, it => it.project === 'b')
    assert.equal(removed.length, 1)
    assert.equal(removed[0].text, 'remove me')
    const left = await readIntake(f)
    assert.equal(left.length, 1)
    assert.equal(left[0].text, 'keep me')
  } finally { await rm(path.dirname(f), { recursive: true, force: true }) }
})

test('readIntake on a missing file returns []', async () => {
  assert.deepEqual(await readIntake('/no/such/INTAKE.md'), [])
})
