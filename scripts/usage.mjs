#!/usr/bin/env node
// Manual AI-usage extraction over the real transcript stores.
//   node scripts/usage.mjs [--rebuild]
// Runs updateUsage against ~/.claude/projects + ~/.codex/sessions, maps sessions
// onto the scanned projects in data/projects_metadata.jsonl, and prints the top
// projects by list-price cost plus totals and timing.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateUsage, defaultUsagePaths } from '../src/lib/usage.mjs'
import { priceSource } from '../src/lib/usage-pricing.mjs'
import { ledgerFile } from '../src/lib/state-dir.mjs'

// Run against the live state dir, not cwd: the desktop app writes its ledger
// and usage.json to its app-data dir (see src/lib/state-dir.mjs), and pricing
// the wrong ledger would leave the app showing stale costs.
const STATE = { base: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }

async function readProjectDirs() {
  let text
  try { text = await readFile(ledgerFile(STATE), 'utf8') } catch { return [] }
  const dirs = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      if (typeof d.directory === 'string') dirs.push(d.directory)
    } catch { /* skip malformed line */ }
  }
  return dirs
}

const fmtUsd = v => v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
const fmtInt = n => Math.round(n).toLocaleString('en-US')

async function main() {
  const rebuild = process.argv.includes('--rebuild')
  const paths = defaultUsagePaths(STATE)
  const projectDirs = await readProjectDirs()

  const src = priceSource()
  console.log(`Parsing usage${rebuild ? ' (rebuild)' : ''} …`)
  console.log(`  claude: ${paths.claudeDir}`)
  console.log(`  codex:  ${paths.codexDir}`)
  console.log(`  projects: ${projectDirs.length}`)
  console.log(`  pricing: litellm @ ${src.fetched}, ${src.modelCount} models`)

  const r = await updateUsage({ ...paths, projectDirs, rebuild })
  const out = JSON.parse(await readFile(paths.outFile, 'utf8'))

  const rows = Object.entries(out.projects)
    .map(([dir, p]) => ({ dir, ...p, total: p.costUsd || 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)

  console.log('\nTop projects by list-price value:')
  console.log('  ' + 'COST'.padStart(9) + '  ' + 'SESS'.padStart(4) + '  ' + 'HOURS'.padStart(6) + '  PROJECT')
  for (const p of rows) {
    const mark = (p.unpricedModels || []).length > 0 ? '~' : ' '
    console.log(
      '  ' + (mark + fmtUsd(p.total)).padStart(9) +
      '  ' + String(p.sessions).padStart(4) +
      '  ' + (p.activeMinutes / 60).toFixed(1).padStart(6) +
      '  ' + path.basename(p.dir)
    )
  }

  const t = out.totals
  const hasUnpriced = Object.values(out.projects).some(p => (p.unpricedModels || []).length > 0)
    || (out.unmatched.unpricedModels || []).length > 0
  console.log('\nTotals (list-price value of consumption, NOT an invoice):')
  console.log(`  Total   ${hasUnpriced ? '~' : ''}${fmtUsd(t.costUsd)}   (in ${fmtInt(t.tokens.input + t.tokens.codexInput)} / out ${fmtInt(t.tokens.output + t.tokens.codexOutput)} tok)   ·  ${t.sessions} sessions  ·  ${(t.activeMinutes / 60).toFixed(1)} h`)
  console.log(`  Unmatched: ${out.unmatched.sessions} sessions · ${(out.unmatched.unpricedModels || []).length > 0 ? '~' : ''}${fmtUsd(out.unmatched.costUsd)}`)

  console.log(`\nParsed ${r.filesParsed} · skipped ${r.filesSkipped} · missing ${r.filesMissing} · ${r.durationMs} ms`)
  console.log(`Wrote ${paths.outFile}`)
}

main().catch(err => { console.error(err); process.exit(1) })
