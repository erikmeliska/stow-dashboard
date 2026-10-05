# Virtuálne projekty 5/6 — sessions podľa projektu: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session in `data/cc-sessions.db` carries its register project id (`project_key`), the main-checkout dir it belongs to (`base_dir`) and the worktree or scratchpad it ran in (`workspace`). The sessions UI, analytics and MCP group by project instead of by raw directory.

**Architecture:** A pure path resolver (`workspace.mjs`) recognises agent-office and `.claude` worktrees and Claude scratchpads. A resolver with an injectable exec (`project-key.mjs`) adds a memoized git probe for other linked worktrees and maps the base dir to a register project. `assignPlacements` runs once per ingest over **all** rows and writes only the ones that changed. That makes it the backfill and lets it follow register changes. Readers use client-safe helpers (`session-project.mjs`) for the key and the label.

**Tech Stack:** Node ≥ 24 ESM, `node:sqlite`, `node --test` + `node:assert/strict`, Next.js 16 / React 19 client components, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-05-virtual-projects-sessions-by-project-design.md`

## Global Constraints

- `project_key` = **register project id from #8**, never a path. No register match → `null`.
- `workspace` stored as `kind:name`; kinds exactly: `agent-office`, `claude-worktree`, `scratchpad`, `git-worktree`. Displayed as `kind: name` (e.g. `agent-office: pixel-77d1`).
- `project_dir` and `cwd` keep today's meaning. This issue never rewrites them.
- Placement columns (`project_key`, `workspace`, `base_dir`) are **not** in `SESSION_COLS`; `setPlacement` is their only writer.
- State paths only via `src/lib/state-dir.mjs` helpers, resolved at call time (never at module eval).
- Subprocesses via an injectable `exec`. Tests never need git, a real `~/.claude` or a real register.
- Tests colocated as `<module>.test.mjs`; `npm test` and `npm run lint` must pass.
- Out of scope: session filter UI, Color by client, `list_clients` (#13); summing project `$` across locations (#10); rewriting dirs on moves (#11).

## Review Focus

1. **A path that merely contains `worktrees`** (e.g. `~/Projekty/worktrees-demo/app`, or `.agent-office/worktrees` with no slug): it must stay a plain dir, with no workspace. → test in Task 1.
2. **Scratchpad slug where two known dirs share an encoded prefix** (`/a/b-c` and `/a/b/c` both encode to `-a-b-c`): the longest encoding wins, and a tie keeps `base_dir = null` instead of guessing. → test in Task 1.
3. **A session dir that no longer exists** (most agent-office worktrees are deleted): it must resolve by path rules alone, with no git spawn and no throw. → test in Task 2.
4. **A register that disappears or is malformed between runs**: the next run sets `project_key` back to null and keeps `workspace`/`base_dir`. Ingest still succeeds. → test in Task 4.
5. **`?project=<dir>` with a dir that is a string prefix of a sibling** (`/p/blog` vs `/p/blog-huha`): the filter must not leak the sibling's sessions. → test in Task 3.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/cc/workspace.mjs` (new) | Pure, client-safe path rules: `encodeClaudeSlug`, `resolveWorkspacePath`, `formatWorkspace` |
| `src/lib/cc/project-key.mjs` (new) | Git probe (exec, memo), `buildProjectIndex`, `placeSession`, `assignPlacements` |
| `src/lib/cc/session-project.mjs` (new) | Client-safe `sessionProjectKey(s)`, `sessionProjectLabel(s)` |
| `src/lib/cc/store.mjs` | migration cols + index, `setPlacements`, `listPlacementInputs`, `listSessions({ project, projectKey })` |
| `src/lib/cc/ingest-run.mjs` | call `assignPlacements` after the source loops, before `linkChildren` |
| `src/lib/cc/session-tree.mjs`, `session-calendar.mjs`, `session-filters.mjs` | group / colour / search by project key |
| `src/lib/cc/analytics.mjs` | `topProjects` by project key |
| `src/app/api/sessions/route.js` | `project_key` param, `project_name` on rows |
| `src/mcp/server.mjs` | `list_sessions` adds `project_key`, `workspace` |
| `src/app/sessions/workspace-badge.js` (new), `page.js`, `calendar-view.js` | badge + project label |
| `src/components/ProjectDetailsSheet.js` | "View sessions →" uses `project_key` when known |
| `CLAUDE.md` | document the new columns and placement pass |

---

### Task 0: Rebase onto #8 and pin the contract

**Files:**
- Modify: none (only the import names in later tasks)

**Interfaces:**
- Produces: the real names for `loadRegister` and the project/location shape, written into this plan's Task 2 imports.

- [ ] **Step 1: Rebase**

```bash
git fetch origin && git rebase origin/main
```
Expected: #8 (and #9 if merged) present in `git log --oneline origin/main`.

- [ ] **Step 2: Map the contract**

Find #8's register API:
```bash
grep -rn "export.*Register\|locations" src/lib --include='*.mjs' | grep -v test
```
Confirm or replace:
- `loadRegister()` → returns `{ projects: [{ id, name?, locations: [{ directory }] }] }`
- whether ledger rows carry `project_id` (#9)

If the names differ, edit the import line and `buildProjectIndex`'s field access in Task 2 **before** starting it. Nothing else in the plan depends on #8.

- [ ] **Step 3: Baseline**

```bash
npm test && npm run lint
```
Expected: PASS (record the test count).

---

### Task 1: Pure workspace path rules

**Files:**
- Create: `src/lib/cc/workspace.mjs`
- Test: `src/lib/cc/workspace.test.mjs`

**Interfaces:**
- Produces:
  - `encodeClaudeSlug(dir: string) → string`
  - `resolveWorkspacePath(runDir: string|null, { knownDirs?: string[] }) → { base_dir: string|null, workspace: string|null, matched: boolean }`. `matched` is false when no rule fired (Task 2 then may git-probe).
  - `formatWorkspace(ws: string|null) → string|null` (`'agent-office:pixel-77d1'` → `'agent-office: pixel-77d1'`)

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/cc/workspace.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeClaudeSlug, resolveWorkspacePath, formatWorkspace } from './workspace.mjs'

const AO = '/Users/e/Projekty/_AgentOffice/erikmeliska/stow-dashboard'
const VYD = '/Users/e/Projekty/_Bizz/TriSoft/vydavatelstvo'

test('encodeClaudeSlug replaces every non-alphanumeric char with a dash', () => {
  assert.equal(encodeClaudeSlug(`${VYD}/.claude/worktrees/admiring-williamson-fa72a2`),
    '-Users-e-Projekty--Bizz-TriSoft-vydavatelstvo--claude-worktrees-admiring-williamson-fa72a2')
})

