import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeInput, codexInput, geminiInput, usageTokenTotals, fmtTokens, fmtInputBreakdown } from './usage-tokens.mjs'

test('claudeInput: total = uncached + cache read + both cache-write tiers', () => {
  // Issue #1 shape: tiny uncached `input`, the bulk is cache read/write.
  const b = claudeInput({ input: 460e3, output: 4.2e6, cacheRead: 1052e6, cacheWrite5m: 20e6, cacheWrite1h: 3.5e6 })
  assert.deepEqual(b, { uncached: 460e3, cacheRead: 1052e6, cacheWrite: 23.5e6, total: 460e3 + 1052e6 + 23.5e6 })
})

test('codexInput: input already includes cachedInput — not counted twice', () => {
  assert.deepEqual(codexInput({ input: 1000, cachedInput: 800, output: 50 }),
    { uncached: 200, cacheRead: 800, cacheWrite: 0, total: 1000 })
  // A cached figure above input (never seen, but must not go negative).
  assert.equal(codexInput({ input: 100, cachedInput: 150 }).uncached, 0)
})

test('geminiInput: input (proto field 2) excludes cachedInput (field 5)', () => {
  assert.deepEqual(geminiInput({ input: 2.8e6, cachedInput: 56.8e6 }),
    { uncached: 2.8e6, cacheRead: 56.8e6, cacheWrite: 0, total: 59.6e6 })
})

test('usageTokenTotals: one definition summed across Claude, Codex and Gemini', () => {
  const { input, output } = usageTokenTotals({
    input: 10, output: 1, cacheRead: 1000, cacheWrite5m: 100, cacheWrite1h: 50,
    codexInput: 500, codexCachedInput: 400, codexOutput: 2,
    geminiInput: 30, geminiCachedInput: 300, geminiOutput: 3, geminiThinking: 99,
  })
  assert.deepEqual(input, {
    uncached: 10 + 100 + 30,
    cacheRead: 1000 + 400 + 300,
    cacheWrite: 150,
    total: (10 + 1000 + 150) + 500 + (30 + 300),
  })
  assert.equal(output, 6)
})

test('usageTokenTotals: missing/legacy fields count as 0', () => {
  assert.deepEqual(usageTokenTotals({}), { input: { uncached: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, output: 0 })
  assert.deepEqual(usageTokenTotals(undefined).input.total, 0)
})

test('fmtTokens / fmtInputBreakdown', () => {
  assert.equal(fmtTokens(1.08e9), '1.08B')
  assert.equal(fmtTokens(4.2e6), '4.2M')
  assert.equal(fmtTokens(460e3), '460k')
  assert.equal(fmtTokens(12), '12')
  assert.equal(fmtTokens(undefined), '0')
  assert.equal(fmtInputBreakdown(claudeInput({ input: 460e3, cacheRead: 1052e6, cacheWrite5m: 23.5e6 })),
    '1.08B (uncached 460k · cacheR 1.05B · cacheW 23.5M)')
})
