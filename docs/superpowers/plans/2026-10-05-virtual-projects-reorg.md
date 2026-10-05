# Virtuálne projekty 4/6: Reorg report nad registrom (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Reorg report on the virtual-project register. It suggests four kinds of cleanup: client project outside `_Bizz/<Client>`, stale copies, abandoned experiments and orphans. The default action changes only the register. A physical move is offered as the exception, with a dry-run, and it migrates every path-keyed link (cc-sessions.db, `~/.claude/projects/<slug>` incl. memory, Codex/usage via a durable alias table).

**Architecture:**
- Detection is a pure function over register + ledger rows (`src/lib/reorg.mjs`), and virtual actions are thin calls into #8's register writer (`src/lib/reorg-apply.mjs`).
- Physical moves are a plan/execute pair with a journal and rollback (`src/lib/relocate.mjs`).
- Durability comes from an append-only `data/path-moves.json`, applied wherever a cwd is mapped to a project (cc ingest, usage aggregation). Third-party history files are never edited.

**Tech Stack:** Node ≥ 24 ESM (`.mjs`), `node:sqlite`, `node --test` + `node:assert/strict`, Next.js 16 route handlers, React 19 + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-05-virtual-projects-reorg-design.md`

## Global Constraints

- **Blocked on #8 and #9.** Do Task 0 first; no other task starts until it is done.
- All state paths via `src/lib/state-dir.mjs` (`dataFile()`, `ledgerFile()`), resolved **at call time**, never at module eval.
- Every subprocess or fs side effect goes through an injectable `deps`/`exec`; tests never need git, lsof, docker or the real `~`.
- Tests are colocated as `<module>.test.mjs`; tests that touch the fs use `mkdtemp` and clean up.
- Never edit Claude transcripts (`~/.claude/projects/**/*.jsonl` content), Codex rollouts or `~/.claude.json`.
- The physical move is never the default button, and never runs without a matching `planHash` from a dry-run.
- `STALE_COPY_MONTHS` default `6`. Abandoned = `ai_derived.status ∈ {dead, archive-candidate}`.
- With an empty or missing `path-moves.json`, ingest and usage output must be byte-identical to today.
- `npm test` and `npm run lint` must pass after every task.

## Review Focus

1. **Path prefix boundary**: `/P/foo` must not match `/P/foobar` (moves, slug-folder selection, DB rewrite). Tested in Task 1 and Task 5.
2. **Usage double count after a move**: renamed transcript files must not appear as both a `missing` ghost and a new file. Tested in Task 6 (`usage-cache rekey keeps offset, no ghost`).
3. **Re-ingest undoes the move**: `cc:ingest --full` after a move must still show the new path. Tested in Task 2.
4. **Partial failure**: an error in step N leaves disk, DB, cache and ledger as before. Tested in Task 6 by injecting a failure at every step.
5. **Claude Code already used in the target folder**: the target slug exists, so merge, and a file-name collision is a blocker. Tested in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/path-moves.mjs` (new) | load/append `data/path-moves.json`, `resolveMovedPath` |
| `src/lib/reorg.mjs` (new) | pure detection: `buildReorgReport` |
| `src/lib/reorg-dismissed.mjs` (new) | dismissal store + fingerprint |
| `src/lib/reorg-apply.mjs` (new) | virtual actions → #8 writer (the only #8 writer import besides relocate) |
| `src/lib/claude-project-dirs.mjs` (new) | find `~/.claude/projects/*` folders by transcript cwd, `claudeSlug()` |
| `src/lib/relocate.mjs` (new) | `planRelocation`, `executeRelocation`, journal, rollback |
| `src/lib/cc/ingest-run.mjs` (modify) | apply aliases to `project_dir`/`cwd` |
| `src/lib/usage.mjs` (modify) | `aggregateUsage(cache, projectDirs, moves = [])` |
| `scripts/relocate.mjs` (new) + `package.json` | CLI, dry-run by default |
| `src/app/api/reorg/route.js`, `apply/`, `dismiss/`, `relocate/` (new) | HTTP |
| `src/components/ReorgReportDialog.js` (rewrite), `src/app/project-table.js` (modify) | UI |
| `CLAUDE.md` | docs |

---

### Task 0: Rebase on #8/#9 and pin the contract

**Files:**
- Modify: this plan + spec (the "Contract assumed" table)

- [ ] **Step 1:** `git fetch && git rebase origin/main`. Confirm that #8 and #9 are merged (`gh pr list --state merged --label virtual-projects`).
- [ ] **Step 2:** Read #8's register module and fill in the real names for these:

| Assumed | Actual |
|---|---|
| `loadRegister()` / `saveRegister(reg)` | |
| `project.client`, `project.client_source` | |
| `project.locations[].{directory, role, primary}` | |
| `row.project_id`, `row.checkout.root` | |
| `setProjectClient`, `setLocationRole` | |
| `removeProject`, `relocateLocation`, `setProjectArchived` | |

- [ ] **Step 3:** For each writer that #8 doesn't ship (likely `removeProject`, `relocateLocation`, `setProjectArchived`), stop and ask in the PR. Don't add them to #8's module from here. If the owner agrees, they go into #8's module as a separate commit titled `feat(register): …`, with tests in #8's test file.
- [ ] **Step 4:** Replace every assumed name in this plan's code blocks with the actual ones. Commit: `docs: pin #11 plan to the merged register contract`.

---

### Task 1: Path-move alias table

**Files:**
- Create: `src/lib/path-moves.mjs`
- Test: `src/lib/path-moves.test.mjs`

**Interfaces:**
- Produces:
  - `resolveMovedPath(p: string|null, moves: Move[]) → string|null`
  - `loadPathMoves({file?}) → Promise<Move[]>` (missing → `[]`; malformed → throws `PathMovesError`)
  - `appendPathMove(move, {file?}) → Promise<void>`
  - `removePathMove(id, {file?})`
  - `Move = { id, from, to, at }`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveMovedPath, loadPathMoves, appendPathMove, removePathMove, PathMovesError } from './path-moves.mjs'

const M = (from, to, id = from) => ({ id, from, to, at: '2026-10-05T00:00:00Z' })

test('exact and nested paths are rewritten', () => {
  const moves = [M('/P/old', '/P/_Bizz/Acme/old')]
  assert.equal(resolveMovedPath('/P/old', moves), '/P/_Bizz/Acme/old')
  assert.equal(resolveMovedPath('/P/old/src/x', moves), '/P/_Bizz/Acme/old/src/x')
})

test('prefix needs a path boundary', () => {
  assert.equal(resolveMovedPath('/P/oldish', [M('/P/old', '/Q')]), '/P/oldish')
})

test('chained moves resolve in order', () => {
  assert.equal(resolveMovedPath('/a/x', [M('/a', '/b'), M('/b', '/c')]), '/c/x')
})

test('null and no moves pass through', () => {
  assert.equal(resolveMovedPath(null, [M('/a', '/b')]), null)
  assert.equal(resolveMovedPath('/a', []), '/a')
})