test('agent-office worktree maps to the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${AO}/.agent-office/worktrees/pixel-77d1`),
    { base_dir: AO, workspace: 'agent-office:pixel-77d1', matched: true })
})

test('a sub-path inside a worktree keeps its sub-path on the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${AO}/.agent-office/worktrees/pixel-77d1/packages/a`),
    { base_dir: `${AO}/packages/a`, workspace: 'agent-office:pixel-77d1', matched: true })
})

test('.claude worktree maps to the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${VYD}/.claude/worktrees/eloquent-shamir-6bd961`),
    { base_dir: VYD, workspace: 'claude-worktree:eloquent-shamir-6bd961', matched: true })
})

test('scratchpad of a .claude worktree resolves via the known dirs', () => {
  const run = `/private/tmp/claude-501/${encodeClaudeSlug(`${VYD}/.claude/worktrees/admiring-williamson-fa72a2`)}/9ce1e738-72cd-4f13-b52c-6c0d5bd65d05/scratchpad/skills-grid`
  assert.deepEqual(resolveWorkspacePath(run, { knownDirs: [VYD, '/Users/e/Projekty'] }),
    { base_dir: VYD, workspace: 'scratchpad:9ce1e738', matched: true })
})

test('scratchpad under /tmp works too', () => {
  const run = `/tmp/claude-501/${encodeClaudeSlug(AO)}/abcdef12-0000-0000-0000-000000000000/scratchpad`
  assert.equal(resolveWorkspacePath(run, { knownDirs: [AO] }).base_dir, AO)
})

test('undecodable scratchpad keeps the workspace, base_dir null', () => {
  const run = '/private/tmp/claude-501/-Some-Unknown-dir/abcdef12-0000-0000-0000-000000000000/scratchpad'
  assert.deepEqual(resolveWorkspacePath(run, { knownDirs: [AO] }),
    { base_dir: null, workspace: 'scratchpad:abcdef12', matched: true })
})

test('ambiguous scratchpad encoding (tie) does not guess', () => {
  const run = `/private/tmp/claude-501/-a-b-c/abcdef12-0000-0000-0000-000000000000/scratchpad`
  assert.equal(resolveWorkspacePath(run, { knownDirs: ['/a/b-c', '/a/b/c'] }).base_dir, null)
})

test('dirs that only mention worktrees are plain', () => {
  for (const d of ['/p/worktrees-demo/app', `${AO}/.agent-office/worktrees`, `${AO}/.agent-office/worktrees/`]) {
    assert.deepEqual(resolveWorkspacePath(d), { base_dir: d.replace(/\/$/, ''), workspace: null, matched: false })
  }
})

test('null run dir', () => {
  assert.deepEqual(resolveWorkspacePath(null), { base_dir: null, workspace: null, matched: false })
})

test('formatWorkspace', () => {
  assert.equal(formatWorkspace('agent-office:pixel-77d1'), 'agent-office: pixel-77d1')
  assert.equal(formatWorkspace(null), null)
})
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test src/lib/cc/workspace.test.mjs`
Expected: FAIL, `Cannot find module './workspace.mjs'`.

- [ ] **Step 3: Implement**

```js
// src/lib/cc/workspace.mjs
/**
 * Where a session ran, as path rules only (no fs, no git — client-safe and
 * shared with usage.mjs). Worktrees and Claude scratchpads are mapped back onto
 * the checkout they belong to; see the #12 design for the rule order.
 */

const WORKTREE_RULES = [
  { kind: 'agent-office', re: /^(.*)\/\.agent-office\/worktrees\/([^/]+)(\/.*)?$/ },
  { kind: 'claude-worktree', re: /^(.*)\/\.claude\/worktrees\/([^/]+)(\/.*)?$/ },
]
const SCRATCHPAD_RE = /^(?:\/private)?\/tmp\/claude-[^/]+\/([^/]+)\/([0-9a-f-]{8,})\/scratchpad(?:\/.*)?$/

/** Claude's project-dir encoding: every non-alphanumeric char becomes '-'. */
export function encodeClaudeSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-')
}

/** Longest known dir whose encoding is the slug or a '-'-prefix of it; null on a tie or no match. */
function matchSlug(slug, knownDirs) {
  let best = null, bestLen = -1, tie = false
  for (const d of knownDirs || []) {
    const enc = encodeClaudeSlug(d)
    if (slug !== enc && !slug.startsWith(enc + '-')) continue
    if (enc.length > bestLen) { best = d; bestLen = enc.length; tie = false }
    else if (enc.length === bestLen && d !== best) tie = true
  }
  return tie ? null : best
}

export function resolveWorkspacePath(runDir, { knownDirs = [] } = {}) {
  if (!runDir) return { base_dir: null, workspace: null, matched: false }
  const dir = runDir.length > 1 ? runDir.replace(/\/+$/, '') : runDir
  for (const { kind, re } of WORKTREE_RULES) {
    const m = dir.match(re)
    if (m) return { base_dir: m[1] + (m[3] || ''), workspace: `${kind}:${m[2]}`, matched: true }
  }
  const s = dir.match(SCRATCHPAD_RE)
  if (s) return { base_dir: matchSlug(s[1], knownDirs), workspace: `scratchpad:${s[2].slice(0, 8)}`, matched: true }
  return { base_dir: dir, workspace: null, matched: false }
}

