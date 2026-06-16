import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { serializeBrief, writeBrief, claudeDesktopArgs } from './dispatch.mjs'
import { readStatus } from './status.mjs'

test('serializeBrief includes task id and text', () => {
  const s = serializeBrief({ taskId: 'INV-CLM-0001', text: 'do the thing', date: '2026-06-16' })
  assert.match(s, /# Brief: INV-CLM-0001/)
  assert.match(s, /do the thing/)
  assert.match(s, /Dispatched: 2026-06-16/)
})

test('writeBrief writes BRIEF.md and sets STATUS NEXT', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-disp-'))
  try {
    const p = await writeBrief(dir, { taskId: 'INV-CLM-0002', text: 'ship logout', date: '2026-06-16' })
    assert.match(p, /BRIEF\.md$/)
    const brief = await readFile(path.join(dir, 'BRIEF.md'), 'utf-8')
    assert.match(brief, /ship logout/)
    const st = await readStatus(dir)
    assert.match(st.next, /BRIEF\.md/)
    assert.match(st.next, /INV-CLM-0002/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeBrief with setNext:false does not touch STATUS', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-disp-'))
  try {
    await writeBrief(dir, { text: 'no status change', date: '2026-06-16', setNext: false })
    const st = await readStatus(dir)
    assert.equal(st.next, null)  // STATUS.md never created/changed
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('claudeDesktopArgs returns open argv for the repo', () => {
  assert.deepEqual(claudeDesktopArgs('/x/y'), ['-a', 'Claude', '/x/y'])
})