test('load: missing → [], malformed → PathMovesError, append/remove round-trip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pm-'))
  const file = path.join(dir, 'path-moves.json')
  try {
    assert.deepEqual(await loadPathMoves({ file }), [])
    await appendPathMove(M('/a', '/b', 'm1'), { file })
    await appendPathMove(M('/b', '/c', 'm2'), { file })
    assert.deepEqual((await loadPathMoves({ file })).map(m => m.id), ['m1', 'm2'])
    await removePathMove('m2', { file })
    assert.deepEqual((await loadPathMoves({ file })).map(m => m.id), ['m1'])
    await writeFile(file, '{nope')
    await assert.rejects(loadPathMoves({ file }), PathMovesError)
    await assert.rejects(appendPathMove(M('/x', '/y'), { file }), PathMovesError)
    assert.equal(await readFile(file, 'utf8'), '{nope') // never overwritten
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2:** Run `node --test src/lib/path-moves.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement**

```js
// Durable record of physical project moves (#11). Append-only; consumers map
// an old cwd to its current location so a re-ingest/rebuild can't undo a move.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { dataFile } from './state-dir.mjs'

export class PathMovesError extends Error {}

export function resolveMovedPath(p, moves) {
  if (typeof p !== 'string' || !moves?.length) return p
  let out = p
  for (const { from, to } of moves) {
    if (out === from) out = to
    else if (out.startsWith(from + '/')) out = to + out.slice(from.length)
  }
  return out
}

const fileOf = (opts) => opts?.file ?? dataFile('path-moves.json')

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
    throw new PathMovesError(`path-moves.json is malformed: ${e.message}`)
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
```

- [ ] **Step 4:** Run the test again. Expected: PASS. Then run `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `git add src/lib/path-moves.* && git commit -m "feat(reorg): durable path-move alias table"`

---

### Task 2: Apply aliases in cc ingest and usage aggregation

**Files:**
- Modify: `src/lib/cc/ingest-run.mjs` (`ingestAll`, where Claude/Codex/Gemini rows are upserted)
- Modify: `src/lib/usage.mjs:621` (`aggregateUsage`) and its caller `updateUsage`
- Test: `src/lib/cc/ingest-run.test.mjs`, `src/lib/usage.test.mjs`

**Interfaces:**
- Consumes: `resolveMovedPath`, `loadPathMoves` (Task 1)
- Produces:
  - `ingestAll({ …, moves })`: optional; defaults to `await loadPathMoves()`; a `PathMovesError` is rethrown, so it isn't silently ignored
  - `aggregateUsage(cache, projectDirs, moves = [])`
  - `updateUsage({ …, moves })`: defaults to `loadPathMoves()`

- [ ] **Step 1: Failing tests.** In `usage.test.mjs`:

```js
test('aggregateUsage maps a moved cwd to the new project dir', () => {
  const cache = { files: { '/t/a.jsonl': { tool: 'claude', state: { ...newFileState('claude'), cwd: '/P/old/src', models: { 'claude-sonnet-5-5': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } } } } }
  const agg = aggregateUsage(cache, ['/P/_Bizz/Acme/old'], [{ id: 'm', from: '/P/old', to: '/P/_Bizz/Acme/old', at: 'x' }])
  assert.ok(agg.projects['/P/_Bizz/Acme/old'])
  assert.equal(agg.unmatched.sessions, 0)
})

test('aggregateUsage without moves is unchanged', () => {
  const cache = { files: { '/t/a.jsonl': { tool: 'claude', state: { ...newFileState('claude'), cwd: '/P/x', models: { 'claude-sonnet-5-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } } } } }
  assert.deepEqual(aggregateUsage(cache, ['/P/x']), aggregateUsage(cache, ['/P/x'], []))
})
```

(Use the exact `models` state shape the existing `usage.test.mjs` fixtures use; copy one of them rather than the literal above if it differs.)

In `ingest-run.test.mjs`, extend the existing temp-home fixture. Write a transcript whose lines carry `cwd: '/P/old'`, run `ingestAll({ …, moves: [{ id:'m', from:'/P/old', to:'/P/new', at:'x' }], full: true })` and assert `project_dir === '/P/new'` and `cwd === '/P/new'`. Run it a second time with `full: true` and assert it's still `/P/new` (Review Focus 3).

- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `aggregateUsage`:

```js
export function aggregateUsage(cache, projectDirs, moves = []) {
  …
    const cwd = resolveMovedPath(st.cwd, moves)
    if (typeof cwd === 'string') {
      let dir = dirs.find(d => cwd === d || cwd.startsWith(d + '/'))
      if (!dir && Array.isArray(st.geminiPaths)) {
        const gp = st.geminiPaths.map(p => resolveMovedPath(p, moves))
        dir = dirs.find(d => gp.some(p => p === d || p.startsWith(d + '/')))
      }
```

In `updateUsage`, add the `moves` param, default it with `moves ??= await loadPathMoves()`, and pass it through. In `ingestAll`, before each `upsertSession(db, row)` (Claude, Codex, Gemini paths), add a one-liner helper:

```js
const relocate = (row) => moves.length ? { ...row, project_dir: resolveMovedPath(row.project_dir, moves), cwd: resolveMovedPath(row.cwd, moves) } : row
```

- [ ] **Step 4:** Run the two files, then `npm test && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(reorg): apply path moves in cc ingest and usage aggregation`

---

### Task 3: Detection rules: `buildReorgReport`

**Files:**
- Create: `src/lib/reorg.mjs`
- Test: `src/lib/reorg.test.mjs`

**Interfaces:**
- Consumes: the register shape from Task 0. Rows carry `project_id`, `checkout.root`, `git_info`, `ai_analysis`, `ai_derived`, `last_modified`, `content_size_bytes`, `file_types`, `scc`.
- Produces:
  - `buildReorgReport({ register, rows, baseDir, now = Date.now(), runningDirs = [], dismissed = {}, staleMonths = 6 }) → { suggestions: Suggestion[], dismissedCount, summary: { 'client-placement', 'stale-copy', abandoned, orphan, unassigned } }`
  - `Suggestion = { id, kind, projectId, projectName, location: string|null, reason: string, evidence: object, fingerprint: string, action: Action, move: {from,to}|null }`
  - `Action = {type:'confirm-client', client} | {type:'set-role', directory, role:'stale'} | {type:'archive-project'} | {type:'remove-project'}`
  - `fingerprintOf(evidence) → string` (stable JSON with sorted keys)

- [ ] **Step 1: Failing tests.** The fixture builder is at the top of the test file:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReorgReport, fingerprintOf } from './reorg.mjs'

const NOW = Date.parse('2026-10-05T00:00:00Z')
const iso = (monthsAgo) => new Date(NOW - monthsAgo * 30.44 * 864e5).toISOString()
const row = (dir, o = {}) => ({
  directory: dir, project_name: dir.split('/').pop(), project_id: o.pid ?? 'p1',
  checkout: { root: dir, subpath: '', git: o.git ?? true },
  last_modified: iso(o.age ?? 0),
  git_info: { uncommitted_changes: o.dirty ?? 0, ahead: o.ahead ?? 0, behind: o.behind ?? 0, last_total_commit_date: iso(o.age ?? 0), remotes: [] },
  ai_analysis: o.ai ?? null, ai_derived: o.derived ?? null, scc: { total_code: o.code ?? 100 },
  content_size_bytes: o.size ?? 1000, file_types: o.types ?? { js: 3 },
})
const project = (id, locations, o = {}) => ({ id, client: o.client ?? null, client_source: o.source ?? null, locations, ...o.extra })
const loc = (directory, role = null, primary = false) => ({ directory, role, primary })
const B = '/P'
const kinds = (r) => r.suggestions.map(s => `${s.kind}:${s.location ?? ''}`)

