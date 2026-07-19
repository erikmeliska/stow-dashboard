import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ledgerWindow,
  sumLedgerCost,
  driftPct,
  mergeDailyByDate,
  formatTable,
  runCcusage,
} from './calibrate-usage.mjs'

// All of these exercise pure logic only. runCcusage is tested with a fake
// execImpl so this file never shells out to the real `ccusage` binary —
// CLAUDE.md forbids `node --test` tests that require external tools.

test('ledgerWindow spans the min startedAt / max lastActivity across projects and unmatched', () => {
  const usage = {
    projects: {
      a: { sessionList: [{ startedAt: '2026-01-05T00:00:00.000Z', lastActivity: '2026-01-05T01:00:00.000Z' }] },
      b: { sessionList: [{ startedAt: '2026-03-01T00:00:00.000Z', lastActivity: '2026-03-02T00:00:00.000Z' }] },
    },
    unmatched: { sessionList: [{ startedAt: '2025-12-25T00:00:00.000Z', lastActivity: '2025-12-25T00:30:00.000Z' }] },
  }
  assert.deepEqual(ledgerWindow(usage), {
    since: '20251225',
    until: '20260302',
    sinceIso: '2025-12-25T00:00:00.000Z',
    untilIso: '2026-03-02T00:00:00.000Z',
  })
})

test('ledgerWindow returns null when there are no sessions anywhere', () => {
  assert.equal(ledgerWindow({ projects: {}, unmatched: { sessionList: [] } }), null)
})

test('sumLedgerCost sums costUsd out of the named bucket across projects and unmatched', () => {
  const usage = {
    projects: {
      a: { byModel: { 'claude-opus-4-8': { costUsd: 10 }, 'claude-fable-5': { costUsd: 5 } } },
      b: { byModel: { 'claude-opus-4-8': { costUsd: 2.5 } } },
    },
    unmatched: { byModel: { 'claude-fable-5': { costUsd: 1 } } },
  }
  assert.deepEqual(sumLedgerCost(usage, 'byModel'), { cost: 18.5, sawBucket: true })
})

test('sumLedgerCost reports sawBucket:false when no project has the bucket at all (legacy ledger)', () => {
  const usage = {
    projects: { a: { byModel: { 'claude-opus-4-8': { costUsd: 10 } } } },
    unmatched: { byModel: {} },
  }
  assert.deepEqual(sumLedgerCost(usage, 'byCodexModel'), { cost: 0, sawBucket: false })
})

test('driftPct is the absolute percent difference relative to the reference (theirs)', () => {
  assert.equal(driftPct(103, 100), 3)
  assert.equal(driftPct(97, 100), 3)
  assert.equal(driftPct(100, 100), 0)
})

test('driftPct treats 0 vs 0 as no drift, and anything vs 0 as unbounded', () => {
  assert.equal(driftPct(0, 0), 0)
  assert.equal(driftPct(50, 0), Infinity)
})

test('mergeDailyByDate normalizes claude daily (totalCost) and codex daily (costUSD) onto shared date rows', () => {
  const claudeDaily = [
    { date: '2026-01-01', totalCost: 10 },
    { date: '2026-01-02', totalCost: 20 },
  ]
  const codexDaily = [
    { date: '2026-01-01', costUSD: 1 },
    { date: '2026-01-03', costUSD: 2 },
  ]
  assert.deepEqual(mergeDailyByDate(claudeDaily, codexDaily), [
    { date: '2026-01-01', claude: 10, codex: 1 },
    { date: '2026-01-02', claude: 20, codex: 0 },
    { date: '2026-01-03', claude: 0, codex: 2 },
  ])
})

test('mergeDailyByDate handles empty/missing inputs', () => {
  assert.deepEqual(mergeDailyByDate([], []), [])
  assert.deepEqual(mergeDailyByDate(undefined, undefined), [])
})

test('formatTable renders one row per date with a header and separator', () => {
  const out = formatTable([{ date: '2026-01-01', claude: 10, codex: 1.5 }])
  const lines = out.split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /DATE.*CLAUDE.*CODEX.*TOTAL/)
  assert.match(lines[2], /2026-01-01/)
  assert.match(lines[2], /\$10\.00/)
  assert.match(lines[2], /\$1\.50/)
  assert.match(lines[2], /\$11\.50/)
})

test('runCcusage shells out via the injectable exec and parses its JSON stdout', async () => {
  const calls = []
  const fakeExec = async (cmd, args) => {
    calls.push([cmd, args])
    return { stdout: JSON.stringify({ daily: [], totals: { totalCost: 0 } }), stderr: '' }
  }
  const result = await runCcusage(['claude', 'daily', '--json'], fakeExec)
  assert.deepEqual(result, { daily: [], totals: { totalCost: 0 } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ccusage')
  assert.deepEqual(calls[0][1], ['claude', 'daily', '--json'])
})

test('runCcusage propagates exec failures instead of swallowing them', async () => {
  const fakeExec = async () => { throw new Error('ccusage: command not found') }
  await assert.rejects(() => runCcusage(['codex', 'daily', '--json'], fakeExec), /command not found/)
})
