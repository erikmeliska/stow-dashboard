#!/usr/bin/env node
// Move a project folder on disk and migrate every link to it (#11).
//   npm run relocate -- --from <dir> --to <dir>            dry-run (default): prints the plan
//   npm run relocate -- --from <dir> --to <dir> --apply    runs it (journal + rollback on failure)
//   npm run relocate -- ... --force                        allow uncommitted changes
//   npm run relocate -- --resume <journal>                 roll back a crashed/failed run
// Exit codes: 0 ok, 2 blocked plan, 1 failed run.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planRelocation, executeRelocation, resumeRelocation, defaultRelocateDeps } from '../src/lib/relocate.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const out = { from: null, to: null, apply: false, force: false, resume: null }
  const value = (i, flag) => {
    const v = argv[i]
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = value(++i, a)
    else if (a === '--to') out.to = value(++i, a)
    else if (a === '--resume') out.resume = value(++i, a)
    else if (a === '--apply') out.apply = true
    else if (a === '--force') out.force = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (out.resume) return out
  if (!out.from) throw new Error('--from <dir> is required')
  if (!out.to) throw new Error('--to <dir> is required')
  return out
}

export function formatPlan(plan) {
  const lines = [`${plan.ok ? 'Plan (dry-run)' : 'BLOCKED'}: ${plan.from} → ${plan.to}`]
  if (plan.blockers.length) { lines.push('', 'Blockers:'); for (const b of plan.blockers) lines.push(`  ✗ ${b}`) }
  if (plan.warnings.length) { lines.push('', 'Warnings:'); for (const w of plan.warnings) lines.push(`  ! ${w}`) }
  lines.push('', 'Steps:')
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.description}`))
  return lines.join('\n')
}

export function formatResult(res) {
  if (res.ok) return `Moved (${(res.done || []).join(', ')}). Journal: ${res.journal}`
  const head = `Failed at ${res.failed?.kind}: ${res.failed?.error}`
  if (!res.journal) return head
  return res.rolledBack
    ? `${head}\nEverything was rolled back. Journal: ${res.journal}`
    : `${head}\nRollback did not finish — manual fix needed, then: npm run relocate -- --resume ${res.journal}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const deps = await defaultRelocateDeps({ base: REPO })
  if (args.resume) {
    const r = await resumeRelocation(path.resolve(args.resume), deps)
    console.log(r.rolledBack ? `Rolled back (${r.undone.join(', ')}). Journal: ${r.journal}` : `Not rolled back: ${r.error ?? 'see journal'} (${r.journal})`)
    process.exit(r.rolledBack ? 0 : 1)
  }
  const plan = await planRelocation({ from: args.from, to: args.to, force: args.force }, deps)
  console.log(formatPlan(plan))
  if (!plan.ok) process.exit(2)
  if (!args.apply) { console.log('\nNothing changed. Re-run with --apply to move.'); return }
  console.log('')
  const res = await executeRelocation({ from: plan.from, to: plan.to, planHash: plan.planHash, force: args.force }, deps)
  console.log(formatResult(res))
  process.exit(res.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
