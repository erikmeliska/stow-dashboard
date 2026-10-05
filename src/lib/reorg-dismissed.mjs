/**
 * Dismissed reorg suggestions (#11): data/reorg-dismissed.json,
 * `{ version: 1, dismissed: { [suggestionId]: { at, fingerprint } } }`.
 * A dismissal hides a suggestion only while its evidence fingerprint is
 * unchanged. UI state, so a missing or malformed file is simply empty.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { dataFile } from './state-dir.mjs'

const fileOf = (opts) => opts?.file ?? dataFile('reorg-dismissed.json', opts)

export async function loadDismissed(opts = {}) {
  try {
    const v = JSON.parse(await readFile(fileOf(opts), 'utf8'))
    return v && typeof v.dismissed === 'object' && !Array.isArray(v.dismissed) && v.dismissed ? v.dismissed : {}
  } catch {
    return {}
  }
}

async function save(dismissed, opts) {
  const file = fileOf(opts)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify({ version: 1, dismissed }, null, 2))
  await rename(tmp, file)
}

export async function dismiss(id, fingerprint, opts = {}) {
  const all = await loadDismissed(opts)
  all[id] = { at: opts.now ?? new Date().toISOString(), fingerprint }
  await save(all, opts)
}

export async function undismiss(id, opts = {}) {
  const all = await loadDismissed(opts)
  delete all[id]
  await save(all, opts)
}