export function formatWorkspace(ws) {
  if (!ws) return null
  const i = ws.indexOf(':')
  return i < 0 ? ws : `${ws.slice(0, i)}: ${ws.slice(i + 1)}`
}
```

- [ ] **Step 4: Run and see it pass**

Run: `node --test src/lib/cc/workspace.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/workspace.mjs src/lib/cc/workspace.test.mjs
git commit -m "feat(sessions): path rules for worktree and scratchpad workspaces (#12)"
```

---

### Task 2: Git probe, project index, `placeSession`

**Files:**
- Create: `src/lib/cc/project-key.mjs`
- Test: `src/lib/cc/project-key.test.mjs`

**Interfaces:**
- Consumes: `resolveWorkspacePath`, from Task 1. `loadRegister`, from #8 (name per Task 0).
- Produces:
  - `gitProbe(dir, { exec }) → Promise<{ base: string, toplevel: string } | null>`. Memoized per process by `dir`. `clearGitProbeCache()` is for tests.
  - `buildProjectIndex({ register, ledgerRows }) → { lookup(dir) → string|null, knownDirs: string[] }`
  - `placeSession(row, { index, exists, exec }) → Promise<{ project_key, workspace, base_dir }>`
  - `loadPlacementContext({ exec? }) → Promise<{ index, exists, exec }>`. Reads the register and the ledger at call time.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/cc/project-key.test.mjs
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gitProbe, clearGitProbeCache, buildProjectIndex, placeSession } from './project-key.mjs'

beforeEach(() => clearGitProbeCache())

const register = { projects: [
  { id: 'P-blog', name: 'blog', locations: [{ directory: '/p/blog' }, { directory: '/p/blog-huha' }] },
  { id: 'P-mono', name: 'mono', locations: [{ directory: '/p/mono' }] },
  { id: 'P-pkg', name: 'pkg-a', locations: [{ directory: '/p/mono/packages/a' }] },
] }

function fakeExec(answers) {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const dir = args[1]
    if (!(dir in answers)) throw new Error('not a git repository')
    return { stdout: answers[dir] }
  }
  return { exec, calls }
}

test('index: deepest location wins, sibling prefix does not match', () => {
  const idx = buildProjectIndex({ register })
  assert.equal(idx.lookup('/p/mono/packages/a/src'), 'P-pkg')
  assert.equal(idx.lookup('/p/mono/docs'), 'P-mono')
  assert.equal(idx.lookup('/p/blog-huha'), 'P-blog')
  assert.equal(idx.lookup('/p/blog-huhax'), null)
  assert.equal(idx.lookup('/elsewhere'), null)
  assert.ok(idx.knownDirs.includes('/p/mono/packages/a'))
})

test('index: ledger rows with project_id add finer locations (#9)', () => {
  const idx = buildProjectIndex({ register, ledgerRows: [{ directory: '/p/blog/sub', project_id: 'P-blog' }] })
  assert.equal(idx.lookup('/p/blog/sub/x'), 'P-blog')
})

test('index: missing/malformed register → empty', () => {
  assert.equal(buildProjectIndex({ register: null }).lookup('/p/blog'), null)
  assert.equal(buildProjectIndex({ register: { projects: 'nope' } }).lookup('/p/blog'), null)
})

test('gitProbe: linked worktree, main checkout, bare, failure; memoized', async () => {
  const { exec, calls } = fakeExec({
    '/w/feat': '/p/blog/.git\n/w/feat\n',
    '/p/blog': '/p/blog/.git\n/p/blog\n',
    '/w/bare': '/srv/blog.git\n/w/bare\n',
  })
  assert.deepEqual(await gitProbe('/w/feat', { exec }), { base: '/p/blog', toplevel: '/w/feat' })
  assert.equal(await gitProbe('/p/blog', { exec }), null)
  assert.equal(await gitProbe('/w/bare', { exec }), null)
  assert.equal(await gitProbe('/nope', { exec }), null)
  await gitProbe('/w/feat', { exec }); await gitProbe('/nope', { exec })
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[0], ['git', '-C', '/w/feat', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
})

test('placeSession: agent-office worktree of a gone dir — no git spawn', async () => {
  const { exec, calls } = fakeExec({})
  const index = buildProjectIndex({ register })
  const got = await placeSession({ cwd: '/p/blog/.agent-office/worktrees/pixel-77d1', project_dir: '/p/blog/.agent-office/worktrees/pixel-77d1' },
    { index, exists: () => false, exec })
  assert.deepEqual(got, { project_key: 'P-blog', workspace: 'agent-office:pixel-77d1', base_dir: '/p/blog' })
  assert.equal(calls.length, 0)
})

test('placeSession: live linked git worktree outside the project', async () => {
  const { exec } = fakeExec({ '/w/feat/src': '/p/blog/.git\n/w/feat\n' })
  const got = await placeSession({ cwd: '/w/feat/src', project_dir: '/w/feat/src' },
    { index: buildProjectIndex({ register }), exists: () => true, exec })
  assert.deepEqual(got, { project_key: 'P-blog', workspace: 'git-worktree:feat', base_dir: '/p/blog/src' })
})

test('placeSession: dir inside a known location is never probed', async () => {
  const { exec, calls } = fakeExec({})
  const got = await placeSession({ cwd: '/p/mono/docs', project_dir: '/p/mono/docs' },
    { index: buildProjectIndex({ register }), exists: () => true, exec })
  assert.deepEqual(got, { project_key: 'P-mono', workspace: null, base_dir: '/p/mono/docs' })
  assert.equal(calls.length, 0)
})

test('placeSession: Codex/Gemini rows use project_dir over cwd', async () => {
  const got = await placeSession({ cwd: '/home', project_dir: '/p/mono/packages/a', raw_ref: '/x/.codex/sessions/a.jsonl' },
    { index: buildProjectIndex({ register }), exists: () => false, exec: async () => { throw new Error() } })
  assert.equal(got.project_key, 'P-pkg')
})

test('placeSession: no register → key null, workspace still set', async () => {
  const got = await placeSession({ cwd: '/p/blog/.claude/worktrees/x', project_dir: '/p/blog/.claude/worktrees/x' },
    { index: buildProjectIndex({ register: null }), exists: () => false, exec: async () => { throw new Error() } })
  assert.deepEqual(got, { project_key: null, workspace: 'claude-worktree:x', base_dir: '/p/blog' })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test src/lib/cc/project-key.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/lib/cc/project-key.mjs
/**
 * Session placement (#12): which register project a session belongs to and in
 * which workspace (worktree/scratchpad) it ran. Path rules first (most
 * worktrees are deleted by the time we look), a memoized git probe only for
 * live dirs no rule and no known location covers.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { resolveWorkspacePath } from './workspace.mjs'
import { ledgerFile } from '../state-dir.mjs'
import { loadRegister } from '../register.mjs' // #8 — name confirmed in Task 0

const defaultExec = promisify(execFile)
const probeCache = new Map()

export function clearGitProbeCache() { probeCache.clear() }

export async function gitProbe(dir, { exec = defaultExec } = {}) {
  if (probeCache.has(dir)) return probeCache.get(dir)
  let out = null
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { timeout: 5000 })
    const [common, toplevel] = String(stdout).trim().split('\n')
    if (common?.endsWith('/.git') && toplevel && dirname(common) !== toplevel) out = { base: dirname(common), toplevel }
  } catch { /* not a repo / refused: no mapping */ }
  probeCache.set(dir, out)
  return out
}

const within = (dir, root) => dir === root || dir.startsWith(root + '/')

export function buildProjectIndex({ register, ledgerRows = [] } = {}) {
  const entries = []
  const projects = Array.isArray(register?.projects) ? register.projects : []
  for (const p of projects) {
    for (const l of Array.isArray(p?.locations) ? p.locations : []) {
      if (p.id && l?.directory) entries.push([l.directory, p.id])
    }
  }
  for (const r of ledgerRows || []) if (r?.directory && r.project_id) entries.push([r.directory, r.project_id])
  entries.sort((a, b) => b[0].length - a[0].length)
  return {
    lookup: (dir) => (dir ? entries.find(([d]) => within(dir, d))?.[1] ?? null : null),
    knownDirs: [...new Set(entries.map(([d]) => d))],
    covers: (dir) => entries.some(([d]) => within(dir, d)),
  }
}

/** Run dir: Codex/Gemini already put their best guess in project_dir; Claude's project_dir is its cwd. */
const runDirOf = (row) => row.project_dir || row.cwd || null

export async function placeSession(row, { index, exists = existsSync, exec = defaultExec }) {
  const run = runDirOf(row)
  let { base_dir, workspace, matched } = resolveWorkspacePath(run, { knownDirs: index.knownDirs })
  if (!matched && run && !index.covers(run) && exists(run)) {
    const g = await gitProbe(run, { exec })
    if (g) {
      base_dir = g.base + run.slice(g.toplevel.length)
      workspace = `git-worktree:${basename(g.toplevel)}`
    }
  }
  return { project_key: index.lookup(base_dir), workspace, base_dir }
}

/** Register + ledger read at call time (state dir), never at module eval. */
export async function loadPlacementContext({ exec = defaultExec } = {}) {
  let register = null
  try { register = await loadRegister() } catch (e) { console.warn('[cc] register unreadable:', e?.message) }
  const ledgerRows = []
  try {
    for (const line of (await readFile(ledgerFile(), 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try { const d = JSON.parse(line); if (d.directory) ledgerRows.push({ directory: d.directory, project_id: d.project_id }) } catch { /* skip */ }
    }
  } catch { /* no ledger */ }
  const index = buildProjectIndex({ register, ledgerRows })
  // Ledger dirs also help decode scratchpad slugs, even without a project_id yet.
  index.knownDirs = [...new Set([...index.knownDirs, ...ledgerRows.map((r) => r.directory)])]
  return { index, exists: existsSync, exec }
}
```

