import { readFile, readdir, mkdir, open as fsOpen } from 'fs/promises'
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'

export const LOG_DIR = path.join(os.tmpdir(), 'stow-dashboard-logs')

export async function listScripts(directory) {
  const scripts = {}
  try {
    const content = await readFile(path.join(directory, 'package.json'), 'utf-8')
    Object.assign(scripts, JSON.parse(content).scripts || {})
  } catch { /* no/invalid package.json */ }
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.sh')) scripts[e.name] = `./${e.name}`
    }
  } catch { /* unreadable dir */ }
  return scripts
}

export async function runScript(directory, script, { now = Date.now() } = {}) {
  await mkdir(LOG_DIR, { recursive: true })
  const logFile = path.join(LOG_DIR, `${script.replace(/[^a-zA-Z0-9-_]/g, '_')}-${now}.log`)
  const fd = await fsOpen(logFile, 'w')
  const isShell = script.endsWith('.sh')
  const cmd = isShell ? 'bash' : 'npm'
  const args = isShell ? [`./${script}`] : ['run', script]
  const child = spawn(cmd, args, {
    cwd: directory,
    detached: true,
    stdio: ['ignore', fd.fd, fd.fd],
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  child.unref()
  child.once('spawn', () => fd.close().catch(() => {}))
  child.once('error', () => fd.close().catch(() => {}))
  return { pid: child.pid, logFile, script }
}
