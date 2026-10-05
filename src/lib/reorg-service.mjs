/**
 * What the /api/reorg routes call (#11), testable without Next. Every loader
 * is injectable and the real ones run per call (state-dir rule: the compiled
 * desktop app preloads route modules once at boot).
 *
 * The client only ever sends a suggestion id: apply/dismiss rebuild the
 * report and use that suggestion's own action/fingerprint, so a request can't
 * smuggle in an arbitrary register write.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildReorgReport } from './reorg.mjs'
import { applyAction } from './reorg-apply.mjs'
import { loadDismissed, dismiss, undismiss } from './reorg-dismissed.mjs'
import { loadPathMoves } from './path-moves.mjs'
import { loadRegistry, readRegistryConfig } from './registry/registry.mjs'
import { planRelocation, executeRelocation, defaultRelocateDeps } from './relocate.mjs'
import { ledgerFile } from './state-dir.mjs'
import { getBaseDir } from './scan-roots.mjs'

async function readRows() {
  let text
  try { text = await readFile(ledgerFile(), 'utf8') } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* skip malformed line */ }
  }
  return rows
}

export function defaultServiceDeps() {
  return {
    loadRegistry: () => loadRegistry(),
    readRows,
    readConfig: () => readRegistryConfig(),
    loadDismissed: () => loadDismissed(),
    dismiss: (id, fp) => dismiss(id, fp),
    undismiss: (id) => undismiss(id),
    loadPathMoves: () => loadPathMoves(),
    applyAction: (action) => applyAction(action),
    baseDir: getBaseDir(),
    exists: existsSync,
    relocateDeps: () => defaultRelocateDeps(),
    planRelocation,
    executeRelocation,
  }
}

const httpError = (status, message) => Object.assign(new Error(message), { status })

async function build({ runningDirs = [], includeDismissed = false, deps }) {
  const [register, rows, config, dismissed] = await Promise.all([deps.loadRegistry(), deps.readRows(), deps.readConfig(), deps.loadDismissed()])
  return buildReorgReport({
    register, rows, config, baseDir: deps.baseDir, runningDirs, exists: deps.exists,
    dismissed: includeDismissed ? {} : dismissed,
  })
}

export async function getReport({ runningDirs = [], includeDismissed = false, deps = defaultServiceDeps() } = {}) {
  const report = await build({ runningDirs, includeDismissed, deps })
  const out = { ...report, baseDir: deps.baseDir }
  // A malformed alias table is surfaced, not repaired: losing aliases re-splits history.
  try { await deps.loadPathMoves() } catch (e) { out.error = e.message }
  return out
}

async function findSuggestion(id, { runningDirs, deps }) {
  const all = await build({ runningDirs, includeDismissed: true, deps })
  const s = all.suggestions.find(x => x.id === id)
  if (!s) throw httpError(409, 'This suggestion no longer applies — reload the report')
  return s
}

export async function applySuggestion({ id, runningDirs = [], deps = defaultServiceDeps() }) {
  const s = await findSuggestion(id, { runningDirs, deps })
  await deps.applyAction(s.action)
  return getReport({ runningDirs, deps })
}

export async function dismissSuggestion({ id, undo = false, runningDirs = [], deps = defaultServiceDeps() }) {
  if (undo) await deps.undismiss(id)
  else await deps.dismiss(id, (await findSuggestion(id, { runningDirs, deps })).fingerprint)
  return getReport({ runningDirs, deps })
}

export async function relocate({ from, to, dryRun = false, planHash, force = false, deps = defaultServiceDeps() }) {
  if (typeof from !== 'string' || typeof to !== 'string' || !path.isAbsolute(from) || !path.isAbsolute(to)) {
    throw httpError(400, 'from and to must be absolute paths')
  }
  if (!dryRun && typeof planHash !== 'string') throw httpError(400, 'run a dry-run first: planHash is required')
  const rdeps = await deps.relocateDeps()
  if (dryRun) return deps.planRelocation({ from, to, force: !!force }, rdeps)
  return deps.executeRelocation({ from, to, planHash, force: !!force }, rdeps)
}