test('client project outside _Bizz/<Client> is suggested with confirm-client + move', () => {
  const reg = { projects: [project('p1', [loc('/P/_Work/blog', 'primary', true)], { client: 'InteliMail', source: 'gitlab-group' })] }
  const r = buildReorgReport({ register: reg, rows: [row('/P/_Work/blog')], baseDir: B, now: NOW })
  const s = r.suggestions[0]
  assert.equal(s.kind, 'client-placement')
  assert.deepEqual(s.action, { type: 'confirm-client', client: 'InteliMail' })
  assert.deepEqual(s.move, { from: '/P/_Work/blog', to: '/P/_Bizz/InteliMail/blog' })
})

test('client placement: case-insensitive match, manual client skipped, existing target → no move', () => {
  const ok = { projects: [project('p1', [loc('/P/_Bizz/intelimail/blog', 'primary', true)], { client: 'InteliMail', source: 'path' })] }
  assert.equal(buildReorgReport({ register: ok, rows: [row('/P/_Bizz/intelimail/blog')], baseDir: B, now: NOW }).suggestions.length, 0)
  const manual = { projects: [project('p1', [loc('/P/x/blog', 'primary', true)], { client: 'InteliMail', source: 'manual' })] }
  assert.equal(buildReorgReport({ register: manual, rows: [row('/P/x/blog')], baseDir: B, now: NOW }).suggestions.length, 0)
  const taken = { projects: [project('p1', [loc('/P/x/blog', 'primary', true)], { client: 'Acme', source: 'ai' })] }
  const r = buildReorgReport({ register: taken, rows: [row('/P/x/blog')], baseDir: B, now: NOW, exists: (p) => p === '/P/_Bizz/Acme/blog' })
  assert.equal(r.suggestions[0].move, null)
})

test('stale copy: old clean non-primary qualifies; dirty, ahead, deploy, recent do not', () => {
  const reg = { projects: [project('p1', [
    loc('/P/blog', 'primary', true), loc('/P/blog-old'), loc('/P/blog-dirty'),
    loc('/P/blog-ahead'), loc('/P/blog-deploy', 'deploy'), loc('/P/blog-recent'),
  ])] }
  const rows = [row('/P/blog'), row('/P/blog-old', { age: 9 }), row('/P/blog-dirty', { age: 9, dirty: 2 }),
    row('/P/blog-ahead', { age: 9, ahead: 1 }), row('/P/blog-deploy', { age: 9 }), row('/P/blog-recent', { age: 2 })]
  const r = buildReorgReport({ register: reg, rows, baseDir: B, now: NOW })
  assert.deepEqual(kinds(r), ['stale-copy:/P/blog-old'])
  assert.deepEqual(r.suggestions[0].action, { type: 'set-role', directory: '/P/blog-old', role: 'stale' })
  assert.equal(r.suggestions[0].move, null)
})

test('stale copy without git needs an identical size and type mix', () => {
  const reg = { projects: [project('p1', [loc('/P/a', 'primary', true), loc('/P/a-copy'), loc('/P/a-diff')])] }
  const rows = [row('/P/a', { git: false }), row('/P/a-copy', { git: false, age: 9 }), row('/P/a-diff', { git: false, age: 9, size: 5 })]
  assert.deepEqual(kinds(buildReorgReport({ register: reg, rows, baseDir: B, now: NOW })), ['stale-copy:/P/a-copy'])
})

test('abandoned: experiment + dead, not when running', () => {
  const reg = { projects: [project('p1', [loc('/P/_AI/toy', 'primary', true)])] }
  const rows = [row('/P/_AI/toy', { ai: { maturity: 'prototype' }, derived: { status: 'dead' } })]
  const r = buildReorgReport({ register: reg, rows, baseDir: B, now: NOW })
  assert.equal(r.suggestions[0].kind, 'abandoned')
  assert.deepEqual(r.suggestions[0].move, { from: '/P/_AI/toy', to: '/P/_Archive/toy' })
  assert.equal(buildReorgReport({ register: reg, rows, baseDir: B, now: NOW, runningDirs: ['/P/_AI/toy'] }).suggestions.length, 0)
  const prod = [row('/P/_AI/toy', { ai: { maturity: 'production' }, derived: { status: 'dead' } })]
  assert.equal(buildReorgReport({ register: reg, rows: prod, baseDir: B, now: NOW }).suggestions.length, 0)
})

test('orphan: project with no locations', () => {
  const reg = { projects: [project('p9', [], { client: 'Acme', source: 'manual' })] }
  const s = buildReorgReport({ register: reg, rows: [], baseDir: B, now: NOW }).suggestions[0]
  assert.equal(s.kind, 'orphan')
  assert.deepEqual(s.action, { type: 'remove-project' })
  assert.equal(s.evidence.manualClient, true)
})

test('dismissal hides a suggestion until its evidence changes', () => {
  const reg = { projects: [project('p1', [loc('/P/blog', 'primary', true), loc('/P/blog-old')])] }
  const rows = [row('/P/blog'), row('/P/blog-old', { age: 9 })]
  const first = buildReorgReport({ register: reg, rows, baseDir: B, now: NOW }).suggestions[0]
  const dismissed = { [first.id]: { at: 'x', fingerprint: first.fingerprint } }
  const again = buildReorgReport({ register: reg, rows, baseDir: B, now: NOW, dismissed })
  assert.equal(again.suggestions.length, 0)
  assert.equal(again.dismissedCount, 1)
  rows[1].git_info.behind = 7
  assert.equal(buildReorgReport({ register: reg, rows, baseDir: B, now: NOW, dismissed }).suggestions.length, 1)
})

