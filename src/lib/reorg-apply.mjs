/**
 * Virtual reorg actions (#11): the only place the Reorg report changes the
 * register. #8's register is a computed view, so "changing" it means writing
 * its two persisted inputs — the per-checkout `.stow/project.json` (manual
 * client / role, via writeStowMeta) and, for orphans only, the ledger rows.
 * Nothing on disk moves (that is relocate.mjs, the exception).
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { writeStowMeta } from './registry/stow-meta.mjs'
import { locationOf } from './registry/identity.mjs'
import { ledgerFile } from './state-dir.mjs'

/**
 * Drop every ledger row whose checkout root is one of `dirs`; other lines are
 * kept byte for byte. Atomic tmp+rename. → number of rows removed.
 */
export async function removeLedgerRows(dirs, opts = {}) {
  const file = opts.file ?? ledgerFile(opts)
  const drop = new Set(dirs)
  const text = await readFile(file, 'utf8')
  let removed = 0
  const kept = text.split('\n').filter((line) => {
    if (!line.trim()) return false
    let row
    try { row = JSON.parse(line) } catch { return true }
    if (typeof row?.directory === 'string' && drop.has(locationOf(row))) { removed++; return false }
    return true
  })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '')
  await rename(tmp, file)
  return removed
}

export const defaultWriters = {
  writeStowMeta: (dir, patch) => writeStowMeta(dir, patch),
  removeLedgerRows: (dirs) => removeLedgerRows(dirs),
  exists: existsSync,
}

const need = (cond, what) => { if (!cond) throw new Error(`reorg action needs ${what}`) }

export async function applyAction(action, writers = defaultWriters) {
  switch (action?.type) {
    case 'confirm-client':
      need(action.directory && action.client, 'a directory and a client')
      return writers.writeStowMeta(action.directory, { client: action.client })
    case 'set-role':
      need(action.directory && action.role, 'a directory and a role')
      return writers.writeStowMeta(action.directory, { role: action.role })
    case 'archive-project': {
      // No project-level flag in #8: archived = every location manually stale.
      need(action.directories?.length, 'directories')
      for (const dir of action.directories) if (writers.exists(dir)) await writers.writeStowMeta(dir, { role: 'stale' })
      return
    }
    case 'remove-project':
      need(action.directories?.length, 'directories')
      return writers.removeLedgerRows(action.directories)
    default: throw new Error(`unknown reorg action: ${action?.type}`)
  }
}
