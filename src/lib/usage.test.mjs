import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { newFileState, parseClaudeLines, parseCodexLines, splitCompleteLines } from './usage.mjs'

const CL = (over = {}) => JSON.stringify({
  type: 'assistant', timestamp: over.ts ?? '2026-07-10T10:00:00Z', cwd: over.cwd,
  message: { model: over.model ?? 'claude-fable-5', usage: {
    input_tokens: over.in ?? 10, output_tokens: over.out ?? 20,
    cache_read_input_tokens: over.cr ?? 0,
    cache_creation_input_tokens: over.ccLegacy ?? 0,
    cache_creation: over.cc ?? { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  } },
})

test('parseClaudeLines sums per model, reads cwd, tracks active time', () => {
  const s = newFileState('claude')
  parseClaudeLines([
    JSON.stringify({ type: 'user', timestamp: '2026-07-10T10:00:00Z', cwd: '/p/a' }),
    CL({ ts: '2026-07-10T10:01:00Z', in: 100, out: 200, cc: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } }),
    CL({ ts: '2026-07-10T10:02:00Z', model: 'claude-opus-4-8', in: 1, out: 2, cr: 300 }),
    CL({ ts: '2026-07-10T10:20:00Z', in: 5, out: 5 }), // 18-min gap → not active time
  ], s)
  assert.equal(s.cwd, '/p/a')
  assert.equal(s.models['claude-fable-5'].input, 105)
  assert.equal(s.models['claude-fable-5'].output, 205)
  assert.equal(s.models['claude-fable-5'].cacheWrite1h, 500)
  assert.equal(s.models['claude-opus-4-8'].cacheRead, 300)
  assert.equal(s.activeSeconds, 120) // 10:00→10:01→10:02
  assert.equal(s.lastTs, '2026-07-10T10:20:00Z')
})

test('parseClaudeLines legacy cache_creation fallback counts as 5m write', () => {
  const s = newFileState('claude')
  parseClaudeLines([CL({ ccLegacy: 700, cc: {} })], s)
  assert.equal(s.models['claude-fable-5'].cacheWrite5m, 700)
})

test('parseClaudeLines survives garbage lines and continues active time across calls', () => {
  const s = newFileState('claude')
  parseClaudeLines(['not json', CL({ ts: '2026-07-10T10:00:00Z' })], s)
  parseClaudeLines([CL({ ts: '2026-07-10T10:01:00Z' })], s) // tail-parse continuation
  assert.equal(s.activeSeconds, 60)
})

test('parseCodexLines: cumulative token_count REPLACES, session_meta cwd', () => {
  const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T10:00:00Z', payload: { cwd: '/p/b' } })
  const tc = (inp, cached, out, ts) => JSON.stringify({ timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out } } } })
  const s = newFileState('codex')
  parseCodexLines([meta, tc(100, 10, 5, '2026-07-10T10:01:00Z'), tc(300, 200, 40, '2026-07-10T10:02:00Z')], s)
  assert.equal(s.cwd, '/p/b')
  assert.deepEqual(s.codex, { input: 300, cachedInput: 200, output: 40 })
  assert.equal(s.activeSeconds, 120)
})

test('splitCompleteLines returns only complete lines and correct byte count', () => {
  const buf = Buffer.from('ahoj\nsvet čau\npartial', 'utf8')
  const { lines, consumedBytes } = splitCompleteLines(buf)
  assert.deepEqual(lines, ['ahoj', 'svet čau'])
  assert.equal(consumedBytes, Buffer.byteLength('ahoj\nsvet čau\n', 'utf8'))
})

import { mkdtemp, writeFile, appendFile, mkdir, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { updateUsage } from './usage.mjs'

async function makeStores() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-usage-'))
  const claudeDir = path.join(base, 'claude-projects')
  const codexDir = path.join(base, 'codex-sessions')
  await mkdir(path.join(claudeDir, '-p-a'), { recursive: true })
  await mkdir(path.join(codexDir, '2026', '07', '10'), { recursive: true })
  return {
    base, claudeDir, codexDir,
    cacheFile: path.join(base, 'usage-cache.json'),
    outFile: path.join(base, 'usage.json'),
    claudeSession: path.join(claudeDir, '-p-a', 's1.jsonl'),
    codexSession: path.join(codexDir, '2026', '07', '10', 'rollout-1.jsonl'),
  }
}
const claudeLine = (ts, out, cwd) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd, message: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation: {} } } }) + '\n'

