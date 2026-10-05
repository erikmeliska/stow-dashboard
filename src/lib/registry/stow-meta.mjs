/**
 * Per-checkout identity file `<dir>/.stow/project.json` (#8):
 *   { version: 1, id, client?, role? } — unknown keys are preserved.
 * It travels with the folder, so a moved checkout keeps its id (#9) and its
 * manual client/role. It is kept out of `git status` through the repo's
 * info/exclude, or every registered repo would count as uncommitted.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const STOW_DIR = '.stow'
export const META_FILE = 'project.json'
export const ROLES = ['primary', 'deploy', 'experiment', 'stale']
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
// Unanchored so it also matches a project that sits in a subdirectory of its repo.
const EXCLUDE_LINE = '.stow/'

const execFileP = promisify(execFile)
const defaultExec = async (cmd, args) => (await execFileP(cmd, args)).stdout

export function newProjectId() {
  return 'p_' + Array.from(crypto.randomBytes(12), b => B32[b & 31]).join('')
}

export function metaPath(dir) {
  return path.join(dir, STOW_DIR, META_FILE)
}

export function parseStowMeta(text) {
  let raw
  try { raw = JSON.parse(text) } catch { return { meta: null, warnings: ['malformed .stow/project.json'] } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { meta: null, warnings: ['.stow/project.json is not an object'] }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { meta: null, warnings: ['.stow/project.json has no valid id'] }
  const meta = { ...raw }
  const warnings = []
  if ('client' in meta && (typeof meta.client !== 'string' || !meta.client.trim())) {
    warnings.push('ignored invalid client'); delete meta.client
  } else if (typeof meta.client === 'string') meta.client = meta.client.trim()
  if ('role' in meta && !ROLES.includes(meta.role)) {
    warnings.push(`ignored invalid role ${JSON.stringify(meta.role)}`); delete meta.role
  }
  return { meta, warnings }
}

export async function readStowMeta(dir) {
  let text
  try { text = await fs.readFile(metaPath(dir), 'utf8') } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { meta: null, warnings: [] }
    return { meta: null, warnings: [`cannot read .stow/project.json: ${e.code || e.message}`] }
  }
  return parseStowMeta(text)
}

export async function excludeFromGit(dir, { exec = defaultExec } = {}) {
  let out
  try { out = await exec('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude']) } catch { return false }
  const rel = String(out).trim()
  if (!rel) return false
  const file = path.resolve(dir, rel)
  let current = ''
  try { current = await fs.readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const lines = current.split(/\r?\n/).map(l => l.trim())
  if (lines.some(l => l === EXCLUDE_LINE || l === '/.stow/' || l === '.stow')) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  const sep = current && !current.endsWith('\n') ? '\n' : ''
  await fs.appendFile(file, `${sep}${EXCLUDE_LINE}\n`)
  return true
}

export async function writeStowMeta(dir, patch = {}, { exec = defaultExec } = {}) {
  if ('role' in patch && patch.role !== null && !ROLES.includes(patch.role)) throw new Error(`invalid role ${JSON.stringify(patch.role)}`)
  if ('client' in patch && patch.client !== null && (typeof patch.client !== 'string' || !patch.client.trim())) throw new Error('invalid client')
  const file = metaPath(dir)
  let existing = {}
  try {
    const text = await fs.readFile(file, 'utf8')
    const { meta } = parseStowMeta(text)
    if (!meta) throw new Error(`refusing to overwrite malformed ${file}`)
    existing = JSON.parse(text)
  } catch (e) { if (e.code !== 'ENOENT') throw e }

  const next = { ...existing, version: 1 }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k]
    else next[k] = typeof v === 'string' ? v.trim() : v
  }
  if (!next.id) next.id = newProjectId()
  const ordered = { version: 1, id: next.id, ...next }

  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + '\n')
  await fs.rename(tmp, file)
  await excludeFromGit(dir, { exec })
  return ordered
}