test('ids are stable and fingerprints ignore key order', () => {
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }))
})
```

- [ ] **Step 2:** Run `node --test src/lib/reorg.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** (`exists` is injectable, defaulting to `existsSync`; it's the only fs touch):

```js
// Reorg report over the virtual-project register (#11). Pure apart from the
// injectable `exists`; reads only data the scanner/refresh already maintain.
import path from 'node:path'
import { existsSync } from 'node:fs'

const MONTH_MS = 30.44 * 864e5
const EXPERIMENT_MATURITY = new Set(['idea', 'prototype', 'abandoned-wip'])
const ABANDONED_STATUS = new Set(['dead', 'archive-candidate'])
const NOT_STALE_ROLES = new Set(['stale', 'deploy', 'experiment'])

export function fingerprintOf(evidence) {
  const sort = (v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v
  return JSON.stringify(sort(evidence))
}

const lastActivity = (r) => Math.max(...[r?.git_info?.last_total_commit_date, r?.last_modified]
  .map(d => Date.parse(d)).filter(Number.isFinite), 0)
const under = (dir, parent) => dir.toLowerCase() === parent.toLowerCase() || dir.toLowerCase().startsWith(parent.toLowerCase() + '/')

export function buildReorgReport({ register, rows, baseDir, now = Date.now(), runningDirs = [], dismissed = {}, staleMonths = 6, exists = existsSync }) {
  const rootRow = new Map()
  for (const r of rows || []) if (r.checkout?.subpath === '' || !rootRow.has(r.checkout?.root ?? r.directory)) rootRow.set(r.checkout?.root ?? r.directory, r)
  const running = (dir) => runningDirs.some(d => d === dir || d.startsWith(dir + '/'))
  const out = []
  const push = (s) => out.push({ ...s, id: `${s.kind}:${s.projectId}:${s.location ?? ''}`, fingerprint: fingerprintOf(s.evidence) })
  let unassigned = 0

  for (const p of register?.projects || []) {
    const name = p.name ?? null
    if (!p.client) unassigned++
    if (!p.locations?.length) {
      push({ kind: 'orphan', projectId: p.id, projectName: name, location: null,
        reason: 'No checkout of this project exists any more',
        evidence: { manualClient: p.client_source === 'manual', roles: [], lastDirectories: p.last_directories ?? [] },
        action: { type: 'remove-project' }, move: null })
      continue
    }
    const primary = p.locations.find(l => l.primary) ?? p.locations[0]
    const pRow = rootRow.get(primary.directory)

    if (p.client && p.client_source !== 'manual' && !(p.client_source === 'ai' && pRow?.ai_analysis?.confidence === 'low')) {
      const want = path.join(baseDir, '_Bizz', p.client)
      if (!under(primary.directory, want)) {
        const to = path.join(want, path.basename(primary.directory))
        push({ kind: 'client-placement', projectId: p.id, projectName: name ?? pRow?.project_name, location: primary.directory,
          reason: `Client ${p.client} (${p.client_source}), but not under _Bizz/${p.client}`,
          evidence: { client: p.client, source: p.client_source, directory: primary.directory },
          action: { type: 'confirm-client', client: p.client }, move: exists(to) ? null : { from: primary.directory, to } })
      }
    }

    for (const l of p.locations) {
      if (l === primary || NOT_STALE_ROLES.has(l.role)) continue
      const r = rootRow.get(l.directory)
      if (!r || !pRow) continue
      const gi = r.git_info || {}
      const safe = r.checkout?.git
        ? (gi.uncommitted_changes ?? 1) === 0 && (gi.ahead ?? 1) === 0
        : r.content_size_bytes === pRow.content_size_bytes && fingerprintOf(r.file_types) === fingerprintOf(pRow.file_types)
      const gap = (lastActivity(pRow) - lastActivity(r)) / MONTH_MS
      if (!safe || gap < staleMonths) continue
      push({ kind: 'stale-copy', projectId: p.id, projectName: name ?? pRow.project_name, location: l.directory,
        reason: `Clean copy, ${Math.round(gap)} months behind the primary`,
        evidence: { behind: gi.behind ?? null, ahead: gi.ahead ?? null, uncommitted: gi.uncommitted_changes ?? null,
          lastActivity: new Date(lastActivity(r)).toISOString(), primaryLastActivity: new Date(lastActivity(pRow)).toISOString() },
        action: { type: 'set-role', directory: l.directory, role: 'stale' }, move: null })
    }

    const ai = pRow?.ai_analysis
    const experiment = primary.role === 'experiment' || EXPERIMENT_MATURITY.has(ai?.maturity) || ai?.project_type === 'prototype-poc'
    if (!p.archived && experiment && ABANDONED_STATUS.has(pRow?.ai_derived?.status) && !p.locations.some(l => running(l.directory))) {
      const to = path.join(baseDir, '_Archive', path.basename(primary.directory))
      push({ kind: 'abandoned', projectId: p.id, projectName: name ?? pRow.project_name, location: primary.directory,
        reason: `Experiment, ${pRow.ai_derived.status}`,
        evidence: { status: pRow.ai_derived.status, maturity: ai?.maturity ?? null, role: primary.role ?? null, code: pRow.scc?.total_code ?? 0 },
        action: { type: 'archive-project' }, move: exists(to) ? null : { from: primary.directory, to } })
    }
  }

  const visible = out.filter(s => dismissed[s.id]?.fingerprint !== s.fingerprint)
  const summary = { 'client-placement': 0, 'stale-copy': 0, abandoned: 0, orphan: 0, unassigned }
  for (const s of visible) summary[s.kind]++
  return { suggestions: visible, dismissedCount: out.length - visible.length, summary }
}
```

Ordering: add a final sort by kind order (`client-placement, stale-copy, abandoned, orphan`), then within each kind client-placement by `scc.total_code` desc, stale by age gap desc, and abandoned by code asc. Add an `ordering` test with three client-placement projects of different code sizes.

- [ ] **Step 4:** Run the tests until they PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): register-based reorg detection rules`

---

### Task 4: Dismissals and virtual actions

**Files:**
- Create: `src/lib/reorg-dismissed.mjs`, `src/lib/reorg-apply.mjs`
- Test: `src/lib/reorg-dismissed.test.mjs`, `src/lib/reorg-apply.test.mjs`

**Interfaces:**
- Consumes: the #8 writers named in Task 0; `Suggestion`/`Action` from Task 3
- Produces:
  - `loadDismissed({file?}) → Promise<Record<id,{at,fingerprint}>>` (missing/malformed → `{}`)
  - `dismiss(id, fingerprint, {file?, now?})`, `undismiss(id, {file?})`
  - `applyAction(action, { projectId }, writers = defaultWriters) → Promise<void>`. `writers` is injectable, a `{ setProjectClient, setLocationRole, setProjectArchived, removeProject }` object, and the default imports #8's module.

- [ ] **Step 1: Failing tests.**

```js
// reorg-apply.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction } from './reorg-apply.mjs'

const spy = () => { const calls = []; const f = (name) => async (arg) => { calls.push([name, arg]) }
  return { calls, writers: { setProjectClient: f('client'), setLocationRole: f('role'), setProjectArchived: f('archive'), removeProject: f('remove') } } }

test('each action maps to exactly one writer call', async () => {
  const { calls, writers } = spy()
  await applyAction({ type: 'confirm-client', client: 'Acme' }, { projectId: 'p1' }, writers)
  await applyAction({ type: 'set-role', directory: '/P/x', role: 'stale' }, { projectId: 'p1' }, writers)
  await applyAction({ type: 'archive-project' }, { projectId: 'p1' }, writers)
  await applyAction({ type: 'remove-project' }, { projectId: 'p1' }, writers)
  assert.deepEqual(calls, [
    ['client', { projectId: 'p1', client: 'Acme', source: 'manual' }],
    ['role', { directory: '/P/x', role: 'stale' }],
    ['archive', { projectId: 'p1', archived: true }],
    ['remove', { projectId: 'p1' }],
  ])
})

test('unknown action type is rejected', async () => {
  await assert.rejects(applyAction({ type: 'mv' }, { projectId: 'p1' }, spy().writers), /unknown reorg action/)
})
```

```js
// reorg-dismissed.test.mjs: mkdtemp; dismiss → load has it with the fingerprint;
// undismiss removes it; a malformed file loads as {} and the next dismiss rewrites it
// (dismissals are disposable UI state, unlike path-moves).
```

Write the dismissed test out in full: three `test()` blocks for the three behaviours in the comment, each using `mkdtemp` and `rm` in `finally`, the same pattern as Task 1.

- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3: Implement.**

```js
// reorg-apply.mjs: the only place reorg's virtual actions touch the register.
import * as register from './register.mjs' // name pinned in Task 0

