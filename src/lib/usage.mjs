// Incremental AI-usage extraction from Claude Code / Codex CLI transcripts.
// Transcripts are append-only JSONL; parsers work on batches of COMPLETE
// lines and keep continuation state (prevTs, cumulative codex totals) so a
// later tail-parse of the same file continues where the last one stopped.
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
