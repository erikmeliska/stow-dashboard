import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import {
  resolveStateDir,
  appStateDir,
  dataDir,
  dataFile,
  ledgerFile,
  envFile,
  STATE_DIR_ENV,
} from './state-dir.mjs'

const HOME = '/Users/tester'
const APP_DIR = path.join(HOME, 'Library', 'Application Support', 'StowDashboardDeno')
const APP_LEDGER = path.join(APP_DIR, 'data', 'projects_metadata.jsonl')
const REPO = '/repo'

// Every test injects env/exists/platform/home so nothing touches the real
// machine — these helpers keep that boilerplate to one line per case.
const mac = (over = {}) => ({ platform: 'darwin', home: HOME, env: {}, base: REPO, exists: () => false, ...over })
const seeded = (over = {}) => mac({ exists: p => p === APP_LEDGER, ...over })

test('appStateDir mirrors the Deno shell path on macOS', () => {
  assert.equal(appStateDir({ platform: 'darwin', home: HOME }), APP_DIR)
})

test('appStateDir is null off macOS — no desktop shell there', () => {
  assert.equal(appStateDir({ platform: 'linux', home: HOME }), null)
})

test('falls back to base when the app-data dir has no ledger', () => {
  assert.equal(resolveStateDir(mac()), REPO)
})

test('prefers the app-data dir once the desktop app has scanned there', () => {
  assert.equal(resolveStateDir(seeded()), APP_DIR)
})

test('an app-data dir without a ledger does not hijack a populated repo', () => {
  // Fresh install: the dir exists but holds no ledger yet.
  const exists = p => p === APP_DIR || p === path.join(APP_DIR, 'data')
  assert.equal(resolveStateDir(mac({ exists })), REPO)
})

test('STOW_STATE_DIR overrides the app-data dir', () => {
  const env = { [STATE_DIR_ENV]: '/custom/state' }
  assert.equal(resolveStateDir(seeded({ env })), '/custom/state')
})

test('STOW_STATE_DIR is resolved to an absolute path', () => {
  const env = { [STATE_DIR_ENV]: 'relative/state' }
  assert.equal(resolveStateDir(seeded({ env })), path.resolve('relative/state'))
})

test('a blank STOW_STATE_DIR is ignored, not treated as cwd', () => {
  const env = { [STATE_DIR_ENV]: '   ' }
  assert.equal(resolveStateDir(seeded({ env })), APP_DIR)
})

test('off macOS, base wins even with a lookalike app dir on disk', () => {
  assert.equal(resolveStateDir(mac({ platform: 'linux', exists: () => true })), REPO)
})

test('derived paths hang off the resolved state dir', () => {
  const opts = seeded()
  assert.equal(dataDir(opts), path.join(APP_DIR, 'data'))
  assert.equal(dataFile('usage.json', opts), path.join(APP_DIR, 'data', 'usage.json'))
  assert.equal(ledgerFile(opts), APP_LEDGER)
  assert.equal(envFile(opts), path.join(APP_DIR, '.env.local'))
})

test('derived paths follow the fallback base too', () => {
  const opts = mac()
  assert.equal(ledgerFile(opts), path.join(REPO, 'data', 'projects_metadata.jsonl'))
  assert.equal(envFile(opts), path.join(REPO, '.env.local'))
})
