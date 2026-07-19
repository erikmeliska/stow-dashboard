import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docScoreColor, formatUsd, formatUsdWithUnpriced } from './utils.js'

test('docScoreColor: 70 and above → green', () => {
  assert.equal(docScoreColor(70), 'green')
  assert.equal(docScoreColor(100), 'green')
})

test('docScoreColor: 40 to 69 → amber', () => {
  assert.equal(docScoreColor(40), 'amber')
  assert.equal(docScoreColor(69), 'amber')
})

test('docScoreColor: below 40 → red', () => {
  assert.equal(docScoreColor(39), 'red')
  assert.equal(docScoreColor(0), 'red')
})

test('formatUsd: null or undefined → em dash', () => {
  assert.equal(formatUsd(null), '—')
  assert.equal(formatUsd(undefined), '—')
})

test('formatUsd: exactly 0 → $0', () => {
  assert.equal(formatUsd(0), '$0')
})

test('formatUsd: 0 < v < 0.01 → <1¢', () => {
  assert.equal(formatUsd(0.004), '<1¢')
  assert.equal(formatUsd(0.009), '<1¢')
})

test('formatUsd: v >= 100 rounds to integer', () => {
  assert.equal(formatUsd(100), '$100')
  assert.equal(formatUsd(670.0979990000002), '$670')
})

test('formatUsd: 0.01 <= v < 100 → two decimals', () => {
  assert.equal(formatUsd(0.01), '$0.01')
  assert.equal(formatUsd(12.5), '$12.50')
  assert.equal(formatUsd(99.999), '$100.00')
})

// "unpriced, never $0": an aggregate total of exactly $0 caused by unpriced
// models must never render as a bare dollar figure that reads as free.
test('formatUsdWithUnpriced: zero total with unpriced models → "unpriced", not "~$0"', () => {
  assert.equal(formatUsdWithUnpriced(0, true), 'unpriced')
})

test('formatUsdWithUnpriced: zero total with no unpriced models → plain "$0"', () => {
  assert.equal(formatUsdWithUnpriced(0, false), '$0')
})

test('formatUsdWithUnpriced: nonzero total with unpriced models → "~" prefix kept (real partial figure)', () => {
  assert.equal(formatUsdWithUnpriced(12.5, true), '~$12.50')
})

test('formatUsdWithUnpriced: nonzero total with no unpriced models → no prefix', () => {
  assert.equal(formatUsdWithUnpriced(12.5, false), '$12.50')
})

test('formatUsdWithUnpriced: null/undefined total with unpriced models → treated as zero → "unpriced"', () => {
  assert.equal(formatUsdWithUnpriced(null, true), 'unpriced')
  assert.equal(formatUsdWithUnpriced(undefined, true), 'unpriced')
})
