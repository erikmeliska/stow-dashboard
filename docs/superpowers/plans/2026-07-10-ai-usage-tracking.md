# AI Usage & Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project AI token usage and estimated cost from Claude Code + Codex CLI transcripts: durable token ledger with incremental tail-parsing, aggregation into `data/usage.json`, refresh-cycle updates, an "AI $" table column, and a detailed AI Usage section (incl. per-session list) in the details sheet.

**Architecture:** Pure line-parsers per tool feed a per-file ledger (`data/usage-cache.json` — tokens only, survives transcript deletion via `missing` entries). `updateUsage()` stats session stores, tail-parses only grown files, aggregates by session `cwd` → deepest matching project directory, prices at aggregation time, atomically writes `data/usage.json`. Quick/full scan routes call it; `page.js` joins it into records at render.

**Tech Stack:** Node ESM `.mjs`, `node --test`, no new npm deps. Follows the repo's injectable-io test pattern (paths passed in, no real `~/.claude` in tests).

**Spec:** `docs/superpowers/specs/2026-07-10-ai-usage-tracking-design.md` — binding, including the ledger semantics (tokens not dollars; `missing: true` ghosts kept forever; rebuild preserves ghosts).

## Global Constraints

- No new npm dependencies. `data/` is already gitignored (verify with `git check-ignore data/usage.json`; if not ignored, add `data/` entries — but it is).
- Ledger stores TOKENS ONLY — dollars are computed at aggregation from `usage-pricing.mjs`, never persisted in the cache.
- Tail-parse safety: appended chunks may end mid-line; only complete lines are parsed, the offset advances to the byte after the last `\n` (byte math on Buffers, not string lengths — multibyte UTF-8).
- A file whose size SHRANK below the stored offset is re-parsed from zero (fresh state for that file).
- Files present in the ledger but absent on disk → `missing: true`, kept and aggregated forever. Rebuild (`rebuild: true`) resets offsets/state of files that EXIST and preserves `missing` entries untouched.
- Claude token fields per assistant line: `message.usage.{input_tokens, output_tokens, cache_read_input_tokens}` + `message.usage.cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`; when both ephemeral fields are 0/absent, fall back to `message.usage.cache_creation_input_tokens` counted as 5m-write. Only `type === "assistant"` lines carry usage. `cwd` comes from the first line that has a top-level `cwd` key.
- Codex per rollout file: `payload.type === "token_count"` with `payload.info.total_token_usage` is CUMULATIVE — each occurrence REPLACES the previous (never sum). `cwd` from the `session_meta` first line (`payload.cwd`).
- Active time: sum of gaps < 300 s between consecutive event timestamps (chronological within a file; keep `prevTs` in the file state so tail-parses continue the sequence).
- Prices (per MTok) copied verbatim from `~/Projekty/_tools/session-usage/usage_report.py`: fable-5 10/50, opus-4-8|4-7|4-6 5/25, sonnet-5|4-6 3/15, haiku-4-5 1/5; cache multipliers read 0.1×, 5m-write 1.25×, 1h-write 2×; Codex (UNVERIFIED, `verified: false`): in 1.25, cached-in 0.125, out 10 — Codex `input_tokens` INCLUDES `cached_input_tokens` (non-cached = input − cached). Unknown Claude model → cost `null` (tokens still counted; UI shows "unpriced", never $0).
- Model-id matching: longest-prefix match against the price table keys (real ids carry date suffixes, e.g. `claude-haiku-4-5-20251001`).
- UI copy English; list-price disclaimer wherever cost is shown ("list-price value, not an invoice").
- All new JSON writes atomic (temp + rename).

---

### Task 1: Pricing + pure line parsers (`src/lib/usage-pricing.mjs`, `src/lib/usage.mjs` part 1)

**Files:**
- Create: `src/lib/usage-pricing.mjs`, `src/lib/usage-pricing.test.mjs`
- Create: `src/lib/usage.mjs`, `src/lib/usage.test.mjs`

