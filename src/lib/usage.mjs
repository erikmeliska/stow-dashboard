// Incremental AI-usage extraction from Claude Code / Codex CLI transcripts.
// Transcripts are append-only JSONL; parsers work on batches of COMPLETE
// lines and keep continuation state (prevTs, cumulative codex totals) so a
// later tail-parse of the same file continues where the last one stopped.
import { open, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import os from 'node:os'
import { costForClaude, costForCodex } from './usage-pricing.mjs'

const ACTIVE_GAP_S = 300

export function newFileState(tool) {
  return { tool, cwd: null, models: {}, codex: null, firstTs: null, lastTs: null, prevTs: null, activeSeconds: 0, sessions: 1 }
}

function tickActive(state, ts) {
  if (!ts) return
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return
  if (state.firstTs === null) state.firstTs = ts
  if (state.prevTs !== null) {
    const gap = (t - state.prevTs) / 1000
    if (gap > 0 && gap < ACTIVE_GAP_S) state.activeSeconds += gap
  }
  state.prevTs = t
  state.lastTs = ts
}

export function parseClaudeLines(lines, state) {
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (!state.cwd && typeof d.cwd === 'string') state.cwd = d.cwd
    tickActive(state, d.timestamp)
    if (d.type !== 'assistant') continue
    const msg = d.message || {}
    const u = msg.usage || {}
    const model = msg.model || 'unknown'
    const m = state.models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    m.input += u.input_tokens || 0
    m.output += u.output_tokens || 0
    m.cacheRead += u.cache_read_input_tokens || 0
    const cc = u.cache_creation || {}
    const w1 = cc.ephemeral_1h_input_tokens || 0
    const w5 = cc.ephemeral_5m_input_tokens || 0
    if (w1 || w5) { m.cacheWrite1h += w1; m.cacheWrite5m += w5 }
    else m.cacheWrite5m += u.cache_creation_input_tokens || 0
  }
  return state
}

export function parseCodexLines(lines, state) {
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const pay = (d.payload && typeof d.payload === 'object') ? d.payload : {}
    if (!state.cwd && typeof pay.cwd === 'string') state.cwd = pay.cwd
    tickActive(state, d.timestamp)
    if (pay.type === 'token_count' && pay.info?.total_token_usage) {
      const tu = pay.info.total_token_usage
      state.codex = {
        input: tu.input_tokens || 0,
        cachedInput: tu.cached_input_tokens || 0,
        output: tu.output_tokens || 0,
      }
    }
  }
  return state
}

export function splitCompleteLines(buffer) {
  const lastNl = buffer.lastIndexOf(0x0a)
  if (lastNl === -1) return { lines: [], consumedBytes: 0 }
  const text = buffer.subarray(0, lastNl).toString('utf8')
  return { lines: text.split('\n').filter(Boolean), consumedBytes: lastNl + 1 }
}

// ── Ledger update + aggregation (fs orchestration) ──────────────────────────

const READ_CHUNK = 4 * 1024 * 1024 // 4 MiB — stream large first-parse files

// Default real-machine paths, shared by the CLI and the refresh routes (Task 3).
export function defaultUsagePaths() {
  const home = os.homedir()
  const dataDir = path.join(process.cwd(), 'data')
  return {
    claudeDir: path.join(home, '.claude', 'projects'),
    codexDir: path.join(home, '.codex', 'sessions'),
    cacheFile: path.join(dataDir, 'usage-cache.json'),
    outFile: path.join(dataDir, 'usage.json'),
  }
}

// List Claude transcripts: one level of per-cwd dirs, each holding *.jsonl.
async function listClaudeFiles(claudeDir) {
  const out = []
  let dirents
  try { dirents = await readdir(claudeDir, { withFileTypes: true }) } catch { return out }
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const sub = path.join(claudeDir, d.name)
    let files
    try { files = await readdir(sub) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(sub, f))
  }
  return out
}

