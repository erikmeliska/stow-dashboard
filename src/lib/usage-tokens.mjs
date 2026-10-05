// One definition of "input tokens" across providers, for display (no fs —
// safe to import from client components). The ledger keeps each provider's
// raw fields; this module normalises them at read time:
//
//   total input = uncached + cache read + cache write
//
// Provider semantics of the raw `input` field differ:
// - Claude: `input` is the UNCACHED part only; cache read/write are separate.
// - Codex (OpenAI): `input` INCLUDES `cachedInput`, so uncached = input − cachedInput.
// - Gemini (Antigravity proto, field 2 vs field 5): `input` is the UNCACHED
//   part, like Claude. Verified on ~6.7k real gen_metadata rows: field 2 is
//   below field 5 in 99% of cached turns, which is impossible if it included it.
//   Gemini has no cache-write count (implicit caching).

const n = (v) => Number(v) || 0

function breakdown(uncached, cacheRead, cacheWrite) {
  return { uncached, cacheRead, cacheWrite, total: uncached + cacheRead + cacheWrite }
}

// Claude per-model bucket ({ input, cacheRead, cacheWrite5m, cacheWrite1h }).
export function claudeInput(m = {}) {
  return breakdown(n(m.input), n(m.cacheRead), n(m.cacheWrite5m) + n(m.cacheWrite1h))
}

// Codex bucket ({ input, cachedInput }) — input already includes cachedInput.
export function codexInput(m = {}) {
  return breakdown(Math.max(0, n(m.input) - n(m.cachedInput)), n(m.cachedInput), 0)
}

// Gemini bucket ({ input, cachedInput }) — input excludes cachedInput.
export function geminiInput(m = {}) {
  return breakdown(n(m.input), n(m.cachedInput), 0)
}

// Ledger `tokens` object (usage.json: per project / unmatched / totals) →
// { input: breakdown summed over all providers, output }.
export function usageTokenTotals(t = {}) {
  const parts = [
    claudeInput(t),
    codexInput({ input: t.codexInput, cachedInput: t.codexCachedInput }),
    geminiInput({ input: t.geminiInput, cachedInput: t.geminiCachedInput }),
  ]
  const input = parts.reduce(
    (a, p) => breakdown(a.uncached + p.uncached, a.cacheRead + p.cacheRead, a.cacheWrite + p.cacheWrite),
    breakdown(0, 0, 0),
  )
  return { input, output: n(t.output) + n(t.codexOutput) + n(t.geminiOutput) }
}

export function fmtTokens(v) {
  const x = n(v)
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)}k`
  return `${x}`
}

// "1.08B (uncached 0.5M · cacheR 1.05B · cacheW 23.5M)"
export function fmtInputBreakdown(b) {
  return `${fmtTokens(b.total)} (uncached ${fmtTokens(b.uncached)} · cacheR ${fmtTokens(b.cacheRead)} · cacheW ${fmtTokens(b.cacheWrite)})`
}
