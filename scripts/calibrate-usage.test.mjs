import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ledgerWindow,
  sumLedgerCost,
  driftPct,
  ghostCostByTool,
  mergeDailyByDate,
  formatTable,
  runCcusage,
  ccusageVersion,
  main,
} from './calibrate-usage.mjs'

// All of these exercise pure logic only. runCcusage/ccusageVersion are
// tested with a fake execImpl, and main()'s integration tests inject that
// same fake execImpl plus temp-dir ledger files, so this file never shells
// out to the real `ccusage` binary and never reads this machine's real
// usage.json — CLAUDE.md forbids `node --test` tests that require external
// tools.

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

test('ccusageVersion shells out via the injectable exec and trims stdout', async () => {
  const calls = []
  const fakeExec = async (cmd, args) => {
    calls.push([cmd, args])
    return { stdout: '19.0.3\n', stderr: '' }
  }
  assert.equal(await ccusageVersion(fakeExec), '19.0.3')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['ccusage', ['--version']])
})

test('ghostCostByTool sums per-tool cost split into ghost (transcript deleted) vs total', () => {
  const usage = {
    projects: {
      a: {
        sessionList: [
          { tool: 'claude', file: 'live.jsonl', costUsd: 10 },
          { tool: 'claude', file: 'gone.jsonl', costUsd: 4 },
          { tool: 'codex', file: 'gone-codex.jsonl', costUsd: 2 },
        ],
      },
    },
    unmatched: {
      sessionList: [
        { tool: 'codex', file: 'live-codex.jsonl', costUsd: 3 },
      ],
    },
  }
  const cacheFiles = {
    '/home/u/.claude/projects/a/live.jsonl': { tool: 'claude', missing: false },
    '/home/u/.claude/projects/a/gone.jsonl': { tool: 'claude', missing: true },
    '/home/u/.codex/sessions/gone-codex.jsonl': { tool: 'codex', missing: true },
    '/home/u/.codex/sessions/live-codex.jsonl': { tool: 'codex', missing: false },
  }
  assert.deepEqual(ghostCostByTool(usage, cacheFiles), {
    ghost: { claude: 4, codex: 2 },
    total: { claude: 14, codex: 5 },
  })
})

test('ghostCostByTool treats a missing usage-cache (no matching key) as all-live', () => {
  const usage = { projects: { a: { sessionList: [{ tool: 'claude', file: 'x.jsonl', costUsd: 7 }] } }, unmatched: { sessionList: [] } }
  assert.deepEqual(ghostCostByTool(usage, {}), { ghost: { claude: 0, codex: 0 }, total: { claude: 7, codex: 0 } })
})

// --- main() integration: exercises the injectable execImpl/outFile/cacheFile
// seam end-to-end (repo convention, src/lib/analyzer.mjs:164-206). Never
// touches the real `ccusage` binary or this machine's real usage.json —
// every fixture lives under a temp dir made with mkdtemp, cleaned up after.

function fakeCcusageExec({ claudeTotal, codexTotal }) {
  return async (cmd, args) => {
    assert.equal(cmd, 'ccusage')
    if (args[0] === '--version') return { stdout: '19.0.3\n', stderr: '' }
    if (args[0] === 'claude') {
      assert.ok(args.includes('--offline'), 'claude daily must be queried with --offline')
      return { stdout: JSON.stringify({ daily: [], totals: { totalCost: claudeTotal } }), stderr: '' }
    }
    if (args[0] === 'codex') {
      assert.ok(args.includes('--offline'), 'codex daily must be queried with --offline')
      return { stdout: JSON.stringify({ daily: [], totals: { costUSD: codexTotal } }), stderr: '' }
    }
    throw new Error(`unexpected ccusage invocation: ${args.join(' ')}`)
  }
}

