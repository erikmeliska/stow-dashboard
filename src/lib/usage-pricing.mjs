// AI-usage cost estimates, priced from the vendored LiteLLM snapshot
// (src/lib/pricing-data.json — see scripts/pricing-sync.mjs). Values are
// list-price EQUIVALENTS ("value of consumption"), not an invoice — on
// subscription plans the real bill is flat. Source: LiteLLM
// model_prices_and_context_window.json, synced via `npm run pricing:sync`.
//
// Static import (not fs + JSON.parse at runtime): Next.js excludes *.json
// from output-file-tracing for the standalone build (next.config.js), so the
// snapshot must be inlined into the compiled bundle by the bundler at build
// time, which only happens for statically-imported modules.
import PRICING from './pricing-data.json' with { type: 'json' }

if (!PRICING || typeof PRICING !== 'object' || !PRICING.models || typeof PRICING.models !== 'object' || Object.keys(PRICING.models).length === 0) {
  throw new Error(
    'src/lib/usage-pricing.mjs: pricing-data.json is missing or malformed (expected a `models` object). '
    + 'Run `npm run pricing:sync` to regenerate it. Refusing to fall back to stale hand-maintained prices.'
  )
}

const PRICE_KEYS = Object.keys(PRICING.models).sort((a, b) => b.length - a.length)

// Longest-prefix lookup against an arbitrary { modelId: priceEntry } table.
// Exported (in addition to matchPrice) so the ordering logic can be tested
// against a synthetic table with genuine short/long key overlap — the live
// snapshot currently has no such pair, so testing matchPrice alone wouldn't
// exercise the sort.
export function matchInTable(table, modelId) {
  if (typeof modelId !== 'string' || !table) return null
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  const key = keys.find(k => modelId.startsWith(k))
  return key ? table[key] : null
}

export function matchPrice(modelId) {
  if (typeof modelId !== 'string') return null
  const key = PRICE_KEYS.find(k => modelId.startsWith(k))
  return key ? PRICING.models[key] : null
}

export function costForClaude(modelId, t) {
  const p = matchPrice(modelId)
  if (!p) return null
  return t.input * p.in
    + t.output * p.out
    + t.cacheRead * (p.cacheRead || 0)
    + t.cacheWrite5m * (p.cacheWrite5m || 0)
    + t.cacheWrite1h * (p.cacheWrite1h || 0)
}

export function costForCodex(t, modelId) {
  const p = matchPrice(modelId)
  if (!p) return null
  const nonCached = Math.max(0, t.input - t.cachedInput)
  return nonCached * p.in
    + t.cachedInput * (p.cacheRead || 0)
    + t.output * p.out
}

export function priceSource() {
  return { fetched: PRICING._fetched, modelCount: Object.keys(PRICING.models).length }
}
