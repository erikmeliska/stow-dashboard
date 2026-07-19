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

// Codex per-model attribution helpers. `turn_context` is a TOP-LEVEL type and
// its payload carries no `type` field — a parser mirroring the `token_count`
// branch (`pay.type === ...`) would match zero lines.
const ctx = (model, ts) => JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { cwd: '/p/b', model, approval_policy: 'on-request', summary: 'auto' } })
const tcl = (inp, cached, out, ts) => JSON.stringify({ timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out } } } })

test('parseCodexLines: turn_context switches model, deltas split across models', () => {
  const s = newFileState('codex')
  parseCodexLines([
    ctx('gpt-5.1-codex-max', '2026-07-10T10:00:00Z'),
    tcl(100, 10, 5, '2026-07-10T10:01:00Z'),
    tcl(300, 200, 40, '2026-07-10T10:02:00Z'),
    ctx('gpt-5.3-codex', '2026-07-10T10:03:00Z'),
    tcl(500, 250, 90, '2026-07-10T10:04:00Z'),
  ], s)
  assert.deepEqual(s.codex, { input: 500, cachedInput: 250, output: 90 })
  assert.deepEqual(s.codexByModel, {
    'gpt-5.1-codex-max': { input: 300, cachedInput: 200, output: 40 },
    'gpt-5.3-codex': { input: 200, cachedInput: 50, output: 50 },
  })
  assert.equal(s.codexModel, 'gpt-5.3-codex')
})

test('parseCodexLines: duplicate token_count contributes 0 (delta, not last_token_usage)', () => {
  const s = newFileState('codex')
  parseCodexLines([
    ctx('gpt-5.1-codex-max', '2026-07-10T10:00:00Z'),
    tcl(100, 10, 5, '2026-07-10T10:01:00Z'),
    tcl(100, 10, 5, '2026-07-10T10:02:00Z'), // duplicate: same cumulative total
    tcl(100, 10, 5, '2026-07-10T10:03:00Z'), // and another
  ], s)
  assert.deepEqual(s.codexByModel, { 'gpt-5.1-codex-max': { input: 100, cachedInput: 10, output: 5 } })
  assert.deepEqual(s.codex, { input: 100, cachedInput: 10, output: 5 })
})

test('parseCodexLines: split parse equals single parse (tail-parse identity)', () => {
  const lines = [
    ctx('gpt-5.1-codex-max', '2026-07-10T10:00:00Z'),
    tcl(100, 10, 5, '2026-07-10T10:01:00Z'),
    tcl(300, 200, 40, '2026-07-10T10:02:00Z'),
    ctx('gpt-5.3-codex', '2026-07-10T10:03:00Z'),
    tcl(500, 250, 90, '2026-07-10T10:04:00Z'),
  ]
  const whole = parseCodexLines(lines, newFileState('codex'))
  const split = newFileState('codex')
  parseCodexLines(lines.slice(0, 2), split)
  parseCodexLines(lines.slice(2), split)
  assert.deepEqual(split, whole)
})

test('parseCodexLines: token_count before any turn_context lands in "unknown"', () => {
  const s = newFileState('codex')
  parseCodexLines([
    tcl(100, 10, 5, '2026-07-10T10:01:00Z'),
    ctx('gpt-5.1-codex-max', '2026-07-10T10:02:00Z'),
    tcl(180, 30, 25, '2026-07-10T10:03:00Z'),
  ], s)
  assert.deepEqual(s.codexByModel, {
    unknown: { input: 100, cachedInput: 10, output: 5 },
    'gpt-5.1-codex-max': { input: 80, cachedInput: 20, output: 20 },
  })
})

