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