const defaultWriters = {
  setProjectClient: register.setProjectClient,
  setLocationRole: register.setLocationRole,
  setProjectArchived: register.setProjectArchived,
  removeProject: register.removeProject,
}

export async function applyAction(action, { projectId }, writers = defaultWriters) {
  switch (action?.type) {
    case 'confirm-client': return writers.setProjectClient({ projectId, client: action.client, source: 'manual' })
    case 'set-role': return writers.setLocationRole({ directory: action.directory, role: action.role })
    case 'archive-project': return writers.setProjectArchived({ projectId, archived: true })
    case 'remove-project': return writers.removeProject({ projectId })
    default: throw new Error(`unknown reorg action: ${action?.type}`)
  }
}
```

`reorg-dismissed.mjs` uses the same atomic tmp+rename write as Task 1, with `dataFile('reorg-dismissed.json')` resolved at call time, and the value shape `{ version: 1, dismissed: { [id]: { at, fingerprint } } }`.

- [ ] **Step 4:** Run until PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): dismissals and virtual actions via the register writer`

---

### Task 5: `planRelocation` (dry-run) and Claude project-folder discovery

**Files:**
- Create: `src/lib/claude-project-dirs.mjs`, `src/lib/relocate.mjs` (plan half)
- Test: `src/lib/claude-project-dirs.test.mjs`, `src/lib/relocate.test.mjs`

**Interfaces:**
- Produces:
  - `claudeSlug(dir) → string` (`dir.replace(/[^A-Za-z0-9-]/g, '-')`; verify it against 3 real folder names in `~/.claude/projects` before committing, e.g. `/Users/ericsko/Projekty/_AgentOffice/erikmeliska/stow-dashboard` → `-Users-ericsko-Projekty--AgentOffice-erikmeliska-stow-dashboard`)
  - `findClaudeProjectDirs(claudeDir, from, { fs }) → Promise<Array<{ dir, slug, cwd, hasMemory, files: string[] }>>`. Selected by the first `cwd` found in any top-level `*.jsonl` (≤ 64 KB read per file), matching `cwd === from || cwd.startsWith(from + '/')`.
  - `planRelocation({ from, to, force = false }, deps) → Promise<Plan>`
  - `Plan = { ok, from, to, blockers: string[], warnings: string[], steps: Step[], planHash }`
  - `Step = { kind: 'move-dir'|'claude-dir'|'db'|'usage-cache'|'alias'|'ledger'|'register', description, detail }`
  - `deps = { fs, exec, homedir, claudeDir, register, rows, store: {count(from)}, usageCache: {keysUnder(dirs)}, processesUnder(dir) → Promise<number> }`. Every field has a real default in `defaultRelocateDeps()`, which tests don't call.

- [ ] **Step 1: Failing tests** (in `relocate.test.mjs`; the fixture builds a temp fake home):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planRelocation } from './relocate.mjs'
import { claudeSlug, findClaudeProjectDirs } from './claude-project-dirs.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'reloc-'))
  const P = path.join(root, 'P'); const claudeDir = path.join(root, 'home/.claude/projects')
  const from = path.join(P, 'blog'); const to = path.join(P, '_Bizz/Acme/blog')
  await mkdir(from, { recursive: true })
  const mkClaude = async (cwd, extra = {}) => {
    const d = path.join(claudeDir, claudeSlug(cwd)); await mkdir(d, { recursive: true })
    await writeFile(path.join(d, 's1.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n')
    if (extra.memory) { await mkdir(path.join(d, 'memory')); await writeFile(path.join(d, 'memory/MEMORY.md'), '- x') }
    return d
  }
  const deps = {
    fs: fsp, claudeDir,
    exec: async (cmd, args) => (args.includes('worktree') ? { stdout: `worktree ${from}\n` } : { stdout: '' }),
    processesUnder: async () => 0,
    register: { projects: [{ id: 'p1', locations: [{ directory: from, role: 'primary', primary: true }] }] },
    rows: [{ directory: from, checkout: { root: from, subpath: '', git: true }, git_info: { uncommitted_changes: 0 } }],
    store: { count: async () => 3 }, usageCache: { keysUnder: async () => ['k1'] },
    stat: fsp.stat,
  }
  return { root, P, from, to, claudeDir, mkClaude, deps, done: () => rm(root, { recursive: true, force: true }) }
}

test('happy path lists every step incl. memory and is ok', async () => {
  const f = await fixture()
  try {
    await f.mkClaude(f.from, { memory: true }); await f.mkClaude(path.join(f.from, 'sub'))
    await f.mkClaude(f.from + 'ish') // must NOT be selected
    const plan = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(plan.ok, true, plan.blockers.join())
    assert.deepEqual(plan.steps.map(s => s.kind), ['move-dir', 'claude-dir', 'claude-dir', 'db', 'usage-cache', 'alias', 'ledger', 'register'])
    assert.match(plan.steps[1].description, /memory/)
    assert.match(plan.planHash, /^[0-9a-f]{64}$/)
  } finally { await f.done() }
})

test('blockers: target exists, not a location, running process, linked worktree, other device', async () => {
  const f = await fixture()
  try {
    await mkdir(f.to, { recursive: true })
    assert.match((await planRelocation({ from: f.from, to: f.to }, f.deps)).blockers.join(), /already exists/)
    await rm(f.to, { recursive: true })
    assert.match((await planRelocation({ from: '/nope', to: f.to }, f.deps)).blockers.join(), /not a register location/)
    assert.match((await planRelocation({ from: f.from, to: f.to }, { ...f.deps, processesUnder: async () => 2 })).blockers.join(), /running/)
    const wt = { ...f.deps, exec: async () => ({ stdout: `worktree ${f.from}\n\nworktree ${f.from}/.agent-office/worktrees/x\n` }) }
    assert.match((await planRelocation({ from: f.from, to: f.to }, wt)).blockers.join(), /worktree/)
    const dev = { ...f.deps, stat: async (p) => ({ dev: p.startsWith(f.from) ? 1 : 2, isDirectory: () => true }) }
    assert.match((await planRelocation({ from: f.from, to: f.to }, dev)).blockers.join(), /device/)
  } finally { await f.done() }
})

test('dirty tree is a warning, blocking only without force', async () => {
  const f = await fixture()
  try {
    f.deps.rows[0].git_info.uncommitted_changes = 4
    const p = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(p.ok, false); assert.match(p.blockers.join(), /uncommitted/)
    assert.equal((await planRelocation({ from: f.from, to: f.to, force: true }, f.deps)).ok, true)
  } finally { await f.done() }
})

