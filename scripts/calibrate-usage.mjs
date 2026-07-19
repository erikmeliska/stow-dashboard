#!/usr/bin/env node
// Cross-checks data/usage.json's list-price cost against ccusage — an
// independent third-party tool that derives the same figures from the same
// local Claude Code / Codex transcripts. Run by hand after `npm run
// pricing:sync` (or whenever the AI $ column looks off) to catch a silently
// moved price or a parser regression before it ships.
//
//   node scripts/calibrate-usage.mjs
//
// NOT a `node --test` test: it shells out to the `ccusage` binary, and
// CLAUDE.md forbids tests that require external tools. Read-only — it never
// writes data/usage.json or data/usage-cache.json and never rebuilds the
// ledger (no updateUsage call). If the ledger is missing this refuses to run
// rather than silently regenerating it; that's `npm run usage`'s job.
//
// Window alignment: usage.json aggregates per PROJECT with a flat
// `sessionList` (start/end timestamps per transcript file), not per day —
// there is no per-day breakdown on our side to compare against ccusage's
// daily buckets one-for-one. So this bounds ccusage's query to the calendar
// span covered by the ledger's own session timestamps (its min startedAt to
// max lastActivity) and compares AGGREGATE totals over that span — the
// tightest comparison the ledger's shape actually supports. The per-day
// table below is ccusage's own breakdown, printed for audit context, not a
// row-by-row diff against our side.
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataFile } from '../src/lib/state-dir.mjs'

const DRIFT_THRESHOLD_PCT = 5

// CLIs run with an arbitrary cwd, so pass the repo root as `base` — mirrors
// scripts/usage.mjs.
const STATE = { base: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }

// --- injectable exec (repo convention: see execClosedStdin in
// src/lib/analyzer.mjs) — a module-level default exec, and functions taking
// execImpl = exec so tests can supply a fake and never invoke ccusage. ---
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err) }
      else resolve({ stdout, stderr })
    })
  })
}
const exec = execFileAsync

export async function runCcusage(args, execImpl = exec) {
  const { stdout } = await execImpl('ccusage', args, {})
  return JSON.parse(stdout)
}

// --- pure logic (covered by scripts/calibrate-usage.test.mjs) --------------

// ccusage's --since/--until want YYYYMMDD, not usage.json's ISO timestamps.
function toYmd(iso) {
  return iso.slice(0, 10).replace(/-/g, '')
}

// The calendar span covered by the ledger's own sessions, across every
// project plus the unmatched bucket. Returns null when there are no sessions
// to calibrate against at all.
export function ledgerWindow(usage) {
  let min = null, max = null
  const accs = [...Object.values(usage.projects || {}), usage.unmatched].filter(Boolean)
  for (const acc of accs) {
    for (const s of acc.sessionList || []) {
      if (s.startedAt && (!min || s.startedAt < min)) min = s.startedAt
      if (s.lastActivity && (!max || s.lastActivity > max)) max = s.lastActivity
    }
  }
  if (!min || !max) return null
  return { since: toYmd(min), until: toYmd(max), sinceIso: min, untilIso: max }
}

// Sums `costUsd` out of every accumulator's per-model bucket — `byModel`
// (Claude) or `byCodexModel` (Codex). Reading the per-model breakdown rather
// than the top-level `costUsd` keeps this format-agnostic: older ledgers mix
// Claude+Codex into one `costUsd` and carry no `byCodexModel` at all, so
// summing per-model buckets is the only way to get a Claude-only or
// Codex-only figure regardless of which ledger version wrote the file.
// `sawBucket` tells the caller whether the bucket existed anywhere, so a
// legacy ledger's Codex figure (always 0) can be flagged as "not generated
// yet" instead of reported as a silent 100% drift.
export function sumLedgerCost(usage, bucketKey) {
  const accs = [...Object.values(usage.projects || {}), usage.unmatched].filter(Boolean)
  let cost = 0, sawBucket = false
  for (const acc of accs) {
    for (const m of Object.values(acc[bucketKey] || {})) {
      sawBucket = true
      cost += m.costUsd || 0
    }
  }
  return { cost, sawBucket }
}

// Percent drift of `ours` from `theirs` (ccusage is the reference). 0/0 is
// "no drift"; anything/0 is unbounded (report as a hard failure, not NaN).
export function driftPct(ours, theirs) {
  if (theirs === 0) return ours === 0 ? 0 : Infinity
  return Math.abs(ours - theirs) / theirs * 100
}

