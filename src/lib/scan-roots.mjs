import path from 'path'
import os from 'os'

// Read scan configuration from process.env at CALL time, not module-eval
// time: the Settings dialog updates process.env after saving .env.local, and
// module-level constants in preloaded route modules would never see it
// (the compiled desktop app preloads all routes at boot and never restarts).
export function getScanRoots() {
  return (process.env.SCAN_ROOTS || path.join(os.homedir(), 'Projekty'))
    .split(',').map(s => s.trim()).filter(Boolean)
}

export function getBaseDir() {
  return process.env.BASE_DIR || path.join(os.homedir(), 'Projekty')
}
