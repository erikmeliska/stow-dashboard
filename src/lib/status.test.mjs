import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseStatus, serializeStatus, readStatus, writeStatus } from './status.mjs'

test('parseStatus reads frontmatter, NEXT and links', () => {
  const s = parseStatus(
    '---\nstatus: active\nupdated: 2026-06-16\n---\n\n' +
    'NEXT: ship SSO logout\n\n## Links\n' +
    '- https://localhost:3000 — dev\n- https://gitlab.com/x — repo\n'
  )
  assert.equal(s.status, 'active')
  assert.equal(s.updated, '2026-06-16')
  assert.equal(s.next, 'ship SSO logout')
  assert.equal(s.links.length, 2)
  assert.equal(s.links[0].url, 'https://localhost:3000')
  assert.equal(s.links[0].label, 'dev')
})

test('parseStatus on empty content returns defaults', () => {
  const s = parseStatus('')
  assert.equal(s.next, null)
  assert.deepEqual(s.links, [])
})

test('serializeStatus round-trips through parseStatus', () => {
  const original = { status: 'paused', updated: '2026-06-16', next: 'do the thing', links: [{ url: 'https://a.test', label: 'x' }], notes: '' }
  const parsed = parseStatus(serializeStatus(original))
  assert.equal(parsed.status, 'paused')
  assert.equal(parsed.next, 'do the thing')
  assert.equal(parsed.links[0].url, 'https://a.test')
})

test('writeStatus then readStatus persists NEXT and status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-status-'))
  try {
    await writeStatus(dir, { status: 'active', updated: '2026-06-16', next: 'first step', links: [] })
    const back = await readStatus(dir)
    assert.equal(back.next, 'first step')
    assert.equal(back.status, 'active')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeStatus merges over existing fields, preserving links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-status-'))
  try {
    await writeStatus(dir, { status: 'active', updated: '2026-06-16', next: 'one', links: [{ url: 'https://a.test', label: '' }] })
    await writeStatus(dir, { next: 'two', updated: '2026-06-16' })
    const back = await readStatus(dir)
    assert.equal(back.next, 'two')
    assert.equal(back.links.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('parseStatus reads the Notes section and writeStatus preserves it', async () => {
  const s = parseStatus(
    '---\nstatus: active\nupdated: 2026-06-16\n---\n\nNEXT: x\n\n' +
    '## Links\n- https://a.test — dev\n\n## Notes\nline one\nline two\n'
  )
  assert.equal(s.notes, 'line one\nline two')
  // read-modify-write must NOT drop notes
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-notes-'))
  try {
    await writeFile(path.join(dir, 'STATUS.md'),
      '---\nstatus: active\nupdated: 2026-06-16\n---\n\nNEXT: x\n\n## Links\n- https://a.test — dev\n\n## Notes\nkeep me\n')
    await writeStatus(dir, { next: 'changed', updated: '2026-06-16' })
    const back = await readStatus(dir)
    assert.equal(back.notes, 'keep me')
    assert.equal(back.next, 'changed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('parseStatus handles a Links section with no trailing newline (hand-edited)', () => {
  const s = parseStatus('---\nstatus: active\nupdated: 2026-06-16\n---\n\nNEXT: x\n\n## Links\n- https://a.test — dev\n- https://b.test — repo')
  assert.equal(s.links.length, 2)
  assert.equal(s.links[1].url, 'https://b.test')
})

test('parseStatus handles Notes as the last section with no trailing newline', () => {
  const s = parseStatus('---\nstatus: active\nupdated: 2026-06-16\n---\n\nNEXT: x\n\n## Notes\nfinal line no newline')
  assert.equal(s.notes, 'final line no newline')
})

test('empty NEXT round-trips as empty, not the next line (set_status with no next)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-emptynext-'))
  try {
    // simulate set_status that only sets status+links, leaving next empty
    await writeStatus(dir, { status: 'paused', updated: '2026-06-16', next: '', links: [{ url: 'https://a.test', label: 'dev' }] })
    const back = await readStatus(dir)
    assert.equal(back.next, '')          // NOT '## Links'
    assert.equal(back.status, 'paused')
    assert.equal(back.links.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
