/**
 * Server-side register → session index (#13). The register (#8) reads the
 * ledger plus every checkout's .stow meta (~80 ms on ~1200 rows), so it is
 * memoised on the ledger + registry.json mtimes and, because a client set in
 * a .stow file touches neither, also expires after `maxAgeMs`. Never throws:
 * sessions must render without it (everything shows as Unassigned).
 */
import fs from 'fs/promises'
import { loadRegistry, REGISTRY_FILE } from '../registry/registry.mjs'
import { clientKey } from '../registry/client.mjs'
import { ledgerFile, dataFile } from '../state-dir.mjs'
import { projectIndex, UNASSIGNED } from './session-projects.mjs'
import { buildProjectIndex } from './project-key.mjs'

const MAX_AGE_MS = 30_000

let memo = null
let lastWarn = null

export function resetProjectIndexMemo() { memo = null; lastWarn = null }

const mtime = async (stat, file) => { try { return (await stat(file)).mtimeMs } catch { return 0 } }

/**
 * @returns {Promise<{ registry: object|null, index: Map, projectKeyOf: ((dir: string) => string|null)|null }>}
 *   `index` is session-projects.mjs's `projectIndex`; `projectKeyOf` the deepest-location lookup #12's routes use.
 */
export async function loadProjectIndex({ base, load = loadRegistry, stat = fs.stat, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  const opts = base ? { base } : {}
  const sig = `${base || ''}:${await mtime(stat, ledgerFile(opts))}:${await mtime(stat, dataFile(REGISTRY_FILE, opts))}`
  const t = now()
  if (memo?.sig === sig && t - memo.at < maxAgeMs) return memo.value
  let value
  try {
    const registry = await load(opts)
    value = { registry, index: projectIndex(registry), projectKeyOf: buildProjectIndex({ register: registry }).lookup }
  } catch (err) {
    if (lastWarn !== err?.message) {
      console.warn('[sessions] register unavailable, sessions shown unassigned:', err?.message)
      lastWarn = err?.message
    }
    value = { registry: null, index: new Map(), projectKeyOf: null }
  }
  memo = { sig, at: t, value }
  return value
}

/** A client by id or by any spelling of its name → `{ id, name }`; 'unassigned' → the string 'unassigned'; unknown → null. */
export function resolveClient(registry, q) {
  const s = String(q ?? '').trim()
  if (!s) return null
  if (s.toLowerCase() === 'unassigned' || s === UNASSIGNED) return 'unassigned'
  const k = clientKey(s)
  const c = (registry?.clients || []).find((x) => x.id === s || clientKey(x.name) === k || x.id === k)
  return c ? { id: c.id, name: c.name } : null
}
