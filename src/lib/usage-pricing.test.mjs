import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchPrice, matchInTable, costForClaude, costForCodex, priceSource } from './usage-pricing.mjs'

test('matchPrice longest-prefix matches dated model ids', () => {
  assert.deepEqual(matchPrice('claude-haiku-4-5-20251001'), {
    in: 0.000001, cacheRead: 1e-7, out: 0.000005, cacheWrite5m: 0.00000125, cacheWrite1h: 0.000002,
  })
  assert.equal(matchPrice('gpt-9'), null)
})

test('matchInTable genuinely prefers the longer prefix key over a shorter one', () => {
  // The live snapshot has no 'gpt-5.1' key today (only 'gpt-5.1-codex-max'), so
  // testing against matchPrice alone would pass vacuously — there'd be only one
  // candidate key either way. Build a synthetic table with BOTH a short key and
  // a longer key that extends it, so the assertion actually exercises the
  // length-descending sort/ordering rather than a single-candidate lookup.
  const table = {
    'gpt-5.1': { in: 1e-6, cacheRead: 1e-7, out: 1e-5 },
    'gpt-5.1-codex-max': { in: 1.25e-6, cacheRead: 1.25e-7, out: 1e-5 },
  }
  assert.deepEqual(matchInTable(table, 'gpt-5.1-codex-max-preview'), table['gpt-5.1-codex-max'])
  // A shorter id that only the short key prefixes must still resolve to the short key.
  assert.deepEqual(matchInTable(table, 'gpt-5.1-mini'), table['gpt-5.1'])
  assert.equal(matchInTable(table, 'unrelated'), null)
})

test('costForClaude prices all four buckets', () => {
  // fable-5: 1M in = $10, 1M out = $50, 1M cacheRead = $1, 1M w5m = $12.5, 1M w1h = $20
  const c = costForClaude('claude-fable-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })
  assert.ok(Math.abs(c - 93.5) < 1e-9)
  assert.equal(costForClaude('unknown-model', { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), null)
})

test('costForClaude: claude-opus-4-8, 1M in + 1M out = $30.00 exactly', () => {
  const c = costForClaude('claude-opus-4-8', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
  assert.ok(Math.abs(c - 30) < 1e-9)
})

test('costForClaude: claude-haiku-4-5-20251001 matches claude-haiku-4-5 prefix', () => {
  const c = costForClaude('claude-haiku-4-5-20251001', { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
  assert.ok(Math.abs(c - 1) < 1e-9)
})

test('costForCodex: gpt-5.6-sol, 1M input (800k cached, 100k out) = $4.40', () => {
  // 0.2M non-cached in * $5/MTok + 0.8M cached in * $0.5/MTok + 0.1M out * $30/MTok
  const c = costForCodex({ input: 1e6, cachedInput: 800e3, output: 100e3 }, 'gpt-5.6-sol')
  assert.ok(Math.abs(c - 4.4) < 1e-9)
})

test('costForCodex returns null for an unknown model id (unpriced, never $0)', () => {
  assert.equal(costForCodex({ input: 2e6, cachedInput: 1e6, output: 1e6 }, 'unknown-codex-model'), null)
  assert.equal(costForCodex({ input: 2e6, cachedInput: 1e6, output: 1e6 }), null)
})

test('priceSource reports the snapshot freshness and model count', () => {
  const src = priceSource()
  assert.equal(typeof src.fetched, 'string')
  assert.equal(src.modelCount, 13)
})