- [ ] **Step 4: Run and see it pass**

Run: `node --test src/lib/cc/project-key.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/project-key.mjs src/lib/cc/project-key.test.mjs
git commit -m "feat(sessions): resolve session project key and workspace (#12)"
```

---

### Task 3: Store — columns, writer, project filters

**Files:**
- Modify: `src/lib/cc/store.mjs`. Add `MIGRATION_COLS` entries, index, `setPlacements`, `listPlacementInputs`. Extend `listSessions`.
- Test: `src/lib/cc/store.test.mjs`

**Interfaces:**
- Produces:
  - `listPlacementInputs(db) → Array<{ session_id, cwd, project_dir, raw_ref, project_key, workspace, base_dir }>`
  - `setPlacements(db, rows: Array<{ session_id, project_key, workspace, base_dir }>) → number` (one transaction; returns the rows written)
  - `listSessions(db, { project?, projectKey?, limit, since, until })`. `project` matches `coalesce(base_dir, project_dir)` equal to it or under `dir/`. `projectKey` matches `project_key`.

- [ ] **Step 1: Write the failing tests** (append to `store.test.mjs`; reuse its `seed()`)

```js
import { setPlacements, listPlacementInputs } from './store.mjs';
import { DatabaseSync } from 'node:sqlite';

const row = (id, dir, t) => ({ session_id: id, project_dir: dir, cwd: dir, model: 'x', started_at: t, ended_at: t, duration_s: 0, active_s: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: `/t/${id}`, ingested_at: 'now' });

test('migration adds workspace/base_dir to an old DB', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_dir TEXT, project_key TEXT, cwd TEXT)');
  ensureColumns(raw);
  const cols = raw.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  assert.ok(cols.includes('workspace') && cols.includes('base_dir'));
});

test('upsert never touches placement columns', () => {
  const db = seed();
  setPlacements(db, [{ session_id: 's1', project_key: 'P1', workspace: 'agent-office:x', base_dir: '/p' }]);
  upsertSession(db, row('s1', '/p/a', '2026-08-21T10:00:00Z'));
  const s = getSession(db, 's1').session;
  assert.equal(s.project_key, 'P1');
  assert.equal(s.workspace, 'agent-office:x');
});

test('listPlacementInputs returns every row', () => {
  const db = seed();
  assert.deepEqual(Object.keys(listPlacementInputs(db)[0]).sort(),
    ['base_dir', 'cwd', 'project_dir', 'project_key', 'raw_ref', 'session_id', 'workspace']);
});

test('project filter matches base_dir subtree, not sibling prefixes', () => {
  const db = openStore(':memory:');
  upsertSession(db, row('main', '/p/blog', '2026-08-21T10:00:00Z'));
  upsertSession(db, row('wt', '/p/blog/.agent-office/worktrees/x', '2026-08-21T11:00:00Z'));
  upsertSession(db, row('sib', '/p/blog-huha', '2026-08-21T12:00:00Z'));
  upsertSession(db, row('unplaced', '/p/blog/sub', '2026-08-21T13:00:00Z'));
  setPlacements(db, [
    { session_id: 'main', project_key: 'P', workspace: null, base_dir: '/p/blog' },
    { session_id: 'wt', project_key: 'P', workspace: 'agent-office:x', base_dir: '/p/blog' },
    { session_id: 'sib', project_key: 'P', workspace: null, base_dir: '/p/blog-huha' },
  ]);
  assert.deepEqual(listSessions(db, { project: '/p/blog' }).map((s) => s.session_id).sort(), ['main', 'unplaced', 'wt']);
  assert.deepEqual(listSessions(db, { projectKey: 'P' }).map((s) => s.session_id).sort(), ['main', 'sib', 'wt']);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test --disable-warning=ExperimentalWarning src/lib/cc/store.test.mjs`
Expected: FAIL, `setPlacements` is not exported.

- [ ] **Step 3: Implement**

In `MIGRATION_COLS` add `workspace: 'TEXT', base_dir: 'TEXT',`. Do **not** clear `ingest_state`, because the placement pass backfills without a re-parse. After the existing `idx_sessions_parent` line in `ensureColumns`:

```js
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_key ON sessions (project_key)');
```