test('target Claude folder exists: merge, collision blocks', async () => {
  const f = await fixture()
  try {
    await f.mkClaude(f.from)
    const target = await f.mkClaude(f.to) // also contains s1.jsonl → collision
    assert.match((await planRelocation({ from: f.from, to: f.to }, f.deps)).blockers.join(), /collision.*s1\.jsonl/)
    await rm(path.join(target, 's1.jsonl')); await writeFile(path.join(target, 's2.jsonl'), '')
    const p = await planRelocation({ from: f.from, to: f.to }, f.deps)
    assert.equal(p.ok, true); assert.match(p.steps.find(s => s.kind === 'claude-dir').description, /merge/)
  } finally { await f.done() }
})
```

In `claude-project-dirs.test.mjs`: the slug of 3 sample paths (incl. `_` and `.`), selection by cwd when two folders have colliding-looking slugs (`/P/a_b` vs `/P/a-b` share a slug), a folder with no cwd in any transcript is ignored, and a large first line is read only up to 64 KB.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** `claude-project-dirs.mjs` (readdir, for each sub-dir read the top-level `*.jsonl` files until one yields a `cwd`, compare with a path boundary). Then `planRelocation`:

```js
export async function planRelocation({ from, to, force = false }, deps) {
  const blockers = [], warnings = [], steps = []
  const { fs, stat = fs.stat } = deps
  from = path.resolve(from); to = path.resolve(to)
  const isLoc = deps.register.projects.some(p => p.locations?.some(l => l.directory === from))
  if (!isLoc) blockers.push(`${from} is not a register location`)
  if (await stat(to).then(() => true, () => false)) blockers.push(`${to} already exists`)
  const fromSt = await stat(from).catch(() => null)
  if (!fromSt) blockers.push(`${from} does not exist`)
  const toParentSt = await stat(nearestExistingParent(to, fs)).catch(() => null)
  if (fromSt && toParentSt && fromSt.dev !== toParentSt.dev) blockers.push('source and target are on different devices')
  if (await deps.processesUnder(from) > 0) blockers.push('a process or container is running in this project')
  const wt = await deps.exec('git', ['-C', from, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }))
  const trees = wt.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  if (trees.length > 1) blockers.push(`linked git worktrees exist: ${trees.slice(1).join(', ')}`)
  if (trees.length && trees[0] !== from) blockers.push(`${from} is a linked worktree of ${trees[0]}`)
  const dirty = deps.rows.filter(r => (r.checkout?.root ?? r.directory) === from).some(r => r.git_info?.uncommitted_changes > 0)
  if (dirty) (force ? warnings : blockers).push('uncommitted changes in the working tree')

  steps.push({ kind: 'move-dir', description: `Move ${from} → ${to}`, detail: { from, to } })
  for (const c of await findClaudeProjectDirs(deps.claudeDir, from, { fs })) {
    const newCwd = to + c.cwd.slice(from.length)
    const target = path.join(deps.claudeDir, claudeSlug(newCwd))
    const existing = await fs.readdir(target).catch(() => null)
    const clash = existing ? c.files.filter(f => existing.includes(f)) : []
    if (clash.length) blockers.push(`Claude folder collision in ${target}: ${clash.join(', ')}`)
    steps.push({ kind: 'claude-dir', description: `${existing ? 'Merge' : 'Rename'} Claude project folder ${c.slug} → ${claudeSlug(newCwd)}${c.hasMemory ? ' (incl. memory/)' : ''}`,
      detail: { src: c.dir, dest: target, merge: !!existing, files: c.files } })
  }
  steps.push({ kind: 'db', description: `Rewrite ${await deps.store.count(from)} sessions in cc-sessions.db`, detail: { from, to } })
  steps.push({ kind: 'usage-cache', description: 'Re-key usage-cache entries of renamed transcripts', detail: {} })
  steps.push({ kind: 'alias', description: `Record ${from} → ${to} in path-moves.json (Codex rollouts and transcripts resolve through it)`, detail: { from, to } })
  steps.push({ kind: 'ledger', description: 'Update ledger rows under the project', detail: { from, to } })
  steps.push({ kind: 'register', description: 'Point the register location at the new path', detail: { from, to } })
  warnings.push('~/.claude.json per-project settings (trust, allowed tools, MCP) are keyed by path and are not migrated')

  const planHash = createHash('sha256').update(JSON.stringify({ from, to, steps })).digest('hex')
  return { ok: blockers.length === 0, from, to, blockers, warnings, steps, planHash }
}
```

(`nearestExistingParent` walks `path.dirname` until `stat` succeeds. Put it in the same file with a one-line test.)

- [ ] **Step 4:** Run until PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): relocation dry-run planner with Claude project-folder discovery`

---

### Task 6: `executeRelocation`: journal, steps and rollback

**Files:**
- Modify: `src/lib/relocate.mjs`
- Test: `src/lib/relocate.test.mjs` (extend)

**Interfaces:**
- Consumes: `Plan` (Task 5), `appendPathMove`/`removePathMove` (Task 1), `openStore` (`src/lib/cc/store.mjs`), the #8 `relocateLocation` writer (Task 0)
- Produces:
  - `executeRelocation({ from, to, planHash, force }, deps) → Promise<{ ok, done: string[], failed?: {kind, error}, rolledBack: boolean, journal }>`. It re-plans, refuses on a hash mismatch or `!ok`, and holds the ingest lock.
  - `resumeRelocation(journalFile, deps)`: replays the `done` list in reverse (rollback). Resuming forwards is out of scope (Q8).
  - Step implementations as `STEPS[kind] = { run(detail, ctx), undo(detail, ctx) }`:
    - `move-dir`: `fs.rename(from, to)` after `mkdir(dirname(to))`; undo renames back
    - `claude-dir`: rename the folder, or merge by moving each file; undo reverses using the recorded file list
    - `db`: a single `BEGIN … COMMIT` covering the SQL below; undo runs the inverse statements with from/to swapped:
      ```sql
      UPDATE sessions SET project_dir = :to || substr(project_dir, length(:from)+1) WHERE project_dir = :from OR project_dir LIKE :from || '/%';
      UPDATE sessions SET cwd = :to || substr(cwd, length(:from)+1) WHERE cwd = :from OR cwd LIKE :from || '/%';
      UPDATE sessions SET raw_ref = :newDir || substr(raw_ref, length(:oldDir)+1) WHERE raw_ref LIKE :oldDir || '/%';  -- per claude-dir step
      UPDATE subagents SET raw_ref = …same…;
      UPDATE ingest_state SET path = …same…;
      ```
      Escape `%`/`_` in `LIKE` (`ESCAPE '\'`). That's needed: folder names here contain `_`.
    - `usage-cache`: load `dataFile('usage-cache.json')`, rename keys under each renamed folder, keep the entries untouched, atomic write; undo swaps back
    - `alias`: `appendPathMove({ id, from, to, at })`; undo `removePathMove(id)`
    - `ledger`: rewrite `directory` and `checkout.root` of rows under `from` (read `ledgerFile()`, atomic write); undo swaps back
    - `register`: `relocateLocation({ from, to })`; undo `relocateLocation({ from: to, to: from })`
  - Journal: `dataFile('relocations/<isoTs>-<id>.json')` = `{ plan, done: [kind…], status: 'running'|'ok'|'rolled-back'|'rollback-failed' }`, rewritten after every step.

- [ ] **Step 1: Failing tests.**