// List Codex rollouts: rollout-*.jsonl nested under YYYY/MM/DD.
async function listCodexFiles(codexDir) {
  const out = []
  let entries
  try { entries = await readdir(codexDir, { recursive: true, withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
    out.push(path.join(e.parentPath ?? e.path, e.name))
  }
  return out
}

// Read [startOffset, size) in chunks, parse only COMPLETE lines into `state`,
// and return the new byte offset (position after the last consumed line).
async function parseFileTail(filePath, tool, startOffset, size, state) {
  const parse = tool === 'claude' ? parseClaudeLines : parseCodexLines
  const fh = await open(filePath, 'r')
  let offset = startOffset
  let leftover = Buffer.alloc(0)
  try {
    while (offset < size) {
      const toRead = Math.min(READ_CHUNK, size - offset)
      const buf = Buffer.allocUnsafe(toRead)
      let pos = 0
      while (pos < toRead) {
        const { bytesRead } = await fh.read(buf, pos, toRead - pos, offset + pos)
        if (bytesRead === 0) break
        pos += bytesRead
      }
      if (pos === 0) break
      const chunk = pos < toRead ? buf.subarray(0, pos) : buf
      const combined = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      const { lines, consumedBytes } = splitCompleteLines(combined)
      if (lines.length) parse(lines, state)
      leftover = combined.subarray(consumedBytes)
      offset += pos
    }
  } finally {
    await fh.close()
  }
  // Trailing incomplete line stays unconsumed until a newline arrives.
  return size - leftover.length
}

async function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

// Incremental ledger update: stat every store file, skip unchanged, tail-parse
// grown files (re-parse shrunk/rebuilt ones from zero), keep deleted files as
// `missing` ghosts, then aggregate and atomically write cache + usage.json.
export async function updateUsage({ claudeDir, codexDir, cacheFile, outFile, projectDirs, rebuild = false }) {
  const start = Date.now()

  let cache
  try {
    cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    if (!cache || cache.version !== 1 || typeof cache.files !== 'object' || cache.files === null) throw new Error('bad cache')
  } catch {
    cache = { version: 1, files: {} }
  }

  const found = new Map()
  for (const f of await listClaudeFiles(claudeDir)) found.set(f, 'claude')
  for (const f of await listCodexFiles(codexDir)) found.set(f, 'codex')

  let filesParsed = 0, filesSkipped = 0, filesMissing = 0

  for (const [absPath, tool] of found) {
    let st
    try { st = await stat(absPath) } catch { continue }
    const prev = cache.files[absPath]
    if (!rebuild && prev && !prev.missing && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      filesSkipped += 1
      continue
    }
    const reuse = !rebuild && prev && !prev.missing && prev.state && st.size >= (prev.offset ?? 0)
    const state = reuse ? prev.state : newFileState(tool)
    const offset = reuse ? (prev.offset ?? 0) : 0
    const newOffset = await parseFileTail(absPath, tool, offset, st.size, state)
    cache.files[absPath] = { tool, size: st.size, mtimeMs: st.mtimeMs, offset: newOffset, missing: false, state }
    filesParsed += 1
  }

  // Files in the ledger but absent on disk → keep as missing ghosts (forever).
  for (const [absPath, entry] of Object.entries(cache.files)) {
    if (found.has(absPath)) continue
    entry.missing = true
    filesMissing += 1
  }

  const agg = aggregateUsage(cache, projectDirs)
  await atomicWriteJson(cacheFile, cache)
  await atomicWriteJson(outFile, agg)

  return { filesParsed, filesSkipped, filesMissing, durationMs: Date.now() - start }
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, codexInput: 0, codexCachedInput: 0, codexOutput: 0 }
}

function newAccumulator() {
  return {
    sessions: 0,
    activeMinutes: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    costUnverifiedUsd: 0,
    byModel: {},
    unpricedModels: new Set(),
    lastActivity: null,
    sessionList: [],
  }
}

function addSession(acc, absPath, entry) {
  const st = entry.state
  acc.sessions += 1
  acc.activeMinutes += (st.activeSeconds || 0) / 60
  if (st.lastTs && (!acc.lastActivity || st.lastTs > acc.lastActivity)) acc.lastActivity = st.lastTs

  let fileCostUsd = 0, fileCostUnverified = 0, tokensIn = 0, tokensOut = 0
  let model // dominant model for a claude session (by output tokens)

  if (st.tool === 'claude') {
    let bestOut = -1
    for (const [id, m] of Object.entries(st.models || {})) {
      const t = { input: m.input || 0, output: m.output || 0, cacheRead: m.cacheRead || 0, cacheWrite5m: m.cacheWrite5m || 0, cacheWrite1h: m.cacheWrite1h || 0 }
      acc.tokens.input += t.input
      acc.tokens.output += t.output
      acc.tokens.cacheRead += t.cacheRead
      acc.tokens.cacheWrite5m += t.cacheWrite5m
      acc.tokens.cacheWrite1h += t.cacheWrite1h
      const bm = acc.byModel[id] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0 }
      bm.input += t.input; bm.output += t.output; bm.cacheRead += t.cacheRead
      bm.cacheWrite5m += t.cacheWrite5m; bm.cacheWrite1h += t.cacheWrite1h
      const c = costForClaude(id, t)
      if (c === null) acc.unpricedModels.add(id)
      else { bm.costUsd += c; acc.costUsd += c; fileCostUsd += c }
      tokensIn += t.input; tokensOut += t.output
      if (t.output > bestOut) { bestOut = t.output; model = id }
    }
  } else if (st.codex) {
    const t = { input: st.codex.input || 0, cachedInput: st.codex.cachedInput || 0, output: st.codex.output || 0 }
    acc.tokens.codexInput += t.input
    acc.tokens.codexCachedInput += t.cachedInput
    acc.tokens.codexOutput += t.output
    const c = costForCodex(t)
    acc.costUnverifiedUsd += c; fileCostUnverified = c
    tokensIn += t.input; tokensOut += t.output
  }

  acc.sessionList.push({
    file: path.basename(absPath),
    tool: st.tool,
    model,
    startedAt: st.firstTs,
    lastActivity: st.lastTs,
    activeMinutes: (st.activeSeconds || 0) / 60,
    costUsd: st.tool === 'claude' ? fileCostUsd : fileCostUnverified,
    tokensIn,
    tokensOut,
  })
}

