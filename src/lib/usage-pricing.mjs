// List-price tables for local AI-usage cost estimates. Values are per MTok.
// These are list-price EQUIVALENTS ("value of consumption"), not an invoice —
// on subscription plans the real bill is flat. Source: _tools/session-usage.
export const CLAUDE_PRICE = {
  'claude-fable-5': { inp: 10, out: 50 },
  'claude-opus-4-8': { inp: 5, out: 25 },
  'claude-opus-4-7': { inp: 5, out: 25 },
  'claude-opus-4-6': { inp: 5, out: 25 },
  'claude-sonnet-5': { inp: 3, out: 15 },
  'claude-sonnet-4-6': { inp: 3, out: 15 },
  'claude-haiku-4-5': { inp: 1, out: 5 },
}
export const CACHE_MULT = { read: 0.1, write5m: 1.25, write1h: 2 }
// GPT-5-tier ESTIMATE — rates for gpt-5.x-codex variants are NOT verified.
export const CODEX_PRICE = { inp: 1.25, cachedIn: 0.125, out: 10, verified: false }

const PRICE_KEYS = Object.keys(CLAUDE_PRICE).sort((a, b) => b.length - a.length)

export function matchClaudePrice(modelId) {
  if (typeof modelId !== 'string') return null
  const key = PRICE_KEYS.find(k => modelId.startsWith(k))
  return key ? CLAUDE_PRICE[key] : null
}

export function costForClaude(modelId, t) {
  const p = matchClaudePrice(modelId)
  if (!p) return null
  const i = p.inp / 1e6
  return t.input * i
    + t.output * (p.out / 1e6)
    + t.cacheRead * i * CACHE_MULT.read
    + t.cacheWrite5m * i * CACHE_MULT.write5m
    + t.cacheWrite1h * i * CACHE_MULT.write1h
}

export function costForCodex(t) {
  const nonCached = Math.max(0, t.input - t.cachedInput)
  return nonCached * (CODEX_PRICE.inp / 1e6)
    + t.cachedInput * (CODEX_PRICE.cachedIn / 1e6)
    + t.output * (CODEX_PRICE.out / 1e6)
}
