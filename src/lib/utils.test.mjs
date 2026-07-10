import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docScoreColor, formatUsd } from './utils.js'

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