// Merges ccusage's `claude daily` and `codex daily` rows into one per-date
// table. Field names differ between the two commands (`totalCost` vs
// `costUSD`) — normalized here.
export function mergeDailyByDate(claudeDaily, codexDaily) {
  const byDate = new Map()
  for (const d of claudeDaily || []) {
    const e = byDate.get(d.date) ?? { date: d.date, claude: 0, codex: 0 }
    e.claude += d.totalCost || 0
    byDate.set(d.date, e)
  }
  for (const d of codexDaily || []) {
    const e = byDate.get(d.date) ?? { date: d.date, claude: 0, codex: 0 }
    e.codex += d.costUSD || 0
    byDate.set(d.date, e)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function formatTable(rows) {
  const fmt = v => `$${v.toFixed(2)}`.padStart(10)
  const lines = [
    '  DATE          CLAUDE $      CODEX $      TOTAL $',
    '  ' + '-'.repeat(50),
  ]
  for (const r of rows) {
    lines.push(`  ${r.date}  ${fmt(r.claude)}  ${fmt(r.codex)}  ${fmt(r.claude + r.codex)}`)
  }
  return lines.join('\n')
}

// --- orchestration -----------------------------------------------------

export async function main() {
  const outFile = dataFile('usage.json', STATE)
  let usage
  try {
    usage = JSON.parse(await readFile(outFile, 'utf8'))
  } catch (err) {
    console.error(`Cannot read ${outFile}: ${err.message}`)
    console.error('This script is read-only and never rebuilds the ledger — run `npm run usage` first.')
    process.exitCode = 1
    return
  }

  const window = ledgerWindow(usage)
  if (!window) {
    console.error(`${outFile} has no sessions to calibrate against.`)
    process.exitCode = 1
    return
  }

  console.log(`Ledger: ${outFile}`)
  console.log(`Window (from the ledger's own session timestamps): ${window.sinceIso} .. ${window.untilIso}`)
  console.log(`  ccusage queried with --since ${window.since} --until ${window.until} to match.`)

  let claudeDaily, codexDaily
  try {
    ;[claudeDaily, codexDaily] = await Promise.all([
      runCcusage(['claude', 'daily', '--json', '--since', window.since, '--until', window.until]),
      runCcusage(['codex', 'daily', '--json', '--since', window.since, '--until', window.until]),
    ])
  } catch (err) {
    console.error(`ccusage invocation failed: ${err.message}`)
    console.error('Is ccusage installed? (npm i -g ccusage)')
    process.exitCode = 1
    return
  }

  const rows = mergeDailyByDate(claudeDaily.daily, codexDaily.daily)
  console.log(`\nccusage per-day breakdown in the aligned window (${rows.length} active days; our ledger has no per-day breakdown to diff row-by-row — see the aggregate summary below):`)
  console.log(formatTable(rows))

  const ours = {
    claude: sumLedgerCost(usage, 'byModel'),
    codex: sumLedgerCost(usage, 'byCodexModel'),
  }
  const theirs = {
    claude: claudeDaily.totals?.totalCost || 0,
    codex: codexDaily.totals?.costUSD || 0,
  }

  const claudeDrift = driftPct(ours.claude.cost, theirs.claude)
  const codexDrift = driftPct(ours.codex.cost, theirs.codex)
  const totalOurs = ours.claude.cost + ours.codex.cost
  const totalTheirs = theirs.claude + theirs.codex
  const totalDrift = driftPct(totalOurs, totalTheirs)

  console.log('\nAggregate summary (whole aligned window):')
  console.log(`  Claude   ours $${ours.claude.cost.toFixed(2)}   vs ccusage $${theirs.claude.toFixed(2)}   -> ${claudeDrift.toFixed(1)}% drift`)
  console.log(`  Codex    ours $${ours.codex.cost.toFixed(2)}   vs ccusage $${theirs.codex.toFixed(2)}   -> ${codexDrift.toFixed(1)}% drift`)
  console.log(`  Total    ours $${totalOurs.toFixed(2)}   vs ccusage $${totalTheirs.toFixed(2)}   -> ${totalDrift.toFixed(1)}% drift`)

  if (!ours.codex.sawBucket) {
    console.log('\n  NOTE: no project in this ledger has a `byCodexModel` bucket — it predates')
    console.log('  per-model Codex attribution. The Codex drift above is not a meaningful')
    console.log('  calibration signal until you run `npm run usage -- --rebuild`.')
  }

  const worstDrift = Math.max(claudeDrift, codexDrift)
  if (worstDrift > DRIFT_THRESHOLD_PCT) {
    console.error(`\nFAIL: drift exceeds ${DRIFT_THRESHOLD_PCT}% (Claude ${claudeDrift.toFixed(1)}%, Codex ${codexDrift.toFixed(1)}%).`)
    process.exitCode = 1
    return
  }
  console.log(`\nOK: drift is within ${DRIFT_THRESHOLD_PCT}% (Claude ${claudeDrift.toFixed(1)}%, Codex ${codexDrift.toFixed(1)}%).`)
}

// Only run when executed directly (`node scripts/calibrate-usage.mjs`) — not
// when imported for its pure functions, e.g. by calibrate-usage.test.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