Add these functions next to `setSummary`:

```js
/** Placement columns (#12): written only here, never by upsertSession. */
export function setPlacements(db, rows) {
  if (!rows.length) return 0;
  const st = db.prepare('UPDATE sessions SET project_key = ?, workspace = ?, base_dir = ? WHERE session_id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) st.run(r.project_key ?? null, r.workspace ?? null, r.base_dir ?? null, r.session_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}

export function listPlacementInputs(db) {
  return db.prepare('SELECT session_id, cwd, project_dir, raw_ref, project_key, workspace, base_dir FROM sessions').all();
}
```

In `listSessions`, change the signature to `{ project, projectKey, limit = 200, since = null, until = null }` and replace the `project` condition:

```js
  if (project) {
    conds.push("(coalesce(s.base_dir, s.project_dir) = ? OR coalesce(s.base_dir, s.project_dir) LIKE ? ESCAPE '\\')");
    args.push(project, project.replace(/[\\%_]/g, '\\$&') + '/%');
  }
  if (projectKey) { conds.push('s.project_key = ?'); args.push(projectKey); }
```

- [ ] **Step 4: Run the whole cc suite**

Run: `node --test --disable-warning=ExperimentalWarning src/lib/cc/`
Expected: PASS. The existing "filters by project" test still passes, because `base_dir` is null there and the filter falls back to `project_dir`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/store.mjs src/lib/cc/store.test.mjs
git commit -m "feat(sessions): store placement columns and project_key filter (#12)"
```

---

### Task 4: Placement pass in ingest (the backfill)

**Files:**
- Modify: `src/lib/cc/project-key.mjs` (add `assignPlacements`), `src/lib/cc/ingest-run.mjs` (`ingestAll` options + call)
- Test: `src/lib/cc/project-key.test.mjs`, `src/lib/cc/ingest-run.test.mjs`

**Interfaces:**
- Consumes: `listPlacementInputs`, `setPlacements` (Task 3); `placeSession`, `loadPlacementContext` (Task 2).
- Produces:
  - `assignPlacements(db, ctx) → Promise<{ checked: number, updated: number, ms: number }>`
  - `ingestAll({ …, placement })`. `placement` is an optional ctx (tests inject one). The default is `await loadPlacementContext()`. The result gains `placed: { checked, updated }` or `placement_error: string`.

- [ ] **Step 1: Write the failing tests**

Append to `project-key.test.mjs`:

```js
import { openStore, upsertSession, getSession } from './store.mjs'
import { assignPlacements } from './project-key.mjs'

const srow = (id, dir) => ({ session_id: id, project_dir: dir, cwd: dir, model: 'x', started_at: '2026-10-01T10:00:00Z', ended_at: null, duration_s: 0, active_s: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: `/t/${id}`, ingested_at: 'now' })
const ctx = (reg) => ({ index: buildProjectIndex({ register: reg }), exists: () => false, exec: async () => { throw new Error() } })

test('assignPlacements backfills, is idempotent, follows register changes', async () => {
  const db = openStore(':memory:')
  upsertSession(db, srow('a', '/p/blog'))
  upsertSession(db, srow('b', '/p/blog/.agent-office/worktrees/pixel-77d1'))
  let r = await assignPlacements(db, ctx(register))
  assert.deepEqual([r.checked, r.updated], [2, 2])
  assert.equal(getSession(db, 'b').session.project_key, 'P-blog')
  r = await assignPlacements(db, ctx(register))
  assert.equal(r.updated, 0)
  r = await assignPlacements(db, ctx(null)) // register gone
  assert.equal(r.updated, 2)
  assert.equal(getSession(db, 'b').session.project_key, null)
  assert.equal(getSession(db, 'b').session.workspace, 'agent-office:pixel-77d1')
})
```

Append to `ingest-run.test.mjs`. It reuses `fixture()`, whose cwd is `/p/a`, and adds a worktree transcript:

```js
test('ingest places sessions (worktree → main project) and reports it', async () => {
  const { root, guard } = await fixture();
  const wt = join(root, 'projects', '-p-a--agent-office-worktrees-pixel-1');
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, 'sess-2.jsonl'), [
    { type: 'user', cwd: '/p/a/.agent-office/worktrees/pixel-1', sessionId: 'sess-2', timestamp: '2026-08-21T11:00:00Z' },
    { type: 'assistant', sessionId: 'sess-2', timestamp: '2026-08-21T11:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
  ].map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const { buildProjectIndex } = await import('./project-key.mjs');
  const placement = { index: buildProjectIndex({ register: { projects: [{ id: 'P-a', locations: [{ directory: '/p/a' }] }] } }), exists: () => false, exec: async () => { throw new Error(); } };
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db, placement });
  assert.deepEqual(res.placed, { checked: 2, updated: 2 });
  const s = getSession(db, 'sess-2').session;
  assert.equal(s.project_key, 'P-a');
  assert.equal(s.workspace, 'agent-office:pixel-1');
  assert.equal(s.project_dir, '/p/a/.agent-office/worktrees/pixel-1'); // unchanged
});

test('a placement failure does not fail the ingest', async () => {
  const { root, guard } = await fixture();
  const db = openStore(':memory:');
  const placement = { index: { lookup() { throw new Error('boom'); }, knownDirs: [], covers: () => true }, exists: () => false, exec: async () => ({}) };
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db, placement });
  assert.equal(res.sessions, 1);
  assert.match(res.placement_error, /boom/);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test --disable-warning=ExperimentalWarning src/lib/cc/project-key.test.mjs src/lib/cc/ingest-run.test.mjs`
Expected: FAIL, `assignPlacements` is not exported and `res.placed` is undefined.

- [ ] **Step 3: Implement**

In `project-key.mjs`:

```js
import { listPlacementInputs, setPlacements } from './store.mjs'

/** Recompute placement for every row; write only what changed. This is also the backfill. */
export async function assignPlacements(db, ctx) {
  const t0 = Date.now()
  const rows = listPlacementInputs(db)
  const changed = []
  for (const r of rows) {
    const p = await placeSession(r, ctx)
    if (p.project_key !== r.project_key || p.workspace !== r.workspace || p.base_dir !== r.base_dir) {
      changed.push({ session_id: r.session_id, ...p })
    }
  }
  setPlacements(db, changed)
  return { checked: rows.length, updated: changed.length, ms: Date.now() - t0 }
}
```

In `ingest-run.mjs`, add `placement = null,` to the `ingestAll` options and import `{ assignPlacements, loadPlacementContext }` from `./project-key.mjs`. Replace the tail:

```js
  // Placement after every source is in, before linking (#12). Recomputes all
  // rows, so it is also the backfill and follows register changes.
  let placed = null, placement_error = null;
  try {
    const { checked, updated } = await assignPlacements(db, placement || await loadPlacementContext());
    placed = { checked, updated };
  } catch (e) {
    placement_error = String(e?.message || e);
    console.warn('[cc] placement failed:', placement_error);
  }

  const linked = await linkChildren(db, { full: linkAll });
  return { sessions, changed, skipped, linked, placed, ...(placement_error ? { placement_error } : {}), ms: Date.now() - t0 };