test('parseCodexLines: decreasing cumulative (counter reset) keeps buckets conserved', () => {
  // Reviewer repro: a cumulative that goes DOWN (e.g. a mid-rollout context
  // reset/compaction) must not be absorbed by Math.max(0, delta) while
  // `state.codex` drops to the lower value — that leaves stale, too-high
  // totals stuck in the buckets. sum(byCodexModel[*]) must equal the final
  // `state.codex` unconditionally, in both directions.
  const s = newFileState('codex')
  parseCodexLines([
    ctx('gpt-5.4', '2026-07-10T10:00:00Z'),
    tcl(1000, 400, 100, '2026-07-10T10:01:00Z'),
    tcl(200, 50, 20, '2026-07-10T10:02:00Z'),
  ], s)
  assert.deepEqual(s.codex, { input: 200, cachedInput: 50, output: 20 })
  const sum = k => Object.values(s.codexByModel).reduce((n, b) => n + b[k], 0)
  assert.equal(sum('input'), s.codex.input)
  assert.equal(sum('cachedInput'), s.codex.cachedInput)
  assert.equal(sum('output'), s.codex.output)
  // The stale higher figures from before the reset must not linger.
  assert.deepEqual(s.codexByModel, { 'gpt-5.4': { input: 200, cachedInput: 50, output: 20 } })
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
import { updateUsage, aggregateUsage } from './usage.mjs'

const codexEntry = state => ({ tool: 'codex', state: { ...newFileState('codex'), cwd: '/p/a', ...state } })

test('aggregateUsage: legacy codex state without codexByModel falls into "unknown"', () => {
  // A cache written before Task 3: `codex` totals exist, `codexByModel` does not.
  // The conservation guard must attribute the whole total rather than dropping it.
  const legacy = { tool: 'codex', state: { tool: 'codex', cwd: '/p/a', models: {}, codex: { input: 900, cachedInput: 400, output: 70 }, firstTs: null, lastTs: null, prevTs: null, activeSeconds: 0, sessions: 1 } }
  const out = aggregateUsage({ files: { '/f/legacy.jsonl': legacy } }, ['/p/a'])
  const p = out.projects['/p/a']
  assert.deepEqual(p.byCodexModel.unknown, { input: 900, cachedInput: 400, output: 70, costUsd: 0 })
  assert.ok(p.unpricedModels.includes('unknown'))
  assert.equal(p.tokens.codexInput, 900)
})

test('aggregateUsage: byCodexModel sums equal the codex token totals; buckets priced per model', () => {
  const out = aggregateUsage({
    files: {
      '/f/a.jsonl': codexEntry({
        codex: { input: 500, cachedInput: 250, output: 90 },
        codexByModel: {
          'gpt-5.1-codex-max': { input: 300, cachedInput: 200, output: 40 },
          'gpt-5.3-codex': { input: 200, cachedInput: 50, output: 50 },
        },
      }),
    },
  }, ['/p/a'])
  const p = out.projects['/p/a']
  const sum = k => Object.values(p.byCodexModel).reduce((n, b) => n + b[k], 0)
  assert.equal(sum('input'), p.tokens.codexInput)
  assert.equal(sum('cachedInput'), p.tokens.codexCachedInput)
  assert.equal(sum('output'), p.tokens.codexOutput)
  // Both models are in the pricing snapshot → priced, and the per-bucket costs
  // roll up to the session's unverified cost.
  assert.ok(p.byCodexModel['gpt-5.1-codex-max'].costUsd > 0)
  assert.ok(p.byCodexModel['gpt-5.3-codex'].costUsd > 0)
  assert.equal(p.unpricedModels.length, 0)
  const bucketSum = Object.values(p.byCodexModel).reduce((n, b) => n + b.costUsd, 0)
  assert.ok(Math.abs(p.costUnverifiedUsd - bucketSum) < 1e-12)
  assert.ok(Math.abs(p.sessionList[0].costUsd - bucketSum) < 1e-12)
  // Dominant model by output tokens.
  assert.equal(p.sessionList[0].model, 'gpt-5.3-codex')
})

test('aggregateUsage: uncovered codex remainder is conserved into "unknown"', () => {
  const out = aggregateUsage({
    files: {
      '/f/a.jsonl': codexEntry({
        codex: { input: 500, cachedInput: 250, output: 90 },
        codexByModel: { 'gpt-5.1-codex-max': { input: 300, cachedInput: 200, output: 40 } },
      }),
    },
  }, ['/p/a'])
  const p = out.projects['/p/a']
  assert.deepEqual(p.byCodexModel.unknown, { input: 200, cachedInput: 50, output: 50, costUsd: 0 })
  const sum = k => Object.values(p.byCodexModel).reduce((n, b) => n + b[k], 0)
  assert.equal(sum('input'), p.tokens.codexInput)
  assert.equal(sum('output'), p.tokens.codexOutput)
})

test('aggregateUsage: the conservation guard does not mutate persisted ledger state', () => {
  const entry = codexEntry({
    codex: { input: 500, cachedInput: 250, output: 90 },
    codexByModel: { 'gpt-5.1-codex-max': { input: 300, cachedInput: 200, output: 40 } },
  })
  const before = JSON.stringify(entry.state)
  aggregateUsage({ files: { '/f/a.jsonl': entry } }, ['/p/a'])
  assert.equal(JSON.stringify(entry.state), before)
})

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
    // This fixture has no `turn_context`, so all its tokens land in the
    // "unknown" bucket (costForCodex('unknown') has no pricing entry) and the
    // session is correctly unpriced rather than mispriced, per the
    // "unpriced, never $0" rule Claude already had.
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
