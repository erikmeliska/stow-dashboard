#!/usr/bin/env node
// Writes the agent-office export (#14): data/agent-office.json.
//   node scripts/registry-export.mjs [--unassigned] [--client <name>] [--stdout]
// --stdout prints the document instead of writing the file. --client implies
// --stdout: data/agent-office.json is the full register, and a one-client
// subset written there would look to agent-office like deleted buildings.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportAgentOffice } from '../src/lib/registry/agent-office-export.mjs'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const ci = argv.indexOf('--client')
const client = ci >= 0 ? argv[ci + 1] : undefined
const toStdout = argv.includes('--stdout') || client !== undefined

if (ci >= 0 && (!client || client.startsWith('--'))) {
  console.error('--client needs a client name')
  process.exit(1)
}

try {
  const { doc, file } = await exportAgentOffice({ base, client, includeUnassigned: argv.includes('--unassigned'), write: !toStdout })
  if (toStdout) process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
  else console.log(`${doc.stats.buildings} buildings, ${doc.stats.floors} floors, ${doc.stats.skipped} skipped → ${file}`)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