```js
test('execute: moves dir, renames Claude folder incl. memory, rewrites db/cache/ledger, records alias', async () => {
  const f = await fixture(); const env = await withStateDir(f) // temp STOW state dir: ledger, usage-cache, cc-sessions.db
  try {
    const cdir = await f.mkClaude(f.from, { memory: true })
    await env.seedSession({ session_id: 's1', project_dir: f.from, cwd: f.from, raw_ref: path.join(cdir, 's1.jsonl') })
    await env.seedUsageCache({ [path.join(cdir, 's1.jsonl')]: { tool: 'claude', size: 10, mtimeMs: 1, offset: 10, missing: false, state: { cwd: f.from } } })
    const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, env.deps)
    assert.equal(res.ok, true)
    const newDir = path.join(f.claudeDir, claudeSlug(f.to))
    assert.ok(await exists(path.join(newDir, 'memory/MEMORY.md')))
    assert.equal(await exists(cdir), false)
    const s = env.db().prepare('SELECT project_dir, cwd, raw_ref FROM sessions WHERE session_id = ?').get('s1')
    assert.deepEqual({ ...s }, { project_dir: f.to, cwd: f.to, raw_ref: path.join(newDir, 's1.jsonl') })
    const cache = await env.readUsageCache()
    assert.deepEqual(Object.keys(cache.files), [path.join(newDir, 's1.jsonl')])
    assert.equal(cache.files[path.join(newDir, 's1.jsonl')].offset, 10) // no re-parse, no ghost
    assert.equal((await env.readLedger())[0].directory, f.to)
    assert.deepEqual((await loadPathMoves({ file: env.movesFile })).map(m => [m.from, m.to]), [[f.from, f.to]])
  } finally { await env.done(); await f.done() }
})

for (const failAt of ['move-dir', 'claude-dir', 'db', 'usage-cache', 'alias', 'ledger', 'register']) {
  test(`failure at ${failAt} rolls everything back`, async () => {
    const f = await fixture(); const env = await withStateDir(f)
    try {
      await f.mkClaude(f.from, { memory: true })
      const before = await env.snapshot() // tree listing of P + claudeDir, db rows, cache, ledger, moves
      const plan = await planRelocation({ from: f.from, to: f.to }, env.deps)
      const res = await executeRelocation({ from: f.from, to: f.to, planHash: plan.planHash }, { ...env.deps, failAt })
      assert.equal(res.ok, false); assert.equal(res.rolledBack, true); assert.equal(res.failed.kind, failAt)
      assert.deepEqual(await env.snapshot(), before)
    } finally { await env.done(); await f.done() }
  })
}

test('stale planHash is refused', async () => {
  const f = await fixture(); const env = await withStateDir(f)
  try {
    const res = await executeRelocation({ from: f.from, to: f.to, planHash: 'x'.repeat(64) }, env.deps)
    assert.equal(res.ok, false); assert.match(res.failed.error, /plan changed/)
  } finally { await env.done(); await f.done() }
})

test('LIKE escaping: an underscore in the path does not match a sibling', async () => { /* seed /P/a_b and /P/aXb sessions, move /P/a_b, assert /P/aXb untouched */ })
```

Write `withStateDir(f)` at the top of the test file:
- it creates `<root>/state/data/`, writes a one-row ledger for `f.from`, opens a file DB via `openStore({ file })`, and writes an empty usage cache
- it returns `deps` = `f.deps` plus `{ stateOpts: { env: { STOW_STATE_DIR: <root>/state } }, openStore: () => openStore({ file }), failAt: undefined }` and the helpers it uses (`seedSession`, `seedUsageCache`, `readUsageCache`, `readLedger`, `snapshot`, `db`, `movesFile`, `done`)
- `snapshot()` returns a sorted recursive file listing with contents for the tree + JSON files, and `SELECT * … ORDER BY` for the 3 DB tables

Write the LIKE-escaping test out fully rather than leaving the comment.

`failAt` is a test-only dep: the executor throws `new Error('injected')` when `ctx.deps.failAt === kind` **after** that step's `run` (so the undo of the failing step itself is also exercised).

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** the executor loop:

```js
export async function executeRelocation({ from, to, planHash, force = false }, deps) {
  const plan = await planRelocation({ from, to, force }, deps)
  if (!plan.ok) return { ok: false, done: [], failed: { kind: 'plan', error: plan.blockers.join('; ') }, rolledBack: false }
  if (plan.planHash !== planHash) return { ok: false, done: [], failed: { kind: 'plan', error: 'plan changed since the dry-run, review it again' }, rolledBack: false }
  return withIngestLock(deps, async () => {
    const journal = await openJournal(plan, deps)
    const done = []
    const ctx = { deps, id: journal.id, moved: [] } // claude-dir records old→new folder pairs for db/cache steps
    for (const step of plan.steps) {
      try {
        await STEPS[step.kind].run(step.detail, ctx)
        done.push(step)
        await journal.write({ done: done.map(s => s.kind), status: 'running' })
        if (deps.failAt === step.kind) throw new Error('injected')
      } catch (e) {
        const rb = await rollback(done, ctx)
        await journal.write({ done: done.map(s => s.kind), status: rb ? 'rolled-back' : 'rollback-failed', error: String(e.message) })
        return { ok: false, done: done.map(s => s.kind), failed: { kind: step.kind, error: e.message }, rolledBack: rb, journal: journal.file }
      }
    }
    await journal.write({ done: done.map(s => s.kind), status: 'ok' })
    return { ok: true, done: done.map(s => s.kind), rolledBack: false, journal: journal.file }
  })
}
```

`withIngestLock` awaits `runIngest()`'s in-flight promise when there is one (export a `waitForIngest()` from `ingest-run.mjs` that returns `inFlight ?? Promise.resolve()`). Then it checks `summary_jobs` for a `running` row with a fresh heartbeat and refuses if one exists. Add a test for the refusal using a seeded running job row.

- [ ] **Step 4:** Run until PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): relocation executor with journal and full rollback`

---

### Task 7: CLI `npm run relocate`

**Files:**
- Create: `scripts/relocate.mjs`
- Modify: `package.json` (`"relocate": "node --disable-warning=ExperimentalWarning scripts/relocate.mjs"`)
- Test: `scripts/relocate.test.mjs` (arg parsing + output formatting only; export `parseArgs`, `formatPlan`)

**Interfaces:**
- Consumes: `planRelocation`, `executeRelocation`, `resumeRelocation`, `defaultRelocateDeps({ base: repoRoot })` (like the other CLIs, it passes the repo root to the state-dir helpers)

- [ ] **Step 1: Failing test.**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, formatPlan } from './relocate.mjs'

test('dry-run is the default; --apply opts in', () => {
  assert.deepEqual(parseArgs(['--from', '/a', '--to', '/b']), { from: '/a', to: '/b', apply: false, force: false, resume: null })
  assert.equal(parseArgs(['--from', '/a', '--to', '/b', '--apply']).apply, true)
  assert.throws(() => parseArgs(['--from', '/a']), /--to/)
})

test('formatPlan shows blockers first and numbered steps', () => {
  const out = formatPlan({ ok: false, blockers: ['x exists'], warnings: ['w'], steps: [{ description: 'Move a → b' }] })
  assert.match(out, /BLOCKED[\s\S]*x exists[\s\S]*1\. Move a → b/)
})
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Without `--apply`: print `formatPlan` and exit 0 (2 if blocked).
  - With `--apply`: plan, print, execute with the plan's hash, and print the result and journal path. Exit 1 on failure.
  - `--resume <journal>`: roll back.
  - Guard the main block with `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.
