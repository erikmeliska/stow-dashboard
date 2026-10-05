#!/usr/bin/env node
// Read-only summary of the virtual-project register (#8).
//   node scripts/registry.mjs [--multi] [--unassigned] [--json]
// Reads the live ledger + data/registry.json + each checkout's .stow/project.json;
// writes nothing.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/lib/registry/registry.mjs'

const STATE = { base: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }
const args = new Set(process.argv.slice(2))

const reg = await loadRegistry(STATE)
if (args.has('--json')) {
  process.stdout.write(JSON.stringify(reg, null, 2) + '\n')
} else {
  const s = reg.stats
  console.log(`${s.records} ledger rows → ${s.projects} projects (${s.multi_location} with several checkouts, ${s.locations_in_multi} checkouts in them)`)
  console.log(`identity: ${Object.entries(s.by_kind).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  console.log(`client source: ${Object.entries(s.by_client_source).map(([k, n]) => `${k} ${n}`).join(', ')}, unassigned ${s.unassigned}`)
  console.log('\nclients:')
  for (const c of reg.clients) console.log(`  ${c.name.padEnd(28)} ${c.projects.length}`)
  if (args.has('--multi')) {
    console.log('\nprojects with several checkouts:')
    for (const p of reg.projects.filter(p => p.locations.length > 1).sort((a, b) => b.locations.length - a.locations.length)) {
      console.log(`  ${p.key}  [${p.client?.name ?? 'unassigned'}]`)
      for (const l of p.locations) console.log(`    ${l.role.padEnd(10)} ${l.role_source === 'manual' ? '*' : ' '} ${l.directory}`)
    }
  }
  if (args.has('--unassigned')) {
    console.log('\nunassigned:')
    for (const p of reg.projects.filter(p => !p.client)) console.log(`  ${p.primary}`)
  }
  const warned = reg.projects.filter(p => p.warnings.length)
  if (warned.length) {
    console.log(`\nwarnings (${warned.length} projects):`)
    for (const p of warned) console.log(`  ${p.key}: ${p.warnings.join('; ')}`)
  }
}
