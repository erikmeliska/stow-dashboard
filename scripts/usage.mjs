#!/usr/bin/env node
// Manual AI-usage extraction over the real transcript stores.
//   node scripts/usage.mjs [--rebuild]
// Runs updateUsage against ~/.claude/projects + ~/.codex/sessions, maps sessions
// onto the scanned projects in data/projects_metadata.jsonl, and prints the top
// projects by list-price cost plus totals and timing.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { updateUsage, defaultUsagePaths } from '../src/lib/usage.mjs'

async function readProjectDirs() {
  const file = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')
  let text
  try { text = await readFile(file, 'utf8') } catch { return [] }
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
  const paths = defaultUsagePaths()
  const projectDirs = await readProjectDirs()

  console.log(`Parsing usage${rebuild ? ' (rebuild)' : ''} …`)
  console.log(`  claude: ${paths.claudeDir}`)
  console.log(`  codex:  ${paths.codexDir}`)
  console.log(`  projects: ${projectDirs.length}`)

  const r = await updateUsage({ ...paths, projectDirs, rebuild })
  const out = JSON.parse(await readFile(paths.outFile, 'utf8'))

  const rows = Object.entries(out.projects)
    .map(([dir, p]) => ({ dir, ...p, total: (p.costUsd || 0) + (p.costUnverifiedUsd || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)

  console.log('\nTop projects by list-price value:')
  console.log('  ' + 'COST'.padStart(9) + '  ' + 'SESS'.padStart(4) + '  ' + 'HOURS'.padStart(6) + '  PROJECT')
  for (const p of rows) {
    const mark = p.costUsd === 0 && p.costUnverifiedUsd > 0 ? '~' : ' '
    console.log(
      '  ' + (mark + fmtUsd(p.total)).padStart(9) +
      '  ' + String(p.sessions).padStart(4) +
      '  ' + (p.activeMinutes / 60).toFixed(1).padStart(6) +
      '  ' + path.basename(p.dir)
    )
  }

  const t = out.totals
  console.log('\nTotals (list-price value of consumption, NOT an invoice):')
  console.log(`  Claude  ${fmtUsd(t.costUsd)}   (in ${fmtInt(t.tokens.input)} / out ${fmtInt(t.tokens.output)} tok)`)
  console.log(`  Codex   ~${fmtUsd(t.costUnverifiedUsd)}  ⚠️ estimated rates  (in ${fmtInt(t.tokens.codexInput)} / out ${fmtInt(t.tokens.codexOutput)} tok)`)
  console.log(`  Combined ${fmtUsd(t.costUsd + t.costUnverifiedUsd)}   ·  ${t.sessions} sessions  ·  ${(t.activeMinutes / 60).toFixed(1)} h`)
  console.log(`  Unmatched: ${out.unmatched.sessions} sessions · ${fmtUsd(out.unmatched.costUsd)} + ~${fmtUsd(out.unmatched.costUnverifiedUsd)}`)

  console.log(`\nParsed ${r.filesParsed} · skipped ${r.filesSkipped} · missing ${r.filesMissing} · ${r.durationMs} ms`)
  console.log(`Wrote ${paths.outFile}`)
}

main().catch(err => { console.error(err); process.exit(1) })