**Interfaces:**
- Produces (`usage-pricing.mjs`): `CLAUDE_PRICE`, `CACHE_MULT = { read: 0.1, write5m: 1.25, write1h: 2 }`, `CODEX_PRICE = { inp: 1.25, cachedIn: 0.125, out: 10, verified: false }`; `matchClaudePrice(modelId) → {inp,out}|null` (longest-prefix); `costForClaude(modelId, t) → number|null` where `t = {input, output, cacheRead, cacheWrite5m, cacheWrite1h}`; `costForCodex(t) → number` where `t = {input, cachedInput, output}`.
- Produces (`usage.mjs` part 1): `newFileState(tool) → { tool, cwd: null, models: {}, codex: null, lastTs: null, prevTs: null, activeSeconds: 0, sessions: 1 }`; `parseClaudeLines(lines: string[], state) → state` (mutates+returns); `parseCodexLines(lines, state) → state`; `splitCompleteLines(buffer: Buffer) → { lines: string[], consumedBytes: number }`.

- [ ] **Step 1: Failing tests — pricing**

```js
// src/lib/usage-pricing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchClaudePrice, costForClaude, costForCodex } from './usage-pricing.mjs'

test('matchClaudePrice longest-prefix matches dated model ids', () => {
  assert.deepEqual(matchClaudePrice('claude-haiku-4-5-20251001'), { inp: 1, out: 5 })
  assert.deepEqual(matchClaudePrice('claude-fable-5'), { inp: 10, out: 50 })
  assert.equal(matchClaudePrice('gpt-9'), null)
})

test('costForClaude prices all four buckets', () => {
  // fable-5: 1M in = $10, 1M out = $50, 1M cacheRead = $1, 1M w5m = $12.5, 1M w1h = $20
  const c = costForClaude('claude-fable-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })
  assert.ok(Math.abs(c - 93.5) < 1e-9)
  assert.equal(costForClaude('unknown-model', { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), null)
})

test('costForCodex subtracts cached from input', () => {
  // 2M input of which 1M cached: 1M*1.25 + 1M*0.125 + 1M out*10 = 11.375
  const c = costForCodex({ input: 2e6, cachedInput: 1e6, output: 1e6 })
  assert.ok(Math.abs(c - 11.375) < 1e-9)
})
```

- [ ] **Step 2: Failing tests — parsers**

```js
// src/lib/usage.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newFileState, parseClaudeLines, parseCodexLines, splitCompleteLines } from './usage.mjs'

const CL = (over = {}) => JSON.stringify({
  type: 'assistant', timestamp: over.ts ?? '2026-07-10T10:00:00Z', cwd: over.cwd,
  message: { model: over.model ?? 'claude-fable-5', usage: {
    input_tokens: over.in ?? 10, output_tokens: over.out ?? 20,
    cache_read_input_tokens: over.cr ?? 0,
    cache_creation_input_tokens: over.ccLegacy ?? 0,
    cache_creation: over.cc ?? { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  } },
})

test('parseClaudeLines sums per model, reads cwd, tracks active time', () => {
  const s = newFileState('claude')
  parseClaudeLines([
    JSON.stringify({ type: 'user', timestamp: '2026-07-10T10:00:00Z', cwd: '/p/a' }),
    CL({ ts: '2026-07-10T10:01:00Z', in: 100, out: 200, cc: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } }),
    CL({ ts: '2026-07-10T10:02:00Z', model: 'claude-opus-4-8', in: 1, out: 2, cr: 300 }),
    CL({ ts: '2026-07-10T10:20:00Z', in: 5, out: 5 }), // 18-min gap → not active time
  ], s)
  assert.equal(s.cwd, '/p/a')
  assert.equal(s.models['claude-fable-5'].input, 105)
  assert.equal(s.models['claude-fable-5'].output, 205)
  assert.equal(s.models['claude-fable-5'].cacheWrite1h, 500)
  assert.equal(s.models['claude-opus-4-8'].cacheRead, 300)
  assert.equal(s.activeSeconds, 120) // 10:00→10:01→10:02
  assert.equal(s.lastTs, '2026-07-10T10:20:00Z')
})

test('parseClaudeLines legacy cache_creation fallback counts as 5m write', () => {
  const s = newFileState('claude')
  parseClaudeLines([CL({ ccLegacy: 700, cc: {} })], s)
  assert.equal(s.models['claude-fable-5'].cacheWrite5m, 700)
})

test('parseClaudeLines survives garbage lines and continues active time across calls', () => {
  const s = newFileState('claude')
  parseClaudeLines(['not json', CL({ ts: '2026-07-10T10:00:00Z' })], s)
  parseClaudeLines([CL({ ts: '2026-07-10T10:01:00Z' })], s) // tail-parse continuation
  assert.equal(s.activeSeconds, 60)
})

test('parseCodexLines: cumulative token_count REPLACES, session_meta cwd', () => {
  const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T10:00:00Z', payload: { cwd: '/p/b' } })
  const tc = (inp, cached, out, ts) => JSON.stringify({ timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out } } } })
  const s = newFileState('codex')
  parseCodexLines([meta, tc(100, 10, 5, '2026-07-10T10:01:00Z'), tc(300, 200, 40, '2026-07-10T10:02:00Z')], s)
  assert.equal(s.cwd, '/p/b')
  assert.deepEqual(s.codex, { input: 300, cachedInput: 200, output: 40 })
  assert.equal(s.activeSeconds, 120)
})

test('splitCompleteLines returns only complete lines and correct byte count', () => {
  const buf = Buffer.from('ahoj\nsvet čau\npartial', 'utf8')
  const { lines, consumedBytes } = splitCompleteLines(buf)
  assert.deepEqual(lines, ['ahoj', 'svet čau'])
  assert.equal(consumedBytes, Buffer.byteLength('ahoj\nsvet čau\n', 'utf8'))
})
```

