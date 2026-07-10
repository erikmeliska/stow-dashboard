# AI Project Analysis — Phase 1 Batch Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the phase-0 analyzer into the product: incremental batch over the JSONL (skip via `input_hash` + version), durable `ai_analysis`/`ai_derived` fields that survive rescans, `POST /api/analyze` with SSE progress, an "AI analyze" entry in the dashboard's ⋯ menu, and scanner-computed `last_code_modified` for non-git projects.

**Architecture:** A new `src/lib/analyze-batch.mjs` orchestrates: load JSONL → filter records needing analysis → sequential `analyzeProject` → after each project, re-read + merge + atomic temp+rename write (crash-safe, minimizes races with scan routes). The API route follows the house inline-SSE pattern from `/api/scan`. The scanner learns to (a) carry `ai_analysis`/`ai_derived` over re-extraction and (b) compute `last_code_modified` during its existing file walk.

**Tech Stack:** Node 20+ ESM `.mjs`, `node --test` + `node:assert/strict`, Next.js App Router route handler (Node runtime, SSE via ReadableStream — same as `src/app/api/scan/route.js`), React client component edit (ScanControls). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-ai-project-analysis-design.md`. Phase-0 code (merged): `src/lib/analyzer.mjs`, `src/lib/distill.mjs`, `src/lib/tech-tags.mjs`, `scripts/analyze.mjs`.

## Global Constraints

- No new npm dependencies.
- Tests must not require `apfel` (inject `execImpl`), network, or the real `data/projects_metadata.jsonl` — use temp dirs/files.
- JSONL writes must be atomic: write to `<file>.tmp-<pid>` then `rename`. Before every write, re-read the current file and merge ONLY the `ai_analysis` + `ai_derived` keys into the fresh records (a scan may have rewritten the file mid-batch; never clobber other fields with stale copies).
- Data model (spec): model output in `ai_analysis` (includes `input_hash`, `analyzed_at`, `model`, plus new `version`); deterministic fields in sibling key `ai_derived` = `{ status, tech, placement_ok, suggested_path }`.
- Skip rule: a record is skipped when `ai_analysis.input_hash === <current distillate hash>` AND `ai_analysis.version === ANALYSIS_VERSION` (errors count as analyzed for the same hash+version — same input would fail the same way; `--force` re-analyzes everything).
- `ANALYSIS_VERSION` starts at `2` (v1 = the un-versioned pilot). Bump it whenever `buildSchema`/`buildSystemPrompt`/distillate format changes.
- Status precedence (spec): git `lastCodeCommit` (meta-doc-excluded) → `last_code_modified` (scanner, non-git) → max(`git_info.last_total_commit_date`, `last_modified`).
- `last_code_modified` excludes the same meta-doc names as distill's `CODE_ACTIVITY_EXCLUDES` (single source of truth — export the list from `src/lib/distill.mjs` and import it in the scanner; matching is by top-level-relative first path segment or exact filename, case-insensitive prefix match for the `*`-suffixed entries).
- API route: house style — Node runtime (no `runtime` export), inline SSE (`text/event-stream`, `data: {json}\n\n` frames), no auth, body parsed with `.catch(() => ({}))`. Event vocabulary mirrors scan: `status`, per-project `analyzed`/`skipped`/`analyze_error` with `{ current, total }`, terminal `complete`/`error`.
- Only one batch at a time: module-level `isAnalyzing` flag in `analyze-batch.mjs`; a second POST while running gets SSE `{type:'error', message:'analysis already running'}`.
- apfel exit-code contract unchanged: kind `unavailable` aborts the batch; refused/too-large/busy/error mark the record and continue.

---

### Task 1: Scanner durability + `last_code_modified`

**Files:**
- Modify: `src/scanner/index.mjs` (walkFileTree ~L257-310, extractProjectMetadata ~L348-439, processProject ~L500-517)
- Modify: `src/lib/distill.mjs` (export the exclude list)
- Test: `src/scanner/index.test.mjs` (append), `src/lib/distill.test.mjs` (append)

**Interfaces:**
- Consumes: `CODE_ACTIVITY_EXCLUDES` (currently a module-private const in `src/lib/distill.mjs`).
- Produces: JSONL records gain `last_code_modified` (ISO string|null); `processProject` carries `ai_analysis` + `ai_derived` from the cached record onto freshly extracted ones; `distill.mjs` exports `CODE_ACTIVITY_EXCLUDES` and `isMetaDocPath(relPath)`.

- [ ] **Step 1: Write failing tests**

Append to `src/lib/distill.test.mjs`:

```js
import { CODE_ACTIVITY_EXCLUDES, isMetaDocPath } from './distill.mjs'

