import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchClaudePrice, costForClaude, costForCodex } from './usage-pricing.mjs'

test('matchClaudePrice longest-prefix matches dated model ids', () => {
  assert.deepEqual(matchClaudePrice('claude-haiku-4-5-20251001'), { inp: 1, out: 5 })
  assert.deepEqual(matchClaudePrice('claude-fable-5'), { inp: 10, out: 50 })
  assert.equal(matchClaudePrice('gpt-9'), null)
})

test('costForClaude prices all four buckets', () => {
  // fable-5: 1M in = $10, 1M out = $50, 1M cacheRead = $1, 1M w5m = $12.5, 1M w1h = $20
  const c = costForClaude('claude-fable-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })
  assert.ok(Math.abs(c - 93.5) < 1e-9)
  assert.equal(costForClaude('unknown-model', { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), null)
})

test('costForCodex subtracts cached from input', () => {
  // 2M input of which 1M cached: 1M*1.25 + 1M*0.125 + 1M out*10 = 11.375
  const c = costForCodex({ input: 2e6, cachedInput: 1e6, output: 1e6 })
  assert.ok(Math.abs(c - 11.375) < 1e-9)
})