- [ ] **Step 3: Run to verify fail**, **Step 4: Implement**

`usage-pricing.mjs`:

```js
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
```

`usage.mjs` part 1 (parsers; fs orchestration comes in Task 2):

```js
// Incremental AI-usage extraction from Claude Code / Codex CLI transcripts.
// Transcripts are append-only JSONL; parsers work on batches of COMPLETE
// lines and keep continuation state (prevTs, cumulative codex totals) so a
// later tail-parse of the same file continues where the last one stopped.
const ACTIVE_GAP_S = 300

export function newFileState(tool) {
  return { tool, cwd: null, models: {}, codex: null, lastTs: null, prevTs: null, activeSeconds: 0 }
}

function tickActive(state, ts) {
  if (!ts) return
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return
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
```

- [ ] **Step 5: Run to verify pass; full suite; commit**

```bash
npm test
git add src/lib/usage-pricing.mjs src/lib/usage-pricing.test.mjs src/lib/usage.mjs src/lib/usage.test.mjs
git commit -m "feat: usage pricing tables and transcript line parsers"
```

---

### Task 2: Ledger update + aggregation (`usage.mjs` part 2) + CLI

**Files:**
- Modify: `src/lib/usage.mjs` (append), `src/lib/usage.test.mjs` (append)
- Create: `scripts/usage.mjs`
- Modify: `package.json` (add `"usage": "node scripts/usage.mjs"` script)

**Interfaces:**
- Produces: `updateUsage({ claudeDir, codexDir, cacheFile, outFile, projectDirs, rebuild = false }) → Promise<{ filesParsed, filesSkipped, filesMissing, durationMs }>`; `aggregateUsage(cache, projectDirs) → { projects: { <dir>: {...spec shape incl. sessionList} }, unmatched: {...}, totals: {...} }` (exported for tests).
- Cache file shape v1: `{ version: 1, files: { <absPath>: { tool, size, mtimeMs, offset, missing, state } } }` — `state` is the parser state (tokens only).
- CLI: `node scripts/usage.mjs [--rebuild]` — runs updateUsage against real dirs (`~/.claude/projects`, `~/.codex/sessions`), projectDirs from `data/projects_metadata.jsonl`, prints top-15 projects by cost + totals + unmatched + timing.

- [ ] **Step 1: Failing tests (temp-dir fixtures)**

