import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapEntry, buildSnapshot, diffReport, main, WANTED } from './pricing-sync.mjs'

test('mapEntry maps the five per-token fields and drops _flex/_priority/_batches/_above_272k noise', () => {
  const entry = {
    input_cost_per_token: 5e-6,
    cache_read_input_token_cost: 5e-7,
    output_cost_per_token: 2.5e-5,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
    input_cost_per_token_flex: 1e-9,
    output_cost_per_token_priority: 1e-9,
    input_cost_per_token_batches: 1e-9,
    input_cost_per_token_above_272k_tokens: 1e-9,
  }
  assert.deepEqual(mapEntry(entry), {
    in: 5e-6,
    cacheRead: 5e-7,
    out: 2.5e-5,
    cacheWrite5m: 6.25e-6,
    cacheWrite1h: 1e-5,
  })
})

test('mapEntry defaults cacheRead to 0 and omits absent cache-write fields', () => {
  const entry = { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 }
  assert.deepEqual(mapEntry(entry), { in: 5e-6, cacheRead: 0, out: 3e-5 })
})

test('mapEntry returns null when input or output cost is missing', () => {
  assert.equal(mapEntry(undefined), null)
  assert.equal(mapEntry({ input_cost_per_token: 5e-6 }), null)
  assert.equal(mapEntry({ output_cost_per_token: 5e-6 }), null)
})

test('buildSnapshot keeps only WANTED ids, reports missing ones, and stamps _fetched', async () => {
  const data = {
    'claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
    'azure/claude-opus-4-8': { input_cost_per_token: 999, output_cost_per_token: 999 }, // vendor-prefixed, must be ignored
  }
  const fetchImpl = async url => {
    assert.match(url, /litellm/)
    return { ok: true, json: async () => data }
  }
  const { snapshot, missing } = await buildSnapshot({ fetchImpl, now: () => new Date('2026-07-19T00:00:00Z') })

  assert.equal(snapshot._fetched, '2026-07-19')
  assert.deepEqual(Object.keys(snapshot.models), ['claude-opus-4-8'])
  assert.equal(missing.length, WANTED.length - 1)
  assert.ok(missing.includes('gpt-5.6-sol'))
})

test('buildSnapshot throws loudly on a non-OK response (no silent fallback)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
  await assert.rejects(() => buildSnapshot({ fetchImpl }), /503/)
})

test('diffReport flags new, changed, unchanged and removed models, plus missing ids', () => {
  const oldSnapshot = {
    models: {
      a: { in: 1, out: 2 },
      b: { in: 1, out: 2 },
      removed: { in: 9, out: 9 },
    },
  }
  const snapshot = {
    models: {
      a: { in: 1, out: 2 },
      b: { in: 1, out: 3 },
      c: { in: 1, out: 2 },
    },
  }
  const report = diffReport(oldSnapshot, snapshot, ['d'])
  assert.match(report, /= a: unchanged/)
  assert.match(report, /~ b: out: 2 -> 3/)
  assert.match(report, /\+ c: NEW/)
  assert.match(report, /- removed: REMOVED/)
  assert.match(report, /MISSING from LiteLLM.*d/)
})

test('main refuses to write snapshot when WANTED ids are missing', async () => {
  let writeJsonCalled = false
  const fetchImpl = async () => {
    // Return only one model, missing all others
    return { ok: true, json: async () => ({ 'claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }) }
  }
  const readSnapshot = async () => null
  const writeJson = async () => { writeJsonCalled = true }

  process.exitCode = 0
  await main({ fetchImpl, readSnapshot, writeJson })

  assert.equal(writeJsonCalled, false, 'writeJson should not be called when there are missing ids')
  assert.equal(process.exitCode, 1, 'exit code should be 1 when there are missing ids')
})

test('main writes snapshot successfully when all WANTED ids are present', async () => {
  const allModels = Object.fromEntries(
    WANTED.map(id => [id, { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 }])
  )
  let writeJsonData = null
  const fetchImpl = async () => ({ ok: true, json: async () => allModels })
  const readSnapshot = async () => null
  const writeJson = async (outFile, data) => { writeJsonData = data }

  process.exitCode = 0
  await main({ fetchImpl, readSnapshot, writeJson })

  assert.equal(writeJsonData !== null, true, 'writeJson should be called when all ids are present')
  assert.equal(Object.keys(writeJsonData.models).length, WANTED.length, 'all WANTED models should be in the snapshot')
  assert.equal(process.exitCode, 0, 'exit code should be 0 on success')
})
