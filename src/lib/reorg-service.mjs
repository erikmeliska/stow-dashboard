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
import { getBaseDir, getScanRoots } from './scan-roots.mjs'

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
    scanRoots: getScanRoots(),
    exists: existsSync,
    relocateDeps: () => defaultRelocateDeps(),
    planRelocation,
    executeRelocation,
  }
}

const httpError = (status, message) => Object.assign(new Error(message), { status })

/**
 * CSRF guard for the state-changing routes: these run local filesystem and
 * register writes, so only same-origin JSON is accepted. A cross-site form or
 * `text/plain` fetch can't set application/json without a CORS preflight
 * (which this server never answers), and a browser always sends Origin /
 * Sec-Fetch-Site on cross-site requests. The Host must be loopback, or a
 * DNS-rebound name (evil.example → 127.0.0.1) would make Origin and Host agree.
 * → an error message, or null if ok.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function guardRequest(headers) {
  const hostname = (headers.get('host') || '').replace(/:\d+$/, '').toLowerCase()
  if (!LOOPBACK.has(hostname)) return 'changes are only accepted on a loopback host (localhost)'
  const type = headers.get('content-type') || ''
  if (!/^application\/json\b/i.test(type)) return 'expected an application/json request'
  if (headers.get('sec-fetch-site') === 'cross-site') return 'cross-origin request refused'
  const origin = headers.get('origin')
  if (origin) {
    let host = null
    try { host = new URL(origin).host } catch { /* opaque origin */ }
    if (host !== headers.get('host')) return 'cross-origin request refused'
  }
  return null
}

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
  const target = path.resolve(to)
  if (target !== to.replace(/\/+$/, '') || !(deps.scanRoots || []).some(r => target.startsWith(path.resolve(r) + '/'))) {
    throw httpError(400, 'to must be a normalised path inside a scan root (SCAN_ROOTS)')
  }
  if (!dryRun && typeof planHash !== 'string') throw httpError(400, 'run a dry-run first: planHash is required')
  const rdeps = await deps.relocateDeps()
  if (dryRun) return deps.planRelocation({ from, to, force: !!force }, rdeps)
  return deps.executeRelocation({ from, to, planHash, force: !!force }, rdeps)
}