```js
// append to src/lib/usage.test.mjs
import { mkdtemp, writeFile, appendFile, mkdir, readFile, rm, truncate } from 'fs/promises'
import os from 'os'
import path from 'path'
import { updateUsage, aggregateUsage } from './usage.mjs'

async function makeStores() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-usage-'))
  const claudeDir = path.join(base, 'claude-projects')
  const codexDir = path.join(base, 'codex-sessions')
  await mkdir(path.join(claudeDir, '-p-a'), { recursive: true })
  await mkdir(path.join(codexDir, '2026', '07', '10'), { recursive: true })
  return {
    base, claudeDir, codexDir,
    cacheFile: path.join(base, 'usage-cache.json'),
    outFile: path.join(base, 'usage.json'),
    claudeSession: path.join(claudeDir, '-p-a', 's1.jsonl'),
    codexSession: path.join(codexDir, '2026', '07', '10', 'rollout-1.jsonl'),
  }
}
const claudeLine = (ts, out, cwd) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd, message: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation: {} } } }) + '\n'

test('updateUsage: first run parses, second skips, append tail-parses to same totals', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a/sub'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a', '/p/a/sub'] }
    const r1 = await updateUsage(opts)
    assert.equal(r1.filesParsed, 1)
    const r2 = await updateUsage(opts)
    assert.equal(r2.filesParsed, 0); assert.equal(r2.filesSkipped, 1)
    await appendFile(w.claudeSession, claudeLine('2026-07-10T10:01:00Z', 900, '/p/a/sub'))
    const r3 = await updateUsage(opts)
    assert.equal(r3.filesParsed, 1)
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    const proj = out.projects['/p/a/sub']            // deepest match wins
    assert.equal(proj.tokens.output, 1000)
    assert.equal(proj.sessions, 1)
    assert.ok(proj.costUsd > 0)
    assert.equal(out.projects['/p/a'], undefined)
    assert.equal(proj.sessionList.length, 1)
    assert.equal(proj.sessionList[0].tool, 'claude')
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: deleted transcript stays as missing ghost; rebuild preserves it', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 500, '/p/a'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] }
    await updateUsage(opts)
    await rm(w.claudeSession)
    const r = await updateUsage(opts)
    assert.equal(r.filesMissing, 1)
    let out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 500)   // survived deletion
    await updateUsage({ ...opts, rebuild: true })
    out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 500)   // ghost preserved by rebuild
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: shrunk file is re-parsed from zero (no double counting)', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a') + claudeLine('2026-07-10T10:01:00Z', 100, '/p/a'))
    const opts = { claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] }
    await updateUsage(opts)
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 30, '/p/a')) // rewritten smaller
    await updateUsage(opts)
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(out.projects['/p/a'].tokens.output, 30)
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: codex rollout maps via session_meta cwd; unmatched bucket works', async () => {
  const w = await makeStores()
  try {
    const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T10:00:00Z', payload: { cwd: '/elsewhere' } }) + '\n'
    const tc = JSON.stringify({ timestamp: '2026-07-10T10:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 1000 } } } }) + '\n'
    await writeFile(w.codexSession, meta + tc)
    await updateUsage({ claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] })
    const out = JSON.parse(await readFile(w.outFile, 'utf8'))
    assert.equal(Object.keys(out.projects).length, 0)
    assert.equal(out.unmatched.sessions, 1)
    assert.ok(out.unmatched.costUnverifiedUsd > 1)   // 1M non-cached input ≈ $1.25
  } finally { await rm(w.base, { recursive: true, force: true }) }
})

test('updateUsage: corrupt cache file → full re-parse, no throw', async () => {
  const w = await makeStores()
  try {
    await writeFile(w.claudeSession, claudeLine('2026-07-10T10:00:00Z', 100, '/p/a'))
    await writeFile(w.cacheFile, '{corrupt')
    const r = await updateUsage({ claudeDir: w.claudeDir, codexDir: w.codexDir, cacheFile: w.cacheFile, outFile: w.outFile, projectDirs: ['/p/a'] })
    assert.equal(r.filesParsed, 1)
  } finally { await rm(w.base, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run to verify fail**, **Step 3: Implement**

`updateUsage` implementation outline (write it fully):
1. Load cache (`JSON.parse` with corrupt→`{version:1, files:{}}`).
2. Enumerate files: Claude — `readdir(claudeDir)` dirs → `*.jsonl` inside each; Codex — `readdir(codexDir, { recursive: true })` filtered to `rollout-*.jsonl`; both wrapped in try/catch (missing store → empty list).
3. Per file: `stat`; entry with same `size`+`mtimeMs` → skip (count filesSkipped). `rebuild` or `size < offset` → fresh `newFileState(tool)`, offset 0. Read appended bytes: open fd, read `size - offset` bytes at `offset` into a Buffer (`fs.open`/`read`/`close` via `fs/promises` FileHandle), `splitCompleteLines`, parse via the tool's parser, `offset += consumedBytes`, store `{tool, size, mtimeMs, offset, state, missing: false}`.
4. Ledger entries not found on disk → `missing: true` (skip stat/parse; keep). Rebuild does NOT clear them.
5. `aggregateUsage(cache, projectDirs)`: sort projectDirs by length desc; for each non-empty state with cwd: match `cwd === dir || cwd.startsWith(dir + '/')` → first (deepest) hit, else unmatched. Build per-project shape from the spec: sum Claude model buckets (input/output/cacheRead/cacheWrite5m/cacheWrite1h), Codex buckets (codexInput/codexCachedInput/codexOutput), `costUsd` = Σ costForClaude per model (null-priced models excluded from cost, included in tokens, collected into `unpricedModels: []`), `costUnverifiedUsd` = Σ costForCodex, `byModel`, `sessions` count, `activeMinutes`, `lastActivity` (max lastTs), `sessionList` (per file: basename, tool, dominant model by output tokens, startedAt≈first known ts — store `firstTs` in state when first timestamp seen, add to parser state — lastActivity, activeMinutes, costUsd (or unverified for codex), tokensIn (input+cacheRead for display? NO — plain `input`+codex input), tokensOut), sorted by lastActivity desc.
6. Atomic write cache + out (`temp + rename`). Return counters.

(Adjust `newFileState` in Task-1 code to include `firstTs: null` — set in `tickActive` when null. Update Task-1 tests if the shape assertion needs it.)

`scripts/usage.mjs`: dotenv not needed; resolve `CLAUDE_DIR = ~/.claude/projects`, `CODEX_DIR = ~/.codex/sessions`, cache/out under `data/`; projectDirs = directories from `data/projects_metadata.jsonl`; `--rebuild` flag; print summary (top 15 by `costUsd + costUnverifiedUsd`, totals line, unmatched line, `durationMs`).

- [ ] **Step 4: Run tests + full suite**, **Step 5: LIVE first parse**

Run: `node scripts/usage.mjs` — real first full parse. Expect a table topped by heavy projects (stow-dashboard among them), totals in the ballpark of the reference script (~$7k Claude list-price + ~$50 Codex), `data/usage.json` + `data/usage-cache.json` created. Run again → `filesParsed` near 0, fast. Include both outputs in the report. (`git check-ignore data/usage.json` must confirm ignored.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/usage.mjs src/lib/usage.test.mjs scripts/usage.mjs package.json
git commit -m "feat: incremental usage ledger, per-project aggregation, usage CLI"
```

