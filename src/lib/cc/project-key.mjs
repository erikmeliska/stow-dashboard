/**
 * Session placement (#12): which register project a session belongs to and in
 * which workspace (worktree/scratchpad) it ran. Path rules first (most
 * worktrees are deleted by the time we look), a memoized git probe only for
 * live dirs no rule and no known location covers. Project identity comes from
 * the #8 register only.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { resolveWorkspacePath } from './workspace.mjs'
import { loadRegistry } from '../registry/registry.mjs'
import { listPlacementInputs, setPlacements } from './store.mjs'

const defaultExec = promisify(execFile)
const probeCache = new Map()

export function clearGitProbeCache() { probeCache.clear() }

export async function gitProbe(dir, { exec = defaultExec } = {}) {
  if (probeCache.has(dir)) return probeCache.get(dir)
  let out = null
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { timeout: 5000 })
    const [common, toplevel] = String(stdout).trim().split('\n')
    if (common?.endsWith('/.git') && toplevel && dirname(common) !== toplevel) out = { base: dirname(common), toplevel }
  } catch { /* not a repo / refused: no mapping */ }
  probeCache.set(dir, out)
  return out
}

const within = (dir, root) => dir === root || dir.startsWith(root + '/')

/** Deepest-location lookup over the register (`buildRegistry()` shape: projects[].key + locations[].directory). */
export function buildProjectIndex({ register } = {}) {
  const entries = []
  const projects = Array.isArray(register?.projects) ? register.projects : []
  for (const p of projects) {
    for (const l of Array.isArray(p?.locations) ? p.locations : []) {
      if (p.key && l?.directory) entries.push([l.directory, p.key])
    }
  }
  entries.sort((a, b) => b[0].length - a[0].length)
  return {
    lookup: (dir) => (dir ? entries.find(([d]) => within(dir, d))?.[1] ?? null : null),
    knownDirs: [...new Set(entries.map(([d]) => d))],
    covers: (dir) => entries.some(([d]) => within(dir, d)),
  }
}

/** Run dir: Codex/Gemini already put their best guess in project_dir; Claude's project_dir is its cwd. */
const runDirOf = (row) => row.project_dir || row.cwd || null

export async function placeSession(row, { index, exists = existsSync, exec = defaultExec }) {
  const run = runDirOf(row)
  let { base_dir, workspace, matched } = resolveWorkspacePath(run, { knownDirs: index.knownDirs })
  if (!matched && run && !index.covers(run) && exists(run)) {
    const g = await gitProbe(run, { exec })
    if (g) {
      base_dir = g.base + run.slice(g.toplevel.length)
      workspace = `git-worktree:${basename(g.toplevel)}`
    }
  }
  return { project_key: index.lookup(base_dir), workspace, base_dir }
}

/**
 * Register read at call time (state dir), never at module eval. A missing or
 * malformed register is an empty index: keys go null, workspaces still resolve.
 * `base` is forwarded to the state-dir helpers (CLIs/MCP pass the repo root).
 */
export async function loadPlacementContext({ base, exec = defaultExec, load = loadRegistry } = {}) {
  let register = null
  try { register = await load(base ? { base } : {}) } catch (e) { console.warn('[cc] register unreadable:', e?.message) }
  return { index: buildProjectIndex({ register }), exists: existsSync, exec }
}

/** Recompute placement for every row; write only what changed. This is also the backfill. */
export async function assignPlacements(db, ctx) {
  const t0 = Date.now()
  const rows = listPlacementInputs(db)
  const changed = []
  for (const r of rows) {
    const p = await placeSession(r, ctx)
    if (p.project_key !== r.project_key || p.workspace !== r.workspace || p.base_dir !== r.base_dir) {
      changed.push({ session_id: r.session_id, ...p })
    }
  }
  setPlacements(db, changed)
  return { checked: rows.length, updated: changed.length, ms: Date.now() - t0 }
}
