import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHost } from './processes.mjs'

test('classifyHost recognizes Claude CLI', () => {
  assert.equal(classifyHost('node /usr/local/bin/claude'), 'claude')
  assert.equal(classifyHost('claude'), 'claude')
})

test('classifyHost recognizes dev servers and shells', () => {
  assert.equal(classifyHost('next dev -p 3089'), 'dev-server')
  assert.equal(classifyHost('-zsh'), 'terminal')
})

test('classifyHost falls back to process', () => {
  assert.equal(classifyHost('some-random-binary'), 'process')
})