test('isMetaDocPath matches meta-doc files and dirs, case-insensitively for prefixes', () => {
  assert.equal(isMetaDocPath('README.md'), true)
  assert.equal(isMetaDocPath('readme.txt'), true)
  assert.equal(isMetaDocPath('CHANGELOG-2024.md'), true)
  assert.equal(isMetaDocPath('LICENSE'), true)
  assert.equal(isMetaDocPath('docs/setup.md'), true)
  assert.equal(isMetaDocPath('.github/workflows/ci.yml'), true)
  assert.equal(isMetaDocPath('CLAUDE.md'), true)
  assert.equal(isMetaDocPath('src/index.js'), false)
  assert.equal(isMetaDocPath('my-docs-notes.md'), false)   // only the docs/ DIR is excluded
  assert.equal(isMetaDocPath('src/README.md'), true)        // nested README is still a meta-doc
  assert.ok(Array.isArray(CODE_ACTIVITY_EXCLUDES))
})
```

Append to `src/scanner/index.test.mjs` (follow that file's existing temp-dir + scanner-instance patterns):

```js
test('walkFileTree computes last_code_modified excluding meta-doc files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
  try {
    const old = new Date('2020-01-05T00:00:00Z')
    const fresh = new Date('2026-07-01T00:00:00Z')
    await writeFile(path.join(dir, 'index.js'), 'x')
    await utimes(path.join(dir, 'index.js'), old, old)
    await writeFile(path.join(dir, 'README.md'), 'x')
    await utimes(path.join(dir, 'README.md'), fresh, fresh)
    await writeFile(path.join(dir, 'package.json'), '{}')
    await utimes(path.join(dir, 'package.json'), old, old)
    const scanner = new ProjectScanner({ scanRoots: [dir] })
    const meta = await scanner.extractProjectMetadata(dir)
    // last_modified follows the freshest file (README), last_code_modified must not
    assert.equal(new Date(meta.last_code_modified).getUTCFullYear(), 2020)
    assert.equal(new Date(meta.last_modified).getUTCFullYear(), 2026)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('last_code_modified is null for a project with only meta-doc files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
  try {
    await writeFile(path.join(dir, 'README.md'), 'only docs')
    const scanner = new ProjectScanner({ scanRoots: [dir] })
    const meta = await scanner.extractProjectMetadata(dir)
    assert.equal(meta.last_code_modified, null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('processProject carries ai_analysis and ai_derived across re-extraction', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
    const scanner = new ProjectScanner({ scanRoots: [dir], forceUpdate: true })
    const ai = { category: '_Learning', input_hash: 'h', version: 2 }
    const derived = { status: 'dead', tech: [], placement_ok: true, suggested_path: dir }
    scanner.existingProjectsCache.set(dir, { directory: dir, last_modified: '2000-01-01T00:00:00Z', ai_analysis: ai, ai_derived: derived })
    const meta = await scanner.processProject(dir)
    assert.deepEqual(meta.ai_analysis, ai)      // survived forced re-extraction
    assert.deepEqual(meta.ai_derived, derived)
    assert.ok(meta.stack !== undefined)          // and it IS a fresh record
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/scanner/index.test.mjs src/lib/distill.test.mjs`
Expected: new tests FAIL (missing exports / missing field / dropped keys); existing tests PASS.

- [ ] **Step 3: Implement**

`src/lib/distill.mjs` — replace the private const with exports (keep the array contents identical):

```js
export const CODE_ACTIVITY_EXCLUDES = [
  'README*', 'readme*', 'CHANGELOG*', 'LICENSE*', 'docs', '.github',
  'CLAUDE.md', 'STATUS.md', 'TASKS.md', 'AGENTS.md',
]

// Is this repo-relative path a meta-doc (excluded from code-activity)?
// Prefix entries ('README*') match any path whose BASENAME starts with the
// prefix, case-insensitively. Bare entries match the exact basename or a
// leading directory segment ('docs', '.github').
export function isMetaDocPath(relPath) {
  const segments = relPath.split('/').filter(Boolean)
  const base = segments[segments.length - 1] || ''
  for (const entry of CODE_ACTIVITY_EXCLUDES) {
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1).toLowerCase()
      if (base.toLowerCase().startsWith(prefix)) return true
    } else if (entry.includes('.')) {
      if (base === entry) return true
    } else {
      if (segments[0] === entry) return true
    }
  }
  return false
}
```

`src/scanner/index.mjs`:
1. Import at top: `import { isMetaDocPath } from '../lib/distill.mjs'`
2. In `walkFileTree`, alongside the existing `latestMtime` accumulation, track `latestCodeMtime` — updated only for content files (not `isLibPath`) whose repo-relative path fails `isMetaDocPath(relPath)`. The walk already knows each file's path relative to the project root (it computes relative paths for ignore matching); reuse that. Return it in the result object as `latestCodeMtime` (epoch ms or 0).
3. In `extractProjectMetadata`, destructure `latestCodeMtime` and add to the record literal (keep key order — insert after `last_modified`):
```js
last_code_modified: latestCodeMtime ? new Date(latestCodeMtime).toISOString() : null,
```
4. In `processProject`, after a fresh `extractProjectMetadata` result, carry over the AI keys from the cached record:
```js
const cached = this.existingProjectsCache.get(directory)
if (cached?.ai_analysis) metadata.ai_analysis = cached.ai_analysis
if (cached?.ai_derived) metadata.ai_derived = cached.ai_derived
```
(Place it where both `metadata` and the cache lookup are in scope; `shouldUpdateMetadata` already reads the cache — reuse its `cached` if the code shape allows, otherwise look up again as above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/scanner/index.test.mjs src/lib/distill.test.mjs`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected all green.

```bash
git add src/scanner/index.mjs src/scanner/index.test.mjs src/lib/distill.mjs src/lib/distill.test.mjs
git commit -m "feat: scanner keeps ai_analysis across rescans and computes last_code_modified"
```

---

### Task 2: `ANALYSIS_VERSION`, `needsAnalysis`, status fallback

**Files:**
- Modify: `src/lib/analyzer.mjs`
- Test: `src/lib/analyzer.test.mjs` (append)

**Interfaces:**
- Consumes: `distillProject`, `gatherFacts` (existing).
- Produces: `export const ANALYSIS_VERSION = 2`; `needsAnalysis(record, currentHash): boolean`; `deriveStatus(project, { now?, lastCodeCommit?, lastCodeModified? }?)` — new optional `lastCodeModified` slots between `lastCodeCommit` and the legacy fallback; `analyzeProject` output `ai_analysis` gains `version: ANALYSIS_VERSION` and passes `project.last_code_modified` into `deriveStatus`.

- [ ] **Step 1: Write failing tests (append to analyzer.test.mjs)**

```js
import { ANALYSIS_VERSION, needsAnalysis } from './analyzer.mjs'

test('needsAnalysis: true when never analyzed, hash changed, or version bumped', () => {
  assert.equal(needsAnalysis({}, 'h1'), true)
  assert.equal(needsAnalysis({ ai_analysis: { input_hash: 'h0', version: ANALYSIS_VERSION } }, 'h1'), true)
  assert.equal(needsAnalysis({ ai_analysis: { input_hash: 'h1', version: ANALYSIS_VERSION - 1 } }, 'h1'), true)
  assert.equal(needsAnalysis({ ai_analysis: { input_hash: 'h1', version: ANALYSIS_VERSION } }, 'h1'), false)
})

test('needsAnalysis: error records are cached like results for the same hash+version', () => {
  assert.equal(needsAnalysis({ ai_analysis: { error: 'too-large', input_hash: 'h1', version: ANALYSIS_VERSION } }, 'h1'), false)
})

test('deriveStatus uses last_code_modified when no git code commit', () => {
  const p = { last_modified: '2026-07-01T00:00:00Z', git_info: {} }
  const NOW = Date.parse('2026-07-10T00:00:00Z')
  assert.equal(deriveStatus(p, { now: NOW, lastCodeModified: '2022-01-01T00:00:00Z' }), 'archive-candidate')
  // git lastCodeCommit still wins over lastCodeModified
  assert.equal(deriveStatus(p, { now: NOW, lastCodeCommit: '2026-06-20T00:00:00Z', lastCodeModified: '2022-01-01T00:00:00Z' }), 'active')
})

test('analyzeProject stamps version and consumes last_code_modified', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const project = { ...pilotProject(dir), last_code_modified: '2026-07-01T00:00:00Z' }
    const { ai_analysis, derived } = await analyzeProject(project, {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ result: MODEL_OUT }), now: Date.parse('2026-07-10T00:00:00Z'),
    })
    assert.equal(ai_analysis.version, ANALYSIS_VERSION)
    assert.equal(derived.status, 'active') // last_code_modified wins over the stale last_modified/dates
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run to verify new tests fail** — `node --test src/lib/analyzer.test.mjs`

- [ ] **Step 3: Implement in analyzer.mjs**

```js
export const ANALYSIS_VERSION = 2

export function needsAnalysis(record, currentHash) {
  const a = record?.ai_analysis
  if (!a) return true
  return a.input_hash !== currentHash || a.version !== ANALYSIS_VERSION
}
```

`deriveStatus`: extend the options destructure with `lastCodeModified = null`; precedence: `lastCodeCommit` → `lastCodeModified` → legacy max(). (Both go through the same `Number.isFinite(Date.parse(...))` guard.)

`analyzeProject`: add `version: ANALYSIS_VERSION` into the returned `ai_analysis`; pass `lastCodeModified: project.last_code_modified` into the `deriveStatus` call. Also stamp `version` + `input_hash` onto the error records so `needsAnalysis` caches them: compute the hash before the preflight loop (hash of the FIRST/full-size distillate — `distillProject(project, facts, { ...SHRINK_STEPS[0], baseDir }).hash`) and include `input_hash` + `version` in every `{ ai_analysis: { error, ... } }` return.

- [ ] **Step 4: Run to verify pass** — `node --test src/lib/analyzer.test.mjs` (all, including pre-existing — note two pre-existing error-path tests may need their assertions extended for the new `input_hash`/`version` keys; extend the assertions, do not weaken them).

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/lib/analyzer.mjs src/lib/analyzer.test.mjs
git commit -m "feat: analysis versioning, needsAnalysis skip rule, last_code_modified status fallback"
```

---

### Task 3: Batch module (`src/lib/analyze-batch.mjs`)

**Files:**
- Create: `src/lib/analyze-batch.mjs`
- Test: `src/lib/analyze-batch.test.mjs`

**Interfaces:**
- Consumes: `readTaxonomy`, `buildSchema`, `analyzeProject`, `needsAnalysis`, `ApfelError`, `ANALYSIS_VERSION` from `./analyzer.mjs`; `gatherFacts`, `distillProject` from `./distill.mjs`.
- Produces:
  - `isAnalysisRunning(): boolean`
  - `runAnalysisBatch({ dataFile, baseDir, force = false, only = null, onProgress = () => {}, execImpl } ): Promise<{ analyzed, skipped, errors, total, durationMs }>`
    - `only`: array of directory paths — restrict to those records (used by `{project: id}` API mode and `--pilot`).
    - `onProgress(event)`: `{type:'status', message, total?}` | `{type:'analyzed'|'skipped'|'analyze_error', directory, project_name, current, total, detail?}` | terminal handled by caller.
    - Throws `ApfelError('unavailable')` upward (caller reports and aborts). Any other per-project error → `analyze_error` event + continue.
    - Sets/clears the module-level running flag in a `try/finally`; throws `Error('analysis already running')` if entered while set.

- [ ] **Step 1: Write failing tests**

```js
// src/lib/analyze-batch.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runAnalysisBatch, isAnalysisRunning } from './analyze-batch.mjs'
import { ANALYSIS_VERSION } from './analyzer.mjs'

const MODEL_OUT = {
  category: '_Learning', client: '', generated_description: 'x',
  project_type: 'script-collection', domain: 'devtools', maturity: 'prototype',
  tech_extra: [], reusable_assets: [], doc_score: 0, doc_gaps: [], confidence: 'low',
}

function okExec() {
  return async (cmd, args) => {
    if (args.includes('--count-tokens')) return { stdout: 'ok', stderr: '' }
    return { stdout: JSON.stringify(MODEL_OUT), stderr: '' }
  }
}

async function makeWorld() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-batch-'))
  await mkdir(path.join(base, '_Bizz'), { recursive: true })
  await mkdir(path.join(base, '_Learning'))
  const projDir = path.join(base, 'proj1')
  await mkdir(projDir)
  await writeFile(path.join(projDir, 'index.js'), '1')
  const record = {
    id: 'r1', directory: projDir, project_name: 'proj1',
    created: '2020-01-01T00:00:00Z', last_modified: '2020-02-01T00:00:00Z',
    stack: [], file_types: { '.js': 1 }, git_info: { git_detected: false },
  }
  const dataFile = path.join(base, 'projects.jsonl')
  await writeFile(dataFile, JSON.stringify(record) + '\n')
  return { base, projDir, dataFile }
}

test('runAnalysisBatch analyzes, writes ai_analysis + ai_derived atomically, then skips on rerun', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    const events = []
    const r1 = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), onProgress: e => events.push(e) })
    assert.equal(r1.analyzed, 1)
    const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
    assert.equal(rec.ai_analysis.category, '_Learning')
    assert.equal(rec.ai_analysis.version, ANALYSIS_VERSION)
    assert.ok(rec.ai_derived.status)
    assert.equal(rec.project_name, 'proj1') // other fields untouched
    assert.ok(events.some(e => e.type === 'analyzed'))
    const r2 = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    assert.equal(r2.analyzed, 0)
    assert.equal(r2.skipped, 1)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch force re-analyzes and only-filter restricts', async () => {
  const { base, dataFile, projDir } = await makeWorld()
  try {
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    const r = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), force: true, only: [projDir] })
    assert.equal(r.analyzed, 1)
    const none = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), force: true, only: ['/nope'] })
    assert.equal(none.total, 0)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch merges into a file changed mid-batch instead of clobbering it', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    // execImpl side effect: while "the model runs", a scan rewrites the file with a new field
    const sneaky = async (cmd, args) => {
      if (!args.includes('--count-tokens')) {
        const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
        rec.description = 'updated by concurrent scan'
        await writeFile(dataFile, JSON.stringify(rec) + '\n')
        return { stdout: JSON.stringify(MODEL_OUT), stderr: '' }
      }
      return { stdout: 'ok', stderr: '' }
    }
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: sneaky })
    const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
    assert.equal(rec.description, 'updated by concurrent scan') // scan's write survived
    assert.equal(rec.ai_analysis.category, '_Learning')          // and analysis landed
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch refuses concurrent entry', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    let release
    const gate = new Promise(res => { release = res })
    const slowExec = async (cmd, args) => {
      if (!args.includes('--count-tokens')) await gate
      return { stdout: args.includes('--count-tokens') ? 'ok' : JSON.stringify(MODEL_OUT), stderr: '' }
    }
    const first = runAnalysisBatch({ dataFile, baseDir: base, execImpl: slowExec, force: true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(isAnalysisRunning(), true)
    await assert.rejects(runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() }), /already running/)
    release()
    await first
    assert.equal(isAnalysisRunning(), false)
  } finally { await rm(base, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run to verify fail** — `node --test src/lib/analyze-batch.test.mjs`

- [ ] **Step 3: Implement**

```js
// src/lib/analyze-batch.mjs
// Incremental AI-analysis batch over the projects JSONL. Sequential (one
// local model), crash-safe (atomic per-project writes), and race-aware:
// every write re-reads the file and merges only the AI keys, so a scan
// rewriting the JSONL mid-batch never loses its changes — and vice versa.
import { readFile, writeFile, rename } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  readTaxonomy, buildSchema, analyzeProject, needsAnalysis, ApfelError,
} from './analyzer.mjs'
import { gatherFacts, distillProject } from './distill.mjs'

let running = false

export function isAnalysisRunning() {
  return running
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function writeJsonlAtomic(file, records) {
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  await rename(tmp, file)
}

// Re-read the current file and merge this record's AI keys into it.
async function persistAnalysis(dataFile, directory, aiAnalysis, aiDerived) {
  const records = await readJsonl(dataFile)
  const rec = records.find(r => r.directory === directory)
  if (!rec) return // project removed by a concurrent full scan — drop the result
  rec.ai_analysis = aiAnalysis
  if (aiDerived) rec.ai_derived = aiDerived
  else delete rec.ai_derived
  await writeJsonlAtomic(dataFile, records)
}

export async function runAnalysisBatch({ dataFile, baseDir, force = false, only = null, onProgress = () => {}, execImpl }) {
  if (running) throw new Error('analysis already running')
  running = true
  const started = Date.now()
  try {
    const taxonomy = await readTaxonomy(baseDir)
    const schemaFile = path.join(os.tmpdir(), `stow-analysis-schema-${process.pid}.json`)
    await writeFile(schemaFile, JSON.stringify(buildSchema(taxonomy)))

    let records = await readJsonl(dataFile)
    if (only) {
      const set = new Set(only)
      records = records.filter(r => set.has(r.directory))
    }
    const total = records.length
    onProgress({ type: 'status', message: `Analyzing ${total} project(s)`, total })

    let analyzed = 0, skipped = 0, errors = 0, current = 0
    for (const record of records) {
      current++
      const base = { directory: record.directory, project_name: record.project_name, current, total }
      try {
        const facts = await gatherFacts(record)
        const { hash } = distillProject(record, facts, { baseDir })
        if (!force && !needsAnalysis(record, hash)) {
          skipped++
          onProgress({ type: 'skipped', ...base })
          continue
        }
        const { ai_analysis, derived } = await analyzeProject(record, { taxonomy, baseDir, schemaFile, execImpl })
        await persistAnalysis(dataFile, record.directory, ai_analysis, derived)
        if (ai_analysis.error) {
          errors++
          onProgress({ type: 'analyze_error', ...base, detail: ai_analysis.error })
        } else {
          analyzed++
          onProgress({ type: 'analyzed', ...base, detail: ai_analysis.category })
        }
      } catch (err) {
        if (err instanceof ApfelError && err.kind === 'unavailable') throw err
        errors++
        onProgress({ type: 'analyze_error', ...base, detail: err.message })
      }
    }
    return { analyzed, skipped, errors, total, durationMs: Date.now() - started }
  } finally {
    running = false
  }
}
```

Note: `analyzeProject` re-runs `gatherFacts`/`distillProject` internally — that duplicate work (~ms of fs reads vs ~1.4s of model time) is accepted for phase 1; do not restructure the analyzer contract for it.

- [ ] **Step 4: Run to verify pass** — `node --test src/lib/analyze-batch.test.mjs`

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/lib/analyze-batch.mjs src/lib/analyze-batch.test.mjs
git commit -m "feat: incremental AI analysis batch with atomic merge writes"
```

---

### Task 4: CLI full mode (`scripts/analyze.mjs` rewrite onto the batch module)

**Files:**
- Modify: `scripts/analyze.mjs`

**Interfaces:**
- Consumes: `runAnalysisBatch` from `../src/lib/analyze-batch.mjs`; `ApfelError` from `../src/lib/analyzer.mjs`.
- Produces CLI modes: `node scripts/analyze.mjs` (full incremental batch over the real JSONL), `--force`, `--pilot <dir>…` (restrict via `only`, keep writing `test/fixtures/pilot-results.json` for gate comparisons). `npm run analyze` unchanged.

- [ ] **Step 1: Rewrite the CLI**

Keep: dotenv load, apfel `--model-info` preflight (exit 5), `~` expansion, `BASE_DIR`/`DATA_FILE` constants. Replace the hand-rolled loop with `runAnalysisBatch`:

```js
const args = process.argv.slice(2)
const force = args.includes('--force')
const pilotIdx = args.indexOf('--pilot')
const only = pilotIdx !== -1
  ? args.slice(pilotIdx + 1).filter(a => !a.startsWith('--')).map(p => path.resolve(p.replace(/^~/, os.homedir())))
  : null
if (pilotIdx !== -1 && (!only || only.length === 0)) {
  console.error('Usage: node scripts/analyze.mjs [--force] [--pilot <dir>...]')
  process.exit(2)
}
```

Progress printing (same visual style as before):
```js
const onProgress = (e) => {
  if (e.type === 'status') console.log(e.message)
  else if (e.type === 'analyzed') console.log(`✓ [${e.current}/${e.total}] ${e.project_name} → ${e.detail}`)
  else if (e.type === 'analyze_error') console.log(`✗ [${e.current}/${e.total}] ${e.project_name}: ${e.detail}`)
  else if (e.type === 'skipped') process.stdout.write(`· [${e.current}/${e.total}] ${e.project_name} (cached)\r`)
}
```

Run and finish:
```js
try {
  const summary = await runAnalysisBatch({ dataFile: DATA_FILE, baseDir: BASE_DIR, force, only, onProgress })
  console.log(`\nDone: ${summary.analyzed} analyzed, ${summary.skipped} cached, ${summary.errors} errors in ${Math.round(summary.durationMs / 1000)}s`)
} catch (err) {
  if (err instanceof ApfelError && err.kind === 'unavailable') {
    console.error('Model unavailable — aborting.'); process.exit(5)
  }
  throw err
}
```

In `--pilot` mode, additionally read back the analyzed records from the JSONL and write `test/fixtures/pilot-results.json` in the existing `{ directory, ai_analysis, derived, ms? }` shape (`derived` = the record's `ai_derived`; `ms` may be omitted — the golden comparisons don't read it).

- [ ] **Step 2: Verify against the real model (smoke, 1 project)**

Run: `node scripts/analyze.mjs --pilot ~/Projekty/codewars`
Expected: `✓ [1/1] codewars → _Learning`-style line; `data/projects_metadata.jsonl` line for codewars now contains `ai_analysis` (check with `grep -F '"directory":"/Users/ericsko/Projekty/codewars"' data/projects_metadata.jsonl | head -c 600`). Second run prints `(cached)` and `0 analyzed`.

- [ ] **Step 3: Commit**

```bash
git add scripts/analyze.mjs
git commit -m "feat: analyze CLI full incremental mode on top of batch module"
```

(The JSONL data change from the smoke test is user data, not source — leave `data/projects_metadata.jsonl` uncommitted if the repo's git status shows it as modified and it is not already tracked-and-committed routinely; follow whatever `git status` shows other scans have done — if the file is tracked and routinely committed, include it, otherwise leave it.)

---

### Task 5: `POST /api/analyze` (SSE) + ⋯ menu entry

**Files:**
- Create: `src/app/api/analyze/route.js`
- Modify: `src/components/ScanControls.js` (⋯ menu + progress handling)

**Interfaces:**
- Consumes: `runAnalysisBatch`, `isAnalysisRunning` from `@/lib/analyze-batch.mjs`; `readProjectsData` from `@/lib/projects` (to resolve `{project: id}` → directory).
- Produces: `POST /api/analyze` body `{ force?: boolean, project?: string /* record id */ }`; SSE events `status` / `analyzed` / `skipped` / `analyze_error` (all with `{current,total}` where applicable) and terminal `{type:'complete', success:true, analyzed, skipped, errors, total, duration}` or `{type:'error', message}`. UI: "AI analyze" + "AI analyze (force)" items in the existing ⋯ DropdownMenu, reusing the ScanControls SSE reader and progress display.

- [ ] **Step 1: Write the route (house pattern from `src/app/api/scan/route.js`)**

```js
// src/app/api/analyze/route.js
import path from 'path'
import os from 'os'
import { runAnalysisBatch, isAnalysisRunning } from '@/lib/analyze-batch.mjs'
import { ApfelError } from '@/lib/analyzer.mjs'
import { readProjectsData } from '@/lib/projects'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')
const BASE_DIR = process.env.BASE_DIR || path.join(os.homedir(), 'Projekty')

export async function POST(request) {
  const body = await request.json().catch(() => ({}))
  const { force = false, project = null } = body

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      const started = Date.now()
      try {
        if (isAnalysisRunning()) {
          send({ type: 'error', message: 'analysis already running' })
          controller.close()
          return
        }
        let only = null
        if (project) {
          const rec = (await readProjectsData()).find(p => p.id === project)
          if (!rec) {
            send({ type: 'error', message: `unknown project id: ${project}` })
            controller.close()
            return
          }
          only = [rec.directory]
        }
        send({ type: 'status', message: project ? 'Re-analyzing project…' : 'Starting AI analysis…' })
        const summary = await runAnalysisBatch({
          dataFile: DATA_FILE, baseDir: BASE_DIR,
          force: force || Boolean(project), only,
          onProgress: send,
        })
        send({ type: 'complete', success: true, ...summary, duration: Date.now() - started })
      } catch (err) {
        const message = err instanceof ApfelError && err.kind === 'unavailable'
          ? 'Apple model unavailable — is apfel installed and Apple Intelligence enabled?'
          : err.message
        send({ type: 'error', message, duration: Date.now() - started })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

- [ ] **Step 2: Wire the ⋯ menu in ScanControls.js**

In `handleScan(type)`, extend the endpoint map: `'analyze'` and `'analyze-force'` → `/api/analyze` with body `{}` / `{force:true}`. The SSE reader and `handleProgressEvent` are shared; extend the progress switch: treat `analyzed`/`skipped`/`analyze_error` like the scan's per-project events (update `scanStats {current,total}` from the event; message = `project_name`; count `analyze_error` into the log list the way scan errors are shown). On `complete`, existing behavior (`router.refresh()`) is enough — no process re-dispatch needed for analysis; guard the existing `stow:processes` dispatch so it only fires when `data.processes` exists (it already does for quick scan — verify, don't duplicate).

Add to the existing `DropdownMenuContent` after "Force rescan":

```jsx
<DropdownMenuSeparator />
<DropdownMenuItem onClick={() => handleScan('analyze')}>
  AI analyze
</DropdownMenuItem>
<DropdownMenuItem onClick={() => handleScan('analyze-force')}>
  AI analyze (force)
</DropdownMenuItem>
```

(`DropdownMenuSeparator` — import from the same `@/components/ui/dropdown-menu` module if not already imported.)

- [ ] **Step 3: Live verification (dev server)**

Start the dev server (`preview_start` config or `npm run dev`, port 3089) and:
1. `curl -N -X POST http://localhost:3089/api/analyze -H 'content-type: application/json' -d '{"project":"<id of codewars from the JSONL>"}'` → SSE frames ending in `complete` with `analyzed:1` (or `skipped:1` if hash-cached and not forced — force is implied for single project, so expect `analyzed:1`).
2. In the UI: ⋯ menu shows both items; clicking "AI analyze" streams progress in the same progress area as scans (most projects `skipped` fast, unanalyzed ones tick through).
3. Confirm a second POST during a running batch returns the `already running` error frame.

- [ ] **Step 4: Full suite + commit**

```bash
npm test
git add src/app/api/analyze/route.js src/components/ScanControls.js
git commit -m "feat: /api/analyze SSE endpoint and AI analyze menu entries"
```

---

## Self-Review Notes

- **Spec coverage (phase 1):** batch pipeline (Task 3), JSONL enrichment + durability across rescans (Tasks 1, 3), `/api/analyze` + progress UI (Task 5), scanner `last_code_modified` + status fallback (Tasks 1, 2), version-aware incremental cache (Task 2 — reviewer recommendation from phase 0 folded in). Full-corpus first run (~30–45 min) is a user-triggered action via CLI or menu, not a plan step.
- **Type consistency:** `ai_derived` is the JSONL sibling key everywhere; `runAnalysisBatch` returns `{analyzed, skipped, errors, total, durationMs}` and the route re-exposes it in `complete`; `needsAnalysis(record, hash)` takes the whole record (reads `record.ai_analysis`).
- **Known accepted costs:** duplicate `gatherFacts`/`distillProject` per analyzed project (skip-check + analyzer internal); per-project full-file rewrite (1121 lines, trivial); SSE-inline batch can outlive a disconnected client (house pattern, single-user app).