---

### Task 3: Refresh integration + rebuild endpoint + menu

**Files:**
- Modify: `src/app/api/scan/quick/route.js`, `src/app/api/scan/route.js`
- Create: `src/app/api/usage/rebuild/route.js`
- Modify: `src/components/ScanControls.js`

**Interfaces:**
- Consumes: `updateUsage` from `@/lib/usage.mjs`.
- Quick + full scan routes: after their existing work, before the terminal `complete` event:
```js
try {
  const u = await updateUsage({ claudeDir: CLAUDE_PROJECTS_DIR, codexDir: CODEX_SESSIONS_DIR, cacheFile: USAGE_CACHE, outFile: USAGE_OUT, projectDirs })
  send({ type: 'usage_updated', ...u })
} catch (err) {
  send({ type: 'usage_error', message: err.message })
}
```
(`projectDirs` = the directories the route already has in hand — quick: `projectMap` keys; full: scanned projects' directories. Path constants in a tiny shared helper inside `usage.mjs`: `defaultUsagePaths()` → `{ claudeDir, codexDir, cacheFile, outFile }` using `os.homedir()` + `process.cwd()/data` — reuse in CLI too.)
- `POST /api/usage/rebuild` — plain JSON (no SSE): guards nothing (idempotent), calls `updateUsage({ ...defaultUsagePaths(), projectDirs, rebuild: true })` with projectDirs from `readProjectsData()`, returns the counters JSON; errors → 500 JSON.
- ScanControls ⋯ menu: new item "Rebuild AI usage" after the analyze items — POST, then `showAnalyzeSummary({ message: \`Usage rebuilt: ${filesParsed} files in ${Math.round(durationMs/1000)}s\` }, 5000)` on success / error variant on failure. No polling (await the response; disable the item while in flight via a small state).

- [ ] **Steps:** implement; `npm test`; live verify — dev server: `curl -N -X POST http://localhost:3089/api/scan/quick` shows a `usage_updated` frame; `curl -X POST http://localhost:3089/api/usage/rebuild` returns counters; menu item renders and works (preview). Commit:

```bash
git add src/app/api/scan/quick/route.js src/app/api/scan/route.js src/app/api/usage/rebuild src/components/ScanControls.js src/lib/usage.mjs
git commit -m "feat: usage updates in refresh cycle and rebuild endpoint"
```

---

### Task 4: Join + "AI $" table column

**Files:**
- Modify: `src/app/page.js`, `src/app/project-table.js`, `src/lib/utils.js`, `src/lib/utils.test.mjs`

**Interfaces:**
- `page.js`: read `data/usage.json` (readFile+JSON.parse, `{projects:{}}` on any error) once per render; in the record enrichment spread add `usage: usageData.projects[project.directory]` (undefined when absent).
- `utils.js`: `formatUsd(v)` → `'—'` for null/undefined, `'<1¢'` for `0 < v < 0.01`, `'$0'` for 0, else `'$' + (v >= 100 ? Math.round(v) : v.toFixed(2))`. Tests for all four branches.
- Column `ai_cost` (visible by default — add nothing to `defaultColumnVisibility`): `accessorFn: row => row.usage ? (row.usage.costUsd ?? 0) + (row.usage.costUnverifiedUsd ?? 0) : -1`, header "AI $" (sortable, `sortDescFirst: true`). Cell: `-1` → muted `—`; else `formatUsd(total)` with `~` prefix when `costUsd === 0 && costUnverifiedUsd > 0` (Codex-only, unverified rates); `title` tooltip: `${sessions} sessions · ${(activeMinutes/60).toFixed(1)} h · in ${…} out ${…} tokens · list-price value, not an invoice`.

- [ ] **Steps:** TDD for `formatUsd`; implement; `npm test`; live verify (column shows real values from the Task-2 parse, sorts desc, stow-dashboard near the top; unanalyzed/no-usage rows `—`). Screenshot. Commit:

```bash
git add src/app/page.js src/app/project-table.js src/lib/utils.js src/lib/utils.test.mjs
git commit -m "feat: AI cost column joined from usage.json"
```

---

### Task 5: Details sheet — AI Usage section

**Files:**
- Modify: `src/components/ProjectDetailsSheet.js`

**Interfaces:**
- Consumes: `project.usage` (may be undefined), `formatUsd` + `formatTimeAgo` from `@/lib/utils`, local `Section`/`StatItem` primitives.
- Renders after the AI Insights section: `{project.usage && (<><Section title="AI Usage">…</Section><Separator/></>)}`:
  1. Summary StatItems: Sessions, Active time (`x.x h`), Total cost (`formatUsd(costUsd + costUnverifiedUsd)`).
  2. Per-tool breakdown: Claude subtotal with per-model rows (model name shortened via the price-table prefix, tokens `in/out/cacheR/cacheW`, `formatUsd(cost)`; unpriced models labeled "unpriced"); Codex row with `~` + "⚠️ estimated rates" when present.
  3. Token totals row (input / output / cache read / cache write).
  4. **Recent sessions list** from `usage.sessionList`: first 5 rows visible, `+ N more` button toggling the rest (local useState). Row: `formatTimeAgo(lastActivity)` ago · tool pill (violet `claude` / zinc `codex`) · `${activeMinutes.toFixed(0)} min` · `formatUsd(costUsd)`.
  5. Muted disclaimer line: `List-price value of consumption — not an invoice.`

- [ ] **Steps:** implement; `npm test`; live verify in preview (open stow-dashboard project → full section with real numbers; a usage-less project → no section). Screenshot. Commit:

```bash
git add src/components/ProjectDetailsSheet.js
git commit -m "feat: AI Usage breakdown in project details sheet"
```

---

## Controller steps

- After Task 5: final whole-branch review → fixes → merge to main → `npm run deno:build` + install/launch (usage works in the desktop app too — its cwd-pinned data dir gets its own `usage.json` on first refresh there).

## Self-Review Notes

- Spec coverage: ledger semantics incl. ghosts + rebuild (Task 2 tests), store-first traversal (updateUsage enumerates stores only), tokens-not-dollars (cache stores parser state only; costs computed in aggregateUsage), refresh-cycle updates (Task 3), column + detailed sidebar incl. sessionList (Tasks 4-5), disclaimer everywhere cost shows.
- Deviation from spec noted: rebuild is a dedicated `POST /api/usage/rebuild` instead of a `{rebuildUsage:true}` body on the scan route — cleaner separation, same UX entry point (⋯ menu).
- Type consistency: `usage.json` shape defined once in Task 2 and consumed by Tasks 4-5; `defaultUsagePaths()` shared by CLI and routes; parser state owns `firstTs` addition noted where Task-1 code must be adjusted.
