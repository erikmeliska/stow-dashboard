import path from 'path'
import os from 'os'
import { existsSync } from 'fs'

/**
 * Single source of truth for where the dashboard's writable state lives:
 * a *state dir* holding `data/` (projects_metadata.jsonl, usage.json,
 * usage-cache.json, run-logs/) and `.env.local`.
 *
 * Why this exists: the shipped Deno desktop shell can't write inside its own
 * compiled bundle, so it pins state to ~/Library/Application Support/
 * StowDashboardDeno (src-deno/server.ts chdirs there before booting Next).
 * Everything the desktop app touches — scans, auto-discovery, the usage
 * ledger, settings — therefore lands in that dir. Consumers that resolve
 * their own paths from *their module location* instead of cwd (the MCP
 * server, the CLIs) used to read the repo's data/ dir and so saw a second,
 * stale ledger. Resolving every path through here keeps them on one store.
 *
 * Resolution order:
 *   1. STOW_STATE_DIR — explicit override; the Deno shell sets it, and it
 *      lets you force repo-local state (STOW_STATE_DIR=. npm run scan).
 *   2. The desktop app-data dir, if it already holds a scanned ledger.
 *   3. `base` — cwd for the Next server, the repo root for CLIs/MCP.
 *
 * Resolve at CALL time, never at module-eval time: the compiled desktop app
 * preloads all route modules at boot and never restarts, so module-level
 * constants would freeze whatever env/cwd existed during that startup window
 * (same reasoning as src/lib/scan-roots.mjs).
 */

export const STATE_DIR_ENV = 'STOW_STATE_DIR'

// The marker whose presence means the desktop app has real state here — an
// empty app-data dir (fresh install, seeded with nothing) must not hijack a
// repo that has a populated data/ dir.
const LEDGER_NAME = 'projects_metadata.jsonl'

/**
 * Where the Deno desktop shell keeps its writable state. Mirrors
 * appDataDir() in src-deno/server.ts — keep the two in sync. macOS only;
 * the desktop shell doesn't ship anywhere else, so elsewhere there is no
 * app-data candidate and `base` wins.
 */
export function appStateDir({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return null
  return path.join(home, 'Library', 'Application Support', 'StowDashboardDeno')
}

/**
 * Resolve the state dir. `base` is the fallback when there's no override and
 * no populated app-data dir: pass the repo root from module-relative callers
 * (MCP, scripts/), leave it as cwd inside the Next server.
 */
export function resolveStateDir({
  base = process.cwd(),
  env = process.env,
  exists = existsSync,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const override = env[STATE_DIR_ENV]
  if (override && override.trim()) return path.resolve(override.trim())

  const appDir = appStateDir({ platform, home })
  if (appDir && exists(path.join(appDir, 'data', LEDGER_NAME))) return appDir

  return path.resolve(base)
}

/** The `data/` dir inside the resolved state dir. */
export function dataDir(opts = {}) {
  return path.join(resolveStateDir(opts), 'data')
}

/** A file inside `data/`, e.g. dataFile('usage.json'). */
export function dataFile(name, opts = {}) {
  return path.join(dataDir(opts), name)
}

/** The scanned-projects ledger — the file most callers want. */
export function ledgerFile(opts = {}) {
  return dataFile(LEDGER_NAME, opts)
}

/** The `.env.local` the running instance reads and the Settings dialog writes. */
export function envFile(opts = {}) {
  return path.join(resolveStateDir(opts), '.env.local')
}
