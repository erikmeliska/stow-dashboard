import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claudeSlug, findClaudeProjectDirs } from './claude-project-dirs.mjs'

test('claudeSlug matches Claude Code folder names', () => {
  assert.equal(claudeSlug('/Users/ericsko/Projekty/_AgentOffice/erikmeliska/stow-dashboard'), '-Users-ericsko-Projekty--AgentOffice-erikmeliska-stow-dashboard')
  assert.equal(claudeSlug('/Users/ericsko/.claude/plugins/marketplaces/boys-from-heaven'), '-Users-ericsko--claude-plugins-marketplaces-boys-from-heaven')
  assert.equal(claudeSlug('/P/a_b.c d'), '-P-a-b-c-d')
})

async function home() {
  const root = await mkdtemp(path.join(tmpdir(), 'cpd-'))
  const add = async (slug, lines, name = 's1.jsonl') => {
    const d = path.join(root, slug); await mkdir(d, { recursive: true })
    await writeFile(path.join(d, name), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
    return d
  }
  return { root, add, done: () => rm(root, { recursive: true, force: true }) }
}

test('selects folders by transcript cwd with a path boundary; colliding slugs are told apart', async () => {
  const h = await home()
  try {
    await h.add(claudeSlug('/P/a_b'), [{ type: 'summary' }, { type: 'user', cwd: '/P/a_b' }])
    await h.add(claudeSlug('/P/a-b') + 'x', [{ type: 'user', cwd: '/P/a-b' }]) // same-looking, different cwd
    await h.add(claudeSlug('/P/a_b/sub'), [{ type: 'user', cwd: '/P/a_b/sub' }])
    await h.add(claudeSlug('/P/a_bc'), [{ type: 'user', cwd: '/P/a_bc' }])
    const got = await findClaudeProjectDirs(h.root, '/P/a_b')
    assert.deepEqual(got.map(g => g.cwd).sort(), ['/P/a_b', '/P/a_b/sub'])
    assert.deepEqual(got.find(g => g.cwd === '/P/a_b').files, ['s1.jsonl'])
    assert.equal(got[0].hasMemory, false)
  } finally { await h.done() }
})

test('prefers a cwd whose slug is the folder name over a stray first cwd', async () => {
  const h = await home()
  try {
    const d = await h.add(claudeSlug('/P/real'), [{ type: 'user', cwd: '/P/other' }], 'a.jsonl')
    await writeFile(path.join(d, 'b.jsonl'), JSON.stringify({ type: 'user', cwd: '/P/real' }) + '\n')
    await mkdir(path.join(d, 'memory'))
    const [g] = await findClaudeProjectDirs(h.root, '/P/real')
    assert.equal(g.cwd, '/P/real')
    assert.equal(g.hasMemory, true)
    assert.deepEqual(g.files, ['a.jsonl', 'b.jsonl', 'memory'])
    assert.deepEqual(await findClaudeProjectDirs(h.root, '/P/other'), [])
  } finally { await h.done() }
})

test('a folder without any cwd is ignored, and only the first 64 KB of a transcript are read', async () => {
  const h = await home()
  try {
    await h.add(claudeSlug('/P/x'), [{ type: 'summary' }])
    await h.add(claudeSlug('/P/y'), [JSON.stringify({ type: 'user', pad: 'z'.repeat(70 * 1024) }), { type: 'user', cwd: '/P/y' }])
    assert.deepEqual(await findClaudeProjectDirs(h.root, '/P'), [])
    assert.deepEqual(await findClaudeProjectDirs(path.join(h.root, 'missing'), '/P'), [])
  } finally { await h.done() }
})

test('a folder moved earlier is found through path-moves (its transcripts keep the old cwd)', async () => {
  const h = await home()
  try {
    // After /P/old → /P/new: the folder is named for /P/new, its transcript still says /P/old.
    await h.add(claudeSlug('/P/new'), [{ type: 'user', cwd: '/P/old' }])
    const moves = [{ id: 'm', from: '/P/old', to: '/P/new', at: 'x' }]
    assert.deepEqual(await findClaudeProjectDirs(h.root, '/P/new'), [])
    const [g] = await findClaudeProjectDirs(h.root, '/P/new', { moves })
    assert.equal(g.cwd, '/P/new')
    assert.equal(g.slug, claudeSlug('/P/new'))
  } finally { await h.done() }
})

test('alias resolution is time-scoped by the transcript timestamp (#11 review I-1)', async () => {
  const h = await home()
  try {
    // A new project at /P/old after it moved: its transcripts are newer than the move.
    await h.add(claudeSlug('/P/old'), [{ type: 'user', cwd: '/P/old', timestamp: '2026-11-01T00:00:00Z' }])
    const moves = [{ id: 'm', from: '/P/old', to: '/P/new', at: '2026-10-05T00:00:00Z' }]
    assert.deepEqual(await findClaudeProjectDirs(h.root, '/P/new', { moves }), [])
    assert.equal((await findClaudeProjectDirs(h.root, '/P/old', { moves })).length, 1)
  } finally { await h.done() }
})

test('a memory-only folder (transcripts pruned) is matched by its slug (#11 review I-6)', async () => {
  const h = await home()
  try {
    const d = path.join(h.root, claudeSlug('/P/proj')); await mkdir(path.join(d, 'memory'), { recursive: true })
    const old = path.join(h.root, claudeSlug('/P/was')); await mkdir(path.join(old, 'memory'), { recursive: true })
    const [g] = await findClaudeProjectDirs(h.root, '/P/proj')
    assert.equal(g.cwd, '/P/proj'); assert.equal(g.hasMemory, true); assert.deepEqual(g.files, ['memory'])
    // a memory-only folder left at the slug of a path that was moved here
    const moved = await findClaudeProjectDirs(h.root, '/P/proj', { moves: [{ id: 'm', from: '/P/was', to: '/P/proj', at: 'z' }] })
    assert.deepEqual(moved.map(x => x.slug).sort(), [claudeSlug('/P/proj'), claudeSlug('/P/was')].sort())
  } finally { await h.done() }
})