- [ ] **Step 4:** Run until PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): npm run relocate (dry-run by default)`

---

### Task 8: API routes

**Files:**
- Create: `src/app/api/reorg/route.js` (GET), `src/app/api/reorg/apply/route.js` (POST), `src/app/api/reorg/dismiss/route.js` (POST/DELETE), `src/app/api/reorg/relocate/route.js` (POST)
- Create: `src/lib/reorg-service.mjs`, which holds the logic the routes call so it can be tested without Next
- Test: `src/lib/reorg-service.test.mjs`

**Interfaces:**
- Produces (`reorg-service.mjs`, every loader injectable):
  - `getReport({ runningDirs, deps }) → { suggestions, summary, dismissedCount, error? }`. A `PathMovesError` shows up in `error`, and the report is still returned.
  - `applySuggestion({ id, deps })`: rebuilds the report, finds the suggestion by `id` (unknown/stale → 409), calls `applyAction`, returns the new report
  - `dismissSuggestion({ id, undo })`
  - `relocate({ from, to, dryRun, planHash, force, deps })`: `dryRun` → the plan; otherwise execute

- [ ] **Step 1: Failing tests:** `getReport` with injected register/rows returns the Task 3 output; `applySuggestion` with an unknown id rejects with `{ status: 409 }`; `applySuggestion` passes the suggestion's own action (the client can't send an arbitrary action, only an id); `relocate({ dryRun: true })` never calls an executor spy.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each route is a thin `export async function GET/POST(req)` that parses JSON, calls the service and maps `err.status ?? 500` to `NextResponse.json({ error }, { status })`.
  - All loaders (`loadRegister`, the ledger read via `ledgerFile()`, `loadDismissed`) run inside the handler, never at module eval (the compiled desktop app preloads routes; see CLAUDE.md "State Dir").
  - `runningDirs` arrives as a JSON-encoded query param from the client, which already holds the process state.
- [ ] **Step 4:** Run until PASS, then `npm test && npm run lint`.
- [ ] **Step 5: Commit:** `feat(reorg): reorg API (report, apply, dismiss, relocate)`

---

### Task 9: ReorgReportDialog on the register

**Files:**
- Rewrite: `src/components/ReorgReportDialog.js`
- Modify: `src/app/project-table.js:1113` (props: pass `runningDirs` and an `onChanged` that triggers the table's existing refresh)

**Interfaces:**
- Consumes: the Task 8 endpoints
- Produces: `<ReorgReportDialog open onOpenChange projects runningDirs onOpenProject onChanged />`

- [ ] **Step 1:** Fetch `GET /api/reorg` when `open` turns true, and keep `{ loading, error, report }`. If the response says there is no register (`report.legacy === true`, which the service sets when `loadRegister` finds no file), render today's AI-only sections. Move them unchanged into a `LegacyReorgSections` component in the same file, minus the Copy-mv button.
- [ ] **Step 2:** Four sections in kind order. Each section header shows its count from `summary`, and an empty section shows one muted line, the same as today. Each row has:
  - the project name, the location in mono, the reason, and an evidence line (stale: "behind N · last commit X vs primary Y"; abandoned: "N lines, status")
  - the primary button, labelled by action: `Confirm client {client}`, `Mark as stale`, `Archive`, `Remove from register`. It POSTs `/api/reorg/apply { id }`, then replaces the report with the response and calls `onChanged`.
  - `Dismiss` (ghost button) and `Open details` (the Eye button, as today)
  - a `⋯` dropdown containing `Move on disk…`, only when `s.move`
- [ ] **Step 3:** The "Move on disk" panel is a nested `Dialog`:
  - it POSTs `relocate { from, to, dryRun: true }` and renders blockers (destructive colour), warnings, then the numbered steps
  - the confirm button `Move` is disabled while there are blockers. On click it POSTs with `planHash` and shows the result. On `rolledBack` it says so, including the journal path.
  - a `force` checkbox appears only when the only blocker is uncommitted changes
- [ ] **Step 4:** Footer: "{dismissedCount} dismissed", with a link that reloads with `?includeDismissed=1` (the service supports it by passing `dismissed: {}`; add that to Task 8's service and a test if it isn't there yet).
- [ ] **Step 5: Manual check** in `npm run dev` (port 3089) against a state dir with a seeded register:
  - each section renders
  - Confirm client removes the row
  - Dismiss hides it, and it reappears after its evidence changes
  - a move dry-run shows the steps; a blocked plan has a disabled button
  - dark mode, and the dialog at a narrow width

  Run `npm run lint`.
- [ ] **Step 6: Commit:** `feat(reorg): Reorg report dialog on the register, virtual actions first`

---

### Task 10: Docs and the one-project verification

**Files:**
- Modify: `CLAUDE.md`: add `npm run relocate` to Commands, add the new files to "Important Files", and add a short "Reorg & physical moves" subsection (detection rules, virtual default, alias table, what is and isn't migrated, `~/.claude.json` not touched). Add `path-moves.json`, `reorg-dismissed.json` and `relocations/` to the State Dir data list.

- [ ] **Step 1:** Write the docs. Commit: `docs: reorg report and relocation`
- [ ] **Step 2: Verify on one project**, the order the issue asks for. Pick a small throwaway project with ≥ 1 Claude session and some memory.
  1. `npm run relocate -- --from <dir> --to <dir2>` and read the dry-run
  2. Note the AI `$` for the project and the session count on `/sessions?project=…`
  3. `--apply`
  4. `cd <dir2> && claude --resume`: the old sessions are listed and memory is loaded
  5. `/sessions` shows `<dir2>`; the AI `$` is unchanged after `npm run usage`; `npm run cc:ingest -- --full` keeps `<dir2>`
  6. Move it back with the same CLI, and repeat the checks

  Paste the results into the PR description.
- [ ] **Step 3:** Run `npm test && npm run lint` one last time, push, and update the PR (`Closes #11`).

---

## Self-review notes

- Spec coverage:
  - detection (T3), virtual actions (T4), dismissals (T4)
  - alias durability (T1, T2)
  - plan/blockers/Claude folders and memory (T5); execute/rollback/journal/lock (T6)
  - CLI and one-project verification (T7, T10); API (T8); UI (T9); docs (T10)
  - the `~/.claude.json` warning (T5)
  - the legacy fallback (T9 Step 1)
- Review Focus items map to tests: 1 → T1 `prefix needs a path boundary` and T5 `…ish` folder; 2 → T6 `offset 10, keys`; 3 → T2 second `--full`; 4 → T6 `failAt` loop; 5 → T5 merge/collision.
- Names used across tasks: `resolveMovedPath`, `loadPathMoves`, `appendPathMove`, `removePathMove`, `buildReorgReport`, `fingerprintOf`, `applyAction`, `loadDismissed`, `dismiss`, `undismiss`, `claudeSlug`, `findClaudeProjectDirs`, `planRelocation`, `executeRelocation`, `resumeRelocation`, `waitForIngest`.
