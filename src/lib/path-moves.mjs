/**
 * Durable record of physical project moves (#11): data/path-moves.json,
 * `{ version: 1, moves: [{ id, from, to, at }] }`, append-only.
 *
 * Claude transcripts and Codex rollouts keep their old `cwd` forever (we never
 * edit them), so a re-ingest or a usage rebuild would put a moved project's
 * history back on the old path. Every place that maps a cwd to a project
 * applies `resolveMovedPath` instead. A malformed file is never overwritten:
 * losing aliases would silently re-split history.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { dataFile } from './state-dir.mjs'

export const PATH_MOVES_FILE = 'path-moves.json'

export class PathMovesError extends Error {}

/** `p` rewritten by every move whose `from` is `p` or a parent of it, in order (so chains resolve). */
export function resolveMovedPath(p, moves) {
  if (typeof p !== 'string' || !moves?.length) return p
  let out = p
  for (const { from, to } of moves) {
    if (out === from) out = to
    else if (out.startsWith(from + '/')) out = to + out.slice(from.length)
  }
  return out
}

// `file` wins; otherwise the state dir (opts forwarded, e.g. `base` from CLIs), at call time.
const fileOf = (opts) => opts?.file ?? dataFile(PATH_MOVES_FILE, opts)

export async function loadPathMoves(opts = {}) {
  let text
  try { text = await readFile(fileOf(opts), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  try {
    const v = JSON.parse(text)
    if (!Array.isArray(v?.moves)) throw new Error('no moves array')
    return v.moves
  } catch (e) {
    throw new PathMovesError(`${PATH_MOVES_FILE} is malformed: ${e.message}`)
  }
}

async function save(moves, opts) {
  const file = fileOf(opts)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify({ version: 1, moves }, null, 2))
  await rename(tmp, file)
}

export async function appendPathMove(move, opts = {}) {
  const moves = await loadPathMoves(opts) // throws on malformed → never overwrite
  await save([...moves, move], opts)
}

export async function removePathMove(id, opts = {}) {
  const moves = await loadPathMoves(opts)
  await save(moves.filter(m => m.id !== id), opts)
}