```

- [ ] **Step 4: Run and see it pass**

Run: `node --test --disable-warning=ExperimentalWarning src/lib/cc/`
Expected: PASS. If an existing `ingest-run` test deep-equals the whole result object, add `placed` to its expectation.

- [ ] **Step 5: Measure on a copy of the real DB**

Copy the live DB and run against the copy (read-only to the user's data). The register is #8's real one:
```bash
S=$(mktemp -d); cp "$HOME/Library/Application Support/StowDashboardDeno/data/cc-sessions.db"* "$S/"
node --disable-warning=ExperimentalWarning -e "
const { openStore } = await import('./src/lib/cc/store.mjs');
const { assignPlacements, loadPlacementContext } = await import('./src/lib/cc/project-key.mjs');
const db = openStore('$S/cc-sessions.db'); const ctx = await loadPlacementContext();
console.log('cold', await assignPlacements(db, ctx)); console.log('warm', await assignPlacements(db, ctx));
console.log(db.prepare(\"select workspace is not null w, count(*) n from sessions group by 1\").all());
console.log(db.prepare(\"select count(distinct coalesce(project_key, base_dir)) n from sessions where base_dir like '%plynconvertor%'\").get());"
```
Expected:
- warm run: `updated: 0`, `ms < 30`
- ≥ 63 rows with a workspace
- plynconvertor resolves to **1** distinct key

Record the numbers in the PR.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cc/project-key.mjs src/lib/cc/project-key.test.mjs src/lib/cc/ingest-run.mjs src/lib/cc/ingest-run.test.mjs
git commit -m "feat(sessions): placement pass in ingest backfills project_key and workspace (#12)"
```

---

### Task 5: Client-safe project key/label, grouping, colour, search

**Files:**
- Create: `src/lib/cc/session-project.mjs`, test `src/lib/cc/session-project.test.mjs`
- Modify: `src/lib/cc/session-tree.mjs:95-133`, `src/lib/cc/session-calendar.mjs:188-212`, `src/lib/cc/session-filters.mjs:58-63`
- Test: `session-tree.test.mjs`, `session-calendar.test.mjs`, `session-filters.test.mjs`

**Interfaces:**
- Produces:
  - `sessionProjectKey(s) → string`. Returns `project_key || base_dir || project_dir || ''`.
  - `sessionProjectLabel(s) → string`. Returns `s.project_name`, else the basename of `base_dir || project_dir`, else `'—'`.
  - `GROUP_BY.project.text(key, firstItem)`: `groupFamilies` now passes the first family.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/cc/session-project.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs'

test('key prefers project_key, then base_dir, then project_dir', () => {
  assert.equal(sessionProjectKey({ project_key: 'P', base_dir: '/p', project_dir: '/p/.claude/worktrees/x' }), 'P')
  assert.equal(sessionProjectKey({ base_dir: '/p', project_dir: '/p/.claude/worktrees/x' }), '/p')
  assert.equal(sessionProjectKey({ project_dir: '/q' }), '/q')
  assert.equal(sessionProjectKey({}), '')
})

test('label prefers project_name, then basename of base_dir', () => {
  assert.equal(sessionProjectLabel({ project_name: 'Blog', base_dir: '/p/blog' }), 'Blog')
  assert.equal(sessionProjectLabel({ base_dir: '/p/blog', project_dir: '/p/blog/.agent-office/worktrees/x' }), 'blog')
  assert.equal(sessionProjectLabel({}), '—')
})
```

Append to the existing tests:

```js
// session-calendar.test.mjs
test('Color by project: main and worktree session share one bucket', () => {
  const a = colorBy({ project_key: 'P', base_dir: '/p', project_dir: '/p' }, 'project')
  const b = colorBy({ project_key: 'P', base_dir: '/p', project_dir: '/p/.agent-office/worktrees/x' }, 'project')
  assert.equal(a.key, b.key); assert.equal(a.color, b.color); assert.equal(b.label, 'p')
})

// session-tree.test.mjs — build two families with buildFamilies() as the file's other tests do, then:
test('group by project folds worktree sessions into their project', () => {
  const fams = [
    { session_id: 'a', project_key: 'P', base_dir: '/p/blog', project_dir: '/p/blog', started_at: '2026-10-01T10:00:00Z', rollup: { cost_usd: 1 } },
    { session_id: 'b', project_key: 'P', base_dir: '/p/blog', project_dir: '/p/blog/.agent-office/worktrees/x', started_at: '2026-10-01T11:00:00Z', rollup: { cost_usd: 2 } },
  ]
  const groups = groupFamilies(fams, 'project')
  assert.equal(groups.length, 1); assert.equal(groups[0].label, 'blog'); assert.equal(groups[0].count, 2)
})

// session-filters.test.mjs
test('search matches workspace and base_dir', () => {
  const rows = [{ session_id: 'a', workspace: 'agent-office:pixel-77d1', base_dir: '/p/stow-dashboard', project_dir: '/x' }]
  assert.equal(filterSessions(rows, { search: 'pixel-77' }).length, 1)
  assert.equal(filterSessions(rows, { search: 'stow-dash' }).length, 1)
})
```
(Use the filter function name and option shape that `session-filters.mjs` actually exports. Check the file's existing tests for the exact call.)

- [ ] **Step 2: Run and see it fail**

Run: `node --test src/lib/cc/session-project.test.mjs src/lib/cc/session-tree.test.mjs src/lib/cc/session-calendar.test.mjs src/lib/cc/session-filters.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// src/lib/cc/session-project.mjs
/** Client-safe project identity of a session row (#12). No fs, no node: imports. */
const base = (dir) => (dir ? dir.split('/').filter(Boolean).at(-1) : '') || ''

export function sessionProjectKey(s) {
  return s?.project_key || s?.base_dir || s?.project_dir || ''
}

export function sessionProjectLabel(s) {
  return s?.project_name || base(s?.base_dir || s?.project_dir) || '—'
}
```

- `session-tree.mjs`:
  - `project: { label: 'Project', key: (f) => sessionProjectKey(f) || '—', text: (k, f) => (f ? sessionProjectLabel(f) : k), order: 'cost' }`
  - In `groupFamilies` at line 133: `label: def.text ? def.text(key, items[0]) : key`
- `session-calendar.mjs` `colorBy`:
  ```js
  if (mode === 'project') { const k = sessionProjectKey(e); return { key: k, label: sessionProjectLabel(e), color: projectColor(k) }; }
  ```
- `session-filters.mjs`:
  ```js
  const matchProject = [s.project_dir, s.base_dir, s.workspace, s.project_name].some((v) => (v || '').toLowerCase().includes(needle))
  ```

- [ ] **Step 4: Run and see it pass**

Run: `node --test src/lib/cc/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/session-project.mjs src/lib/cc/session-project.test.mjs src/lib/cc/session-tree.mjs src/lib/cc/session-tree.test.mjs src/lib/cc/session-calendar.mjs src/lib/cc/session-calendar.test.mjs src/lib/cc/session-filters.mjs src/lib/cc/session-filters.test.mjs
git commit -m "feat(sessions): group, colour and search sessions by project (#12)"
```

---

### Task 6: API, analytics, MCP

**Files:**
- Modify: `src/app/api/sessions/route.js`, `src/lib/cc/analytics.mjs:76-84`, `src/mcp/server.mjs:~1076-1095`
- Test: `src/app/api/sessions/route.test.mjs`, `src/lib/cc/analytics.test.mjs`

**Interfaces:**
- Consumes: `listSessions({ projectKey })` (Task 3), `sessionProjectLabel` (Task 5), #8's `loadRegister`.
- Produces:
  - `handle(searchParams, db, { projectNames?: Map<id,name> })`. Rows gain `project_name`.
  - `topProjects[]` items: `{ project, project_key, project_dir, sessions, cost_usd }`.

- [ ] **Step 1: Write the failing tests**

```js
// route.test.mjs (append; reuse the file's db seeding helper)
test('?project_key= returns every session of the project; rows carry project_name', () => {
  const db = openStore(':memory:')
  upsertSession(db, row('a', '/p/blog')); upsertSession(db, row('b', '/p/blog/.agent-office/worktrees/x'))
  setPlacements(db, [
    { session_id: 'a', project_key: 'P', workspace: null, base_dir: '/p/blog' },
    { session_id: 'b', project_key: 'P', workspace: 'agent-office:x', base_dir: '/p/blog' },
  ])
  const out = handle(new URLSearchParams('project_key=P'), db, { projectNames: new Map([['P', 'Blog']]) })
  assert.equal(out.sessions.length, 2)
  assert.ok(out.sessions.every((s) => s.project_name === 'Blog'))
  const byDir = handle(new URLSearchParams('project=/p/blog'), db)
  assert.equal(byDir.sessions.length, 2)
  assert.equal(byDir.sessions[0].project_name, 'blog')
})

// analytics.test.mjs (append)
test('topProjects folds worktree sessions into the project', () => {
  const db = seedStore()
  upsertSession(db, { ...minimalRow, session_id: 'w1', project_dir: '/p/alpha/.agent-office/worktrees/x', started_at: '2026-09-01T11:00:00Z', cost_usd: 2 })
  setPlacements(db, [
    { session_id: 's1', project_key: 'PA', workspace: null, base_dir: '/p/alpha' },
    { session_id: 'w1', project_key: 'PA', workspace: 'agent-office:x', base_dir: '/p/alpha' },
  ])
  const top = sessionAnalytics(db).topProjects
  const alpha = top.filter((t) => t.project === 'alpha')
  assert.equal(alpha.length, 1)
  assert.equal(alpha[0].project_key, 'PA')
})
```
(`row`/`minimalRow` are the same full-column literal as Task 3's `row()`. Define them locally in each file.)

- [ ] **Step 2: Run and see it fail**

Run: `node --test --disable-warning=ExperimentalWarning src/app/api/sessions/route.test.mjs src/lib/cc/analytics.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`route.js` `handle`:

```js
export function handle(searchParams, db, { projectNames = new Map() } = {}) {
  const id = searchParams.get('id')
  if (id) return getSession(db, id) || { session: null }
  const project = searchParams.get('project') || undefined
  const projectKey = searchParams.get('project_key') || undefined
  // …since/until/limit unchanged…
  const sessions = listSessions(db, { project, projectKey, limit, since, until })
    .map((s) => ({ ...s, project_name: (s.project_key && projectNames.get(s.project_key)) || sessionProjectLabel(s) }))
  return { sessions, agents: listSubagents(db, sessions.map((s) => s.session_id)) }
}
```

In `GET`, build `projectNames` per request:

```js
    let projectNames = new Map()
    try { projectNames = new Map(((await loadRegister())?.projects || []).filter((p) => p.id && p.name).map((p) => [p.id, p.name])) } catch { /* no register */ }
    return Response.json(handle(searchParams, db, { projectNames }))
```

The `?id=` detail: add `project_name` to `session` in the same way (`getSession` result → `{ ...r, session: { ...r.session, project_name } }`).

`analytics.mjs` `topProjects`:

```js
  const topProjects = all(`
    SELECT coalesce(s.project_key, s.base_dir, s.project_dir) k, max(s.project_key) project_key,
           max(coalesce(s.base_dir, s.project_dir)) project_dir,
           sum(parent_session_id IS NULL) sessions, coalesce(sum(cost_usd), 0) cost_usd
    FROM sessions s ${where} GROUP BY k ORDER BY cost_usd DESC LIMIT 8`)
    .map((r) => ({
      project: (r.project_dir || '').split('/').filter(Boolean).at(-1) || '—',
      project_key: r.project_key, project_dir: r.project_dir, sessions: r.sessions, cost_usd: r.cost_usd,
    }))
```

`server.mjs` `list_sessions` family mapping (around line 1089):

```js
project: sessionProjectLabel(f), project_dir: f.project_dir, project_key: f.project_key || null, workspace: f.workspace || null,
```

- [ ] **Step 4: Run and see it pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sessions/route.js src/app/api/sessions/route.test.mjs src/lib/cc/analytics.mjs src/lib/cc/analytics.test.mjs src/mcp/server.mjs
git commit -m "feat(sessions): project_key in sessions API, analytics top projects and MCP (#12)"
```

---

### Task 7: UI — workspace badge and project label

**Files:**
- Create: `src/app/sessions/workspace-badge.js`
- Modify:
  - `src/app/sessions/page.js:41,72-91,357-358,551`
  - `src/app/sessions/calendar-view.js:16,195,205`
  - `src/components/ProjectDetailsSheet.js:995`

**Interfaces:**
- Consumes:
  - `formatWorkspace` (Task 1)
  - `sessionProjectLabel` (Task 5)
  - `project_name` / `workspace` / `project_key` on API rows (Task 6)
- Produces: `<WorkspaceBadge workspace={string|null} className? />`. It renders nothing when `workspace` is null.

- [ ] **Step 1: Implement the badge**

```js
// src/app/sessions/workspace-badge.js
'use client'
import { GitBranch } from 'lucide-react'
import { formatWorkspace } from '@/lib/cc/workspace.mjs'

/** Where a session ran when that wasn't the project's own checkout (#12). */
export function WorkspaceBadge({ workspace, className = '' }) {
  const text = formatWorkspace(workspace)
  if (!text) return null
  return (
    <span title={`Ran in ${text}`} className={`inline-flex items-center gap-0.5 rounded border px-1 text-[10px] leading-4 text-muted-foreground whitespace-nowrap ${className}`}>
      <GitBranch className="h-2.5 w-2.5" />{text}
    </span>
  )
}
```

- [ ] **Step 2: Wire it in**

- `page.js`:
  - delete the local `projectName` and import `sessionProjectLabel` and `WorkspaceBadge`
  - table cell (357-358):
    ```js
    <td className={`${CELL} truncate max-w-[16rem]`} title={s.base_dir || s.project_dir || ''}>
      {sessionProjectLabel(s)} <WorkspaceBadge workspace={s.workspace} className="ml-1" />
    </td>
    ```
  - detail header (72-77): label + badge, and keep the raw `project_dir` line
  - "Filter to this project" (78-84): use `s.base_dir || s.project_dir`
  - parent line (91): `sessionProjectLabel(detail.parent)`
  - the active-filter chip (551): basename of `project` as today
- `calendar-view.js`:
  - replace `projectName(e.project_dir)` with `sessionProjectLabel(e)` in both spots
  - tooltip appends ``${e.workspace ? ` · ${formatWorkspace(e.workspace)}` : ''}``
  - the non-compact line renders `<WorkspaceBadge workspace={e.workspace} className="ml-1" />`
- `ProjectDetailsSheet.js:995`: `href={project.project_id ? `/sessions?project_key=${encodeURIComponent(project.project_id)}` : `/sessions?project=${encodeURIComponent(project.directory)}`}`. `project_id` comes from #9 when merged; otherwise the dir link applies, and it now includes worktree sessions through `base_dir`.
- The `/sessions` page must forward `project_key` from its URL to `/api/sessions` the same way it forwards `project`. Find where `project` is read from `useSearchParams` and add `project_key` to the fetch query and the chip.

- [ ] **Step 3: Lint and test**

Run: `npm run lint && npm test`
Expected: PASS.

- [ ] **Step 4: Verify in the browser**

`npm run dev` (port 3089) → `/sessions`:
- plynconvertor rows show `plynconvertor` plus a badge like `agent-office: pixel-ca5e`
- Group: Project → one plynconvertor group
- Calendar → Color by project → one colour for it
- detail panel shows the badge and the raw dir
- `/sessions?project_key=<id>` lists the main and worktree sessions

Take one screenshot of the table and one of the calendar for the PR.

- [ ] **Step 5: Commit**

```bash
git add src/app/sessions/workspace-badge.js src/app/sessions/page.js src/app/sessions/calendar-view.js src/components/ProjectDetailsSheet.js
git commit -m "feat(sessions): workspace badge and project labels in table, calendar, detail (#12)"
```

---

### Task 8: Docs

**Files:**
- Modify: `CLAUDE.md` (Important Files list; "Claude Code Session Store" section; MCP tools line for `list_sessions`)

- [ ] **Step 1: Edit CLAUDE.md**

- Add to Important Files:
  - `src/lib/cc/workspace.mjs` - Pure path rules: agent-office / `.claude` worktrees and Claude scratchpads → main checkout + `workspace` (client-safe, shared with usage)
  - `src/lib/cc/project-key.mjs` - Session placement: memoized git-worktree probe, register project index, `assignPlacements` (backfill pass run by every ingest)
  - `src/lib/cc/session-project.mjs` - Client-safe `sessionProjectKey` / `sessionProjectLabel`
- In the session store section, add a bullet "**Project & workspace (#12)**". It summarises the spec's Concepts and Store sections:
  - the three columns, and that `project_dir`/`cwd` are untouched
  - rule order
  - the pass runs over all rows each ingest (warm ~N ms, with the number measured in Task 4)
  - register-missing behaviour
  - the remaining nullable columns are now only `machine`/`user`; drop `project_key` from that sentence

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session project_key and workspace (#12)"
```

---

### Task 9 (only if PR question Q4 is answered "yes"): scratchpad cost in the project `$` column

**Files:**
- Modify: `src/lib/usage.mjs:621-640`
- Test: `src/lib/usage.test.mjs`

- [ ] **Step 1: Failing test**

```js
test('aggregateUsage attributes a scratchpad cwd to its project', () => {
  const cache = { files: { '/t/x.jsonl': { state: { cwd: '/private/tmp/claude-501/-p-blog/abcdef12-0000-0000-0000-000000000000/scratchpad', models: { 'claude-opus-5': { input: 1, output: 1 } } } } } }
  const agg = aggregateUsage(cache, ['/p/blog'])
  assert.ok(agg.projects['/p/blog'])
  assert.equal(agg.unmatched.sessions, 0)
})
```
(Match the `state.models` shape to `usage.test.mjs`'s existing fixtures.)

- [ ] **Step 2: Implement**

At the top of the cwd branch in `aggregateUsage`:

```js
      const cwd = resolveWorkspacePath(st.cwd, { knownDirs: dirs }).base_dir || st.cwd
      let dir = dirs.find(d => cwd === d || cwd.startsWith(d + '/'))
```
and add `import { resolveWorkspacePath } from './cc/workspace.mjs'`.

- [ ] **Step 3: Run tests and commit**

Run: `npm test` → PASS.
```bash
git add src/lib/usage.mjs src/lib/usage.test.mjs
git commit -m "feat(usage): count scratchpad sessions toward their project (#12)"
```

---

### Finish

- [ ] `npm test && npm run lint` are green. Paste the counts into the PR.
- [ ] Push and open the PR with "Closes #12". Include the Task 4 measurement and the Task 7 screenshots.