test('updateUsage: first run parses, second skips, append tail-parses to same totals', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a/sub'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a', '/p/a/sub'] }
    const r1 = await updateUsage(opts)
    assert.equal(r1.filesParsed, 1)
    const r2 = await updateUsage(opts)
    assert.equal(r2.filesParsed, 0); assert.equal(r2.filesSkipped, 1)
    await appendFile(w.claudeSession, claudeLine('2026-07-10T10:01:00Z', 900, '/p/a/sub'))
    const r3 = await updateUsage(opts)
    assert.equal(r3.filesParsed, 1)
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    const proj = out.projects['/p/a/sub']            // deepest match wins
    assert.equal(proj.tokens.output, 1000)
    assert.equal(proj.sessions, 1)
    assert.ok(proj.costUsd > 0)
    assert.equal(out.projects['/p/a'], undefined)
    assert.equal(proj.sessionList.length, 1)
    assert.equal(proj.sessionList[0].tool, 'claude')
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: deleted transcript stays as missing ghost; rebuild preserves it', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 500, '/p/a'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] }
    await updateUsage(opts)
    await rm(w.claudeSession)
    const r = await updateUsage(opts)
    assert.equal(r.filesMissing, 1)
    let out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 500)   // survived deletion
    await updateUsage({ ...opts, rebuild: true })
    out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 500)   // ghost preserved by rebuild
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: shrunk file is re-parsed from zero (no double counting)', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a') + claudeLine('2026-07-10T10:01:00Z', 100, '/p/a'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] }
    await updateUsage(opts)
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 30, '/p/a')) // rewritten smaller
    await updateUsage(opts)
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 30)
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: codex rollout maps via session_meta cwd; unmatched bucket works', async () => {
  const w = await makeStores()
  try {
    const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T10:00:00Z', payload: { cwd: '/elsewhere' } }) + '\n'
    const tc = JSON.stringify({ timestamp: '2026-07-10T10:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 1000 } } } }) + '\n'
    await writeFile(w.codexSession, meta + tc)
    await updateUsage({ claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] })
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(Object.keys(out.projects).length, 0)
    assert.equal(out.unmatched.sessions, 1)
    // BRIDGE (Task 2): costForCodex now requires a per-session model id (Task 3
    // wires that through); until then every Codex session is correctly unpriced
    // rather than mispriced, per the "unpriced, never $0" rule Claude already had.
    assert.equal(out.unmatched.costUnverifiedUsd, 0)
    assert.ok(out.unmatched.unpricedModels.length > 0)
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: corrupt cache file → full re-parse, no throw', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a'))
    await writeFile(w.cacheFile, '{corrupt')
    const r = await updateUsage({ claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] })
    assert.equal(r.filesParsed, 1)
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: Codex-only session yields unpricedModels containing "unknown", not null', async () => {
  const w = await makeStores()
  try {
    // Create a Codex session with no model id (Task 3 hasn't run yet)
    const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T10:00:00Z', payload: { cwd: '/p/a' } }) + '\n'
    const tc = JSON.stringify({ timestamp: '2026-07-10T10:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } } } }) + '\n'
    await writeFile(w.codexSession, meta + tc)

    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] }
    await updateUsage(opts)

    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    const proj = out.projects['/p/a']

    // Verify unpricedModels contains the string 'unknown', not null/undefined
    assert.ok(Array.isArray(proj.unpricedModels), 'unpricedModels should be an array')
    assert.ok(proj.unpricedModels.includes('unknown'), 'unpricedModels should include "unknown"')
    assert.ok(!proj.unpricedModels.includes(null), 'unpricedModels should not include null')
    assert.ok(!proj.unpricedModels.includes(undefined), 'unpricedModels should not include undefined')
    // Verify no undefined values in the array
    for (const model of proj.unpricedModels) {
      assert.notEqual(model, null, `unpricedModels should not contain null value, got: ${model}`)
      assert.notEqual(model, undefined, `unpricedModels should not contain undefined value, got: ${model}`)
    }
  } finally { await rm(w.base, { recursive: true, force: true }) }
})
