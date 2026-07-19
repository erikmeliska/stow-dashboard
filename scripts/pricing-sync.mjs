#!/usr/bin/env node
// Refreshes src/lib/pricing-data.json from LiteLLM's community-maintained price
// table. That table is the single source of truth for what a token actually
// costs — our own tables have drifted (Codex ~2.77x off, claude-sonnet-5 ~33%
// off) because they were hand-maintained. This script re-derives the vendored
// snapshot and prints an old-vs-new diff so a price move is visible in review.
//   node scripts/pricing-sync.mjs   (or: npm run pricing:sync)
import { writeFile, rename, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Seed list — the model ids this dashboard actually bills against (Claude
// Code + Codex transcripts). Bare ids only: LiteLLM also carries vendor-
// prefixed aliases (azure/…, bedrock_mantle/…, vertex_ai/…) and, on the same
// entry, `_flex`/`_priority`/`_batches`/`_above_272k(_tokens)` rate variants —
// both are deliberately ignored, we only read the plain per-token fields below.
export const WANTED = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.1-codex-max',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const OUT_FILE = path.join(__dirname, '..', 'src', 'lib', 'pricing-data.json')

// Same shape as usage.mjs's atomicWriteJson (not imported: this script is a
// standalone CLI and shouldn't pull in usage.mjs's fs/state-dir machinery).
async function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await rename(tmp, file)
}

// Normalises one LiteLLM entry to our per-token shape. Returns null when the
// required in/out fields are absent (caller reports the id as missing).
export function mapEntry(entry) {
  if (!entry || typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') {
    return null
  }
  const mapped = {
    in: entry.input_cost_per_token,
    cacheRead: typeof entry.cache_read_input_token_cost === 'number' ? entry.cache_read_input_token_cost : 0,
    out: entry.output_cost_per_token,
  }
  if (typeof entry.cache_creation_input_token_cost === 'number') {
    mapped.cacheWrite5m = entry.cache_creation_input_token_cost
  }
  if (typeof entry.cache_creation_input_token_cost_above_1hr === 'number') {
    mapped.cacheWrite1h = entry.cache_creation_input_token_cost_above_1hr
  }
  return mapped
}

// Fetches LiteLLM's price table and builds the vendored snapshot. `fetchImpl`
// is injectable so tests never need the network.
export async function buildSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const res = await fetchImpl(LITELLM_URL)
  if (!res.ok) throw new Error(`LiteLLM fetch failed: HTTP ${res.status} ${res.statusText}`)
  const data = await res.json()

  const models = {}
  const missing = []
  for (const id of WANTED) {
    const mapped = mapEntry(data[id])
    if (!mapped) {
      missing.push(id)
      continue
    }
    models[id] = mapped
  }

  const snapshot = {
    _source: 'litellm model_prices_and_context_window.json',
    _fetched: now().toISOString().slice(0, 10),
    models,
  }
  return { snapshot, missing }
}

// Old-vs-new per-model diff, keyed off both snapshots' `models` maps.
export function diffReport(oldSnapshot, snapshot, missing) {
  const oldModels = oldSnapshot?.models ?? {}
  const lines = []
  const ids = Object.keys(snapshot.models).sort()
  for (const id of ids) {
    const oldM = oldModels[id]
    const newM = snapshot.models[id]
    if (!oldM) {
      lines.push(`  + ${id}: NEW ${JSON.stringify(newM)}`)
      continue
    }
    const keys = new Set([...Object.keys(oldM), ...Object.keys(newM)])
    const changes = []
    for (const k of keys) {
      if (oldM[k] !== newM[k]) changes.push(`${k}: ${oldM[k] ?? '(none)'} -> ${newM[k] ?? '(none)'}`)
    }
    lines.push(changes.length ? `  ~ ${id}: ${changes.join(', ')}` : `  = ${id}: unchanged`)
  }
  for (const id of Object.keys(oldModels).sort()) {
    if (!snapshot.models[id]) lines.push(`  - ${id}: REMOVED (was ${JSON.stringify(oldModels[id])})`)
  }
  if (missing.length) {
    lines.push(`\nMISSING from LiteLLM (not written, needs a human look): ${missing.join(', ')}`)
  }
  return lines.join('\n')
}

async function readOldSnapshot(outFile) {
  try {
    return JSON.parse(await readFile(outFile, 'utf8'))
  } catch {
    return null
  }
}

export async function main({ fetchImpl = fetch, now = () => new Date(), outFile = OUT_FILE, readSnapshot = readOldSnapshot, writeJson = atomicWriteJson } = {}) {
  const oldSnapshot = await readSnapshot(outFile)
  const { snapshot, missing } = await buildSnapshot({ fetchImpl, now })

  console.log(`Fetched ${LITELLM_URL}`)
  console.log(`Models found: ${Object.keys(snapshot.models).length}/${WANTED.length} WANTED ids\n`)
  console.log('Diff report:')
  console.log(diffReport(oldSnapshot, snapshot, missing))

  if (missing.length) {
    console.log(`\nRefusal: snapshot was NOT written — ${missing.length} WANTED id(s) missing from LiteLLM.`)
    process.exitCode = 1
    return
  }

  await writeJson(outFile, snapshot)
  console.log(`\nWrote ${outFile}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
}