async function withTempLedger(usage, testFn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'calibrate-usage-test-'))
  const outFile = path.join(dir, 'usage.json')
  const cacheFile = path.join(dir, 'usage-cache.json') // deliberately never written: "cache missing" is the common case in these tests
  await writeFile(outFile, JSON.stringify(usage))
  try {
    await testFn({ outFile, cacheFile })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Captures console.log/console.error output and process.exitCode around a
// main() call, then restores both — main() sets process.exitCode as its
// pass/fail signal, and letting that leak out of a passing test would flip
// the whole `npm test` run's exit code even though every assertion passed.
async function runMain(opts) {
  const savedExitCode = process.exitCode
  const savedLog = console.log, savedErr = console.error
  const lines = []
  console.log = (...a) => lines.push(a.join(' '))
  console.error = (...a) => lines.push(a.join(' '))
  process.exitCode = undefined
  try {
    await main(opts)
    return { exitCode: process.exitCode, output: lines.join('\n') }
  } finally {
    console.log = savedLog
    console.error = savedErr
    process.exitCode = savedExitCode
  }
}

const sessionAt = (tool, file, costUsd, day) => ({
  tool, file, costUsd,
  startedAt: `${day}T00:00:00.000Z`,
  lastActivity: `${day}T01:00:00.000Z`,
})

test('main() excludes Codex from the pass/fail gate when the ledger predates per-model Codex attribution', async () => {
  // Codex bucket is entirely absent (sawBucket:false) — its "drift" would be
  // a meaningless 100% (0 vs ccusage's non-zero codex total) if it were
  // gated. Claude matches ccusage exactly (0% drift), so the run must PASS.
  const usage = {
    projects: {
      '/proj/a': {
        byModel: { 'claude-x': { costUsd: 10 } },
        byCodexModel: {},
        sessionList: [sessionAt('claude', 'a1.jsonl', 10, '2026-01-01')],
      },
    },
    unmatched: { byModel: {}, byCodexModel: {}, sessionList: [] },
  }
  await withTempLedger(usage, async ({ outFile, cacheFile }) => {
    const execImpl = fakeCcusageExec({ claudeTotal: 10, codexTotal: 500 })
    const { exitCode, output } = await runMain({ execImpl, outFile, cacheFile })
    assert.equal(exitCode, undefined, `expected exit 0, got exitCode=${exitCode}; output:\n${output}`)
    assert.match(output, /EXCLUDED from the pass\/fail gate/)
    assert.match(output, /OK: drift is within/)
    assert.match(output, /Codex excluded/)
  })
})

test('main() still fails on Claude drift alone even with Codex excluded from the gate (threshold not tuned away)', async () => {
  const usage = {
    projects: {
      '/proj/a': {
        byModel: { 'claude-x': { costUsd: 100 } },
        byCodexModel: {},
        sessionList: [sessionAt('claude', 'a1.jsonl', 100, '2026-01-01')],
      },
    },
    unmatched: { byModel: {}, byCodexModel: {}, sessionList: [] },
  }
  await withTempLedger(usage, async ({ outFile, cacheFile }) => {
    // ccusage says $10, our ledger says $100 -> 900% drift, way past 5%.
    const execImpl = fakeCcusageExec({ claudeTotal: 10, codexTotal: 0 })
    const { exitCode, output } = await runMain({ execImpl, outFile, cacheFile })
    assert.equal(exitCode, 1, `expected exit 1, got exitCode=${exitCode}; output:\n${output}`)
    assert.match(output, /FAIL: drift exceeds/)
  })
})

test('main() gates on Codex drift when the ledger DOES have per-model Codex attribution', async () => {
  const usage = {
    projects: {
      '/proj/a': {
        byModel: { 'claude-x': { costUsd: 10 } },
        byCodexModel: { 'codex-x': { costUsd: 10 } },
        sessionList: [
          sessionAt('claude', 'a1.jsonl', 10, '2026-01-01'),
          sessionAt('codex', 'a2.jsonl', 10, '2026-01-01'),
        ],
      },
    },
    unmatched: { byModel: {}, byCodexModel: {}, sessionList: [] },
  }
  await withTempLedger(usage, async ({ outFile, cacheFile }) => {
    // Claude matches exactly; Codex ledger says $10 but ccusage says $1 -> huge drift, and this time it's real (sawBucket:true) so it must gate.
    const execImpl = fakeCcusageExec({ claudeTotal: 10, codexTotal: 1 })
    const { exitCode, output } = await runMain({ execImpl, outFile, cacheFile })
    assert.equal(exitCode, 1, `expected exit 1, got exitCode=${exitCode}; output:\n${output}`)
    assert.match(output, /FAIL: drift exceeds/)
    assert.doesNotMatch(output, /EXCLUDED from the pass\/fail gate/)
  })
})
