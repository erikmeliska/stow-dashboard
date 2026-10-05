/**
 * Claude Code keeps per-project state in ~/.claude/projects/<slug>/: session
 * transcripts, `<session>/subagents/`, and `memory/`. The slug is the cwd with
 * every non-alphanumeric character turned into `-`, which is lossy (`/a_b` and
 * `/a-b` collide), so a folder is matched by the `cwd` its transcripts record,
 * never by inverting the slug (#11 relocation). Transcripts keep the cwd they
 * were written in forever, so after an earlier move a folder is only found
 * when its cwds are resolved through path-moves.json (`moves`).
 */
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { resolveMovedPath } from './path-moves.mjs'

const HEAD_BYTES = 64 * 1024

export function claudeSlug(dir) {
  return dir.replace(/[^A-Za-z0-9-]/g, '-')
}

async function headCwds(fs, file) {
  let fh
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    const out = []
    for (const m of buf.subarray(0, bytesRead).toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try { out.push(JSON.parse(`"${m[1]}"`)) } catch { /* torn escape at the cut */ }
    }
    return out
  } catch { return [] } finally { await fh?.close() }
}

/**
 * The folder's own cwd: the first one whose slug is the folder name (a
 * session may have started elsewhere and cd'd in), else the first one seen.
 */
async function folderCwd(fs, dir, slug, transcripts, moves) {
  let first = null
  for (const f of transcripts) {
    for (const raw of await headCwds(fs, path.join(dir, f))) {
      const cwd = resolveMovedPath(raw, moves)
      if (claudeSlug(cwd) === slug) return cwd
      first ??= cwd
    }
  }
  return first
}

/**
 * Folders under `claudeDir` whose (alias-resolved) cwd is `from` or lies under `from/`.
 * → [{ dir, slug, cwd, hasMemory, files }] (`files` = top-level entry names).
 */
export async function findClaudeProjectDirs(claudeDir, from, { fs = fsp, moves = [] } = {}) {
  let slugs
  try { slugs = await fs.readdir(claudeDir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of slugs) {
    if (!d.isDirectory()) continue
    const dir = path.join(claudeDir, d.name)
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    const transcripts = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort()
    const cwd = await folderCwd(fs, dir, d.name, transcripts, moves)
    if (!cwd || !(cwd === from || cwd.startsWith(from + '/'))) continue
    out.push({ dir, slug: d.name, cwd, hasMemory: entries.some(e => e.name === 'memory' && e.isDirectory()), files: entries.map(e => e.name).sort() })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}