function finalizeAcc(acc) {
  acc.unpricedModels = [...acc.unpricedModels]
  acc.sessionList.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''))
  return acc
}

// Map each session's cwd to the DEEPEST matching project directory; sessions
// without a match land in the `unmatched` bucket. Prices are applied here.
export function aggregateUsage(cache, projectDirs) {
  const dirs = [...(projectDirs || [])].sort((a, b) => b.length - a.length)
  const projects = {}
  const unmatched = newAccumulator()

  for (const [absPath, entry] of Object.entries(cache.files || {})) {
    const st = entry.state
    if (!st) continue
    const hasClaude = st.models && Object.keys(st.models).length > 0
    const hasCodex = st.codex != null
    if (!hasClaude && !hasCodex) continue

    let target = unmatched
    if (typeof st.cwd === 'string') {
      const dir = dirs.find(d => st.cwd === d || st.cwd.startsWith(d + '/'))
      if (dir) target = projects[dir] ??= newAccumulator()
    }
    addSession(target, absPath, entry)
  }

  const totals = { sessions: 0, activeMinutes: 0, costUsd: 0, costUnverifiedUsd: 0, tokens: emptyTokens() }
  const roll = acc => {
    totals.sessions += acc.sessions
    totals.activeMinutes += acc.activeMinutes
    totals.costUsd += acc.costUsd
    totals.costUnverifiedUsd += acc.costUnverifiedUsd
    for (const k of Object.keys(totals.tokens)) totals.tokens[k] += acc.tokens[k]
  }
  for (const dir of Object.keys(projects)) { roll(projects[dir]); finalizeAcc(projects[dir]) }
  roll(unmatched)
  finalizeAcc(unmatched)

  return { projects, unmatched, totals }
}
