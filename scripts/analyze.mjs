#!/usr/bin/env node
// CLI for AI project analysis over the projects JSONL.
// Usage:
//   node scripts/analyze.mjs                     # full incremental batch
//   node scripts/analyze.mjs --force             # re-analyze everything
//   node scripts/analyze.mjs --retry-errors      # re-analyze only errored records
//   node scripts/analyze.mjs --data <file>       # override DATA_FILE
//   node scripts/analyze.mjs --pilot <dir>...    # restrict to given projects
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// Analyze whatever ledger is live (the desktop app's app-data dir when it has
// one, else this repo's data/) — see src/lib/state-dir.mjs.
const { ledgerFile, envFile } = await import('../src/lib/state-dir.mjs')
config({ path: envFile({ base: REPO_ROOT }), debug: false })

const { ApfelError, execClosedStdin } = await import('../src/lib/analyzer.mjs')
const { runAnalysisBatch } = await import('../src/lib/analyze-batch.mjs')

// apfel waits for stdin EOF even with an argv prompt; the library's default exec
// (execClosedStdin) closes it so the child runs. Reuse it here for the preflight.
const exec = execClosedStdin

const DATA_FILE = ledgerFile({ base: REPO_ROOT })
const RESULTS_FILE = path.join(__dirname, '..', 'test', 'fixtures', 'pilot-results.json')
const BASE_DIR = process.env.BASE_DIR || path.join(os.homedir(), 'Projekty')

const args = process.argv.slice(2)
const force = args.includes('--force')
const retryErrors = args.includes('--retry-errors')
const dataIdx = args.indexOf('--data')
const dataFile = dataIdx !== -1 && args[dataIdx + 1]
  ? path.resolve(args[dataIdx + 1].replace(/^~/, os.homedir()))
  : DATA_FILE
const pilotIdx = args.indexOf('--pilot')
const only = pilotIdx !== -1
  ? args.slice(pilotIdx + 1).filter(a => !a.startsWith('--')).map(p => path.resolve(p.replace(/^~/, os.homedir())))
  : null
if (pilotIdx !== -1 && (!only || only.length === 0)) {
  console.error('Usage: node scripts/analyze.mjs [--force] [--retry-errors] [--data <file>] [--pilot <dir>...]')
  process.exit(2)
}

// Preflight: is the model reachable at all?
try {
  await exec('apfel', ['--model-info'], { timeout: 15000 })
} catch (err) {
  console.error('apfel unavailable — is it installed and Apple Intelligence enabled?', err.message)
  process.exit(5)
}

const onProgress = (e) => {
  if (e.type === 'status') console.log(e.message)
  else if (e.type === 'analyzed') console.log(`✓ [${e.current}/${e.total}] ${e.project_name} → ${e.detail}`)
  else if (e.type === 'analyze_error') console.log(`✗ [${e.current}/${e.total}] ${e.project_name}: ${e.detail}`)
  else if (e.type === 'skipped') process.stdout.write(`· [${e.current}/${e.total}] ${e.project_name} (cached)\r`)
}

let summary
try {
  summary = await runAnalysisBatch({ dataFile, baseDir: BASE_DIR, force, retryErrors, only, onProgress })
  console.log(`\nDone: ${summary.analyzed} analyzed, ${summary.skipped} cached, ${summary.errors} errors in ${Math.round(summary.durationMs / 1000)}s`)
} catch (err) {
  if (err instanceof ApfelError && err.kind === 'unavailable') {
    console.error('Model unavailable — aborting.'); process.exit(5)
  }
  throw err
}

// In pilot mode, read the analyzed records back out of the JSONL and write the
// fixture the gate comparisons consume.
if (only) {
  const set = new Set(only)
  const records = (await readFile(dataFile, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  const results = records
    .filter(r => set.has(r.directory))
    .map(r => ({ directory: r.directory, ai_analysis: r.ai_analysis, derived: r.ai_derived }))
  await mkdir(path.dirname(RESULTS_FILE), { recursive: true })
  await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2))
  console.log(`${results.length} result(s) → ${RESULTS_FILE}`)
}
