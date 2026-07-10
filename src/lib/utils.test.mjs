import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docScoreColor } from './utils.js'

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
