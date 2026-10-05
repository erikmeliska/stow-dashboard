# Virtual Projects 6/6 — Session Filters & Sorting by Client / Project / Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/sessions`, its calendar, `/analytics` and the MCP server slice AI sessions by **client**, **virtual project** and **workspace** (main checkout / worktrees / a specific worker). Issue #13 (TRI-STOW-0013).

**Architecture:** Sessions keep only what #12 stores (`project_key`, `workspace`). The client and the project's display name come from #8's register and are **joined at read time**, so reassigning a client in the register shows up immediately with no re-ingest or backfill. One pure, client-safe module (`session-projects.mjs`) does the join, workspace parsing and facet counts. One server-only loader (`project-index.mjs`) builds the `project_key → {project, client}` index from the register, memoised on file mtimes. Everything else is small additions to the existing pure modules (`session-filters`, `session-tree`, `session-calendar`, `analytics`) plus wiring.

**Tech Stack:** Next.js 16 / React 19 client page, `node:sqlite` session store, `node --test` + `node:assert/strict`, MCP SDK.

**Spec:** the design is in this document (section "Design" below). It is written against the data model of the prerequisite issues, which are **not merged yet**:
- #8: register Client → Project → Locations. PR #17, `src/lib/registry/*`
- #12: `sessions.project_key` + `sessions.workspace`. No PR yet.

UI patterns follow the #10 plan (PR #15).

## Global Constraints

- No new dependencies. Tests use `node --test` with `node:assert/strict`, colocated as `<module>.test.mjs`.
- State paths only via `src/lib/state-dir.mjs` helpers (`ledgerFile()`, `dataFile(name)`), called at request/call time, never at module eval.
- Open the session DB per request (`openStore()`), as `src/app/api/sessions/route.js` does today.
- Modules imported by the client page (`session-projects.mjs`, `session-filters.mjs`, `session-tree.mjs`, `session-calendar.mjs`) must not import `fs`/`path`/the register loader.
- No schema change to `cc-sessions.db` in this issue. `project_key` and `workspace` are #12's columns.
- The client is **never** written into the session store.
- The UI is in English (same as the rest of `/sessions`): "Client", "Unassigned", "Workspace", "Main checkout", "Worktrees".
- "Unassigned" always sorts and lists **last**, in both sort directions.
- Filters apply to a **family** by its root session (the same rule as today's Source/Model filters). A linked child that ran in another directory/workspace follows its parent.
- `npm test` and `npm run lint` must not get worse (lint has pre-existing errors, see STATUS.md; add none).

## Review Focus

1. **A session whose `project_key` is not in the register** (key changed `stow:` → `git:`, the register failed to load, or #12 left it null). Expected: the row still shows, with the project name = basename of `project_dir` and client "Unassigned". It is counted under Unassigned in the facets, the legend and analytics, and is never silently dropped. Pinned in Task 1 (`annotateSessions` fallback) and Task 7 (`topClients` unknown key).
2. **The register can't be read** (no ledger yet, malformed `data/registry.json`, `loadRegistry` throws). Expected: `/api/sessions`, `/api/analytics` and the MCP tools still answer, with everything Unassigned and a single `console.warn`. Pinned in Task 5.
3. **Sorting by client or project in either direction.** Expected: Unassigned / unknown stays at the bottom both ways. Pinned in Task 3.
4. **A selected client or project disappears from the loaded data** (the user changes the period or project). Expected: it stays in the dropdown with a count of 0 so it can be unticked, rather than an invisible filter emptying the table. Pinned in Task 1 (`facetCounts(families, { keep })`).
5. **Workspace strings #12 might produce that we don't know** (a new kind, no `": "` separator). Expected: shown verbatim, grouped under "Other", filterable by exact value, no crash. Pinned in Task 1 (`parseWorkspace`).

---

## Design

### What the issue asks for, mapped to features

| Issue text | Feature | Task |
|---|---|---|
| filter Klient | multi-select Client filter with counts (like the project table's Group filter, #10), "Unassigned" last | 1, 2, 6 |
| filter Projekt (virtuálny) | multi-select Project filter over `project_key`. Options narrow to the selected clients | 1, 2, 6 |
| filter Workspace (hlavný checkout / worktrees / konkrétny worker) | single select: Any · Main checkout · All worktrees · one optgroup per kind listing each workspace | 1, 2, 6 |
| sortovanie podľa klienta a projektu | new sortable **Client** column. The **Project** column becomes sortable (virtual project name). New "Group: Client" | 3, 6 |
| kalendár „Color by: client“ | `COLOR_MODES.client`, hashed like `project`, Unassigned in neutral grey, legend top 8 + "+N more" | 4 |
| analytics podľa klienta | "Top clients by cost" card on `/analytics` (Agentic sessions tab). Each bar links to `/sessions?client=<id>` | 7 |
| MCP tools list_clients a projekty podľa klienta | new `list_clients`, new `list_client_projects`. `list_sessions` gains `client` / `project_key` / `workspace` params and output fields | 8 |

### Contract assumed from the prerequisites

Task 0 checks each line against what actually merged, and fixes names **only** in `project-index.mjs` / `session-projects.mjs`.

| From | Assumed | Used by |
|---|---|---|
| #8 | `loadRegistry({ base })` → `{ clients: [{ id, name, projects: [key] }], projects: [{ key, name, client: { id, name, source } \| null, remote, primary, locations: [{ directory, role }] }] }` (as in PR #17's `src/lib/registry/registry.mjs`) | `project-index.mjs`, MCP |
| #8 | `clientKey(name)` in `src/lib/registry/client.mjs`: case/space-insensitive client id | MCP `client` param lookup |
| #8 | `data/registry.json` is the register config file (`REGISTRY_FILE`) | memo key |
| #12 | `sessions.project_key TEXT` = the register project `key` (`git:…`, `stow:…`, `path:…`), null when unresolved. Backfilled. Returned by `listSessions` / `getSession` (`SELECT s.*`) | everything |
| #12 | `sessions.workspace TEXT` = `null` for the main checkout, else `"<kind>: <name>"`, e.g. `"agent-office: pixel-77d1"`. Kinds assumed: `agent-office`, `claude-worktree`, `git-worktree`, `scratchpad` | `parseWorkspace` |
| #12 | `GROUP_BY.project` and analytics `topProjects` already switched to `project_key` by #12 | not touched here |

If #12 ships a structured workspace (for example `workspace_kind` + `workspace_name` columns), only `parseWorkspace` changes.

### Approaches considered

1. **Join at read time** (chosen). The API annotates rows with `client_id`, `client_name`, `project_name` from a memoised register index. The client is always current, there's no schema change and no backfill. Cost: one register load per ledger change, memoised (Task 5 measures it).
2. *Denormalise `client_id` into `sessions` at ingest.* SQL filtering is cheap, but every client reassignment (#10's editor) would need a re-stamp of the sessions, and the store would have a second source of truth. Rejected.
3. *Ship the register to the browser and join there.* No API change, but it sends ~800 projects with their locations on every load, and the MCP server and analytics would still need a server-side join. Rejected.

### Units

- `src/lib/cc/session-projects.mjs` (pure, client-safe)
  - `UNASSIGNED = '__unassigned'`
  - `projectIndex(registry)` → `Map<project_key, { project_key, project_name, client_id, client_name }>`
  - `annotateSessions(rows, index)` → new row objects with `project_name`, `client_id` (`null` = unassigned), `client_name`
  - `parseWorkspace(ws)` → `null` (main) | `{ kind, name, label, raw }`
  - `WORKSPACE_KINDS`: kind → display label
  - `facetCounts(families, { keep })` → `{ clients, projects, workspaces }` with counts. Entries named in `keep` survive with count 0
- `src/lib/cc/project-index.mjs` (server only): `loadProjectIndex({ base, load, stat, now })` with an mtime memo and fail-soft. Also `resolveClient(registry, nameOrId)`
- `session-filters.mjs`: `filterSessions` gains `clients`, `projects`, `workspace`
- `session-tree.mjs`: `GROUP_BY.client`, `SORT_KEYS.client` / `SORT_KEYS.project`, nulls-last in `sortFamilies`
- `session-calendar.mjs`: `COLOR_MODES.client` + a generalised hashed-mode path in `colorBy` / `colorLegend`
- `analytics.mjs`: `sessionAnalytics(db, { since, index })` adds `topClients`
- `src/app/api/sessions/route.js`: `handle(searchParams, db, index)` annotates
- `src/app/sessions/page.js`: filters, column, URL `?client=`
- `src/app/analytics/page.js`: the card
- `src/mcp/server.mjs`: the tools

### Data flow

```
cc-sessions.db (project_key, workspace from #12)        register (#8: ledger + .stow + registry.json)
          │ listSessions                                         │ loadProjectIndex (memo on mtimes)
          └──────────────► handle(searchParams, db, index) ◄──────┘
                              annotateSessions → rows + {project_name, client_id, client_name}
                                       │ JSON
                     page.js → buildSessionTree → filterSessions({clients, projects, workspace})
                              → groupFamilies / sortFamilies (table) | colorBy('client') (calendar)
```

### Out of scope (other issues)

- Filling `project_key` / `workspace` and the workspace badge: #12
- Editing a client or role: #10
- The register model itself, client resolution and name normalisation: #8
- Server-side `?client=` filtering of `/api/sessions`. The table's default load is still the latest 200 top-level sessions (the same limit every existing filter works within). The calendar loads the whole period. See open question 4.

---

## Task 0: Rebase onto the prerequisites and verify the contract

**Files:** none changed unless a name differs.

- [ ] **Step 1:** `git fetch && git rebase origin/main` (once #8 and #12 have merged).
- [ ] **Step 2:** Confirm the #8 shape. Run `node -e "import('./src/lib/registry/registry.mjs').then(async m => { const r = await m.loadRegistry({ base: process.cwd() }); console.log(Object.keys(r), r.projects[0], r.clients[0]) })"` and check it against the contract table.
- [ ] **Step 3:** Confirm the #12 columns. `sqlite3 data/cc-sessions.db "select project_key, workspace, count(*) from sessions group by 1,2 order by 3 desc limit 15"`. Note every distinct workspace prefix and compare it with `WORKSPACE_KINDS` in Task 1.
- [ ] **Step 4:** Record any deviation in the "Contract assumed" table of this doc and adapt the Task 1 / Task 5 code to it before starting them. Commit the doc change: `git commit -am "plan(#13): align with merged #8/#12"`.

## Task 1: `session-projects.mjs` — index, annotation, workspace, facets

**Files:**
- Create: `src/lib/cc/session-projects.mjs`
- Test: `src/lib/cc/session-projects.test.mjs`

**Interfaces:**
- Consumes: the register shape (contract table).
- Produces: `UNASSIGNED`, `WORKSPACE_KINDS`, `projectIndex(registry)`, `annotateSessions(rows, index)`, `parseWorkspace(ws)`, `facetCounts(families, { keep = { clients: [], projects: [], workspace: null } })`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UNASSIGNED, projectIndex, annotateSessions, parseWorkspace, facetCounts } from './session-projects.mjs'

const REGISTRY = {
  clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:gitlab.com/intelimail/blog'] }],
  projects: [
    { key: 'git:gitlab.com/intelimail/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail', source: 'ai' } },
    { key: 'path:/p/sandbox', name: 'sandbox', client: null },
  ],
}

test('projectIndex maps project key to project and client', () => {
  const idx = projectIndex(REGISTRY)
  assert.deepEqual(idx.get('git:gitlab.com/intelimail/blog'),
    { project_key: 'git:gitlab.com/intelimail/blog', project_name: 'blog', client_id: 'intelimail', client_name: 'Intelimail' })
  assert.deepEqual(idx.get('path:/p/sandbox'),
    { project_key: 'path:/p/sandbox', project_name: 'sandbox', client_id: null, client_name: null })
})

test('projectIndex tolerates a missing or empty register', () => {
  assert.equal(projectIndex(null).size, 0)
  assert.equal(projectIndex({}).size, 0)
})

test('annotateSessions joins known keys and falls back for unknown or null keys', () => {
  const idx = projectIndex(REGISTRY)
  const rows = [
    { session_id: 'a', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog-huha' },
    { session_id: 'b', project_key: 'stow:old-id', project_dir: '/p/renamed' },
    { session_id: 'c', project_key: null, project_dir: null },
  ]
  const out = annotateSessions(rows, idx)
  assert.deepEqual(out.map((r) => [r.project_name, r.client_id, r.client_name]), [
    ['blog', 'intelimail', 'Intelimail'],
    ['renamed', null, null],
    ['—', null, null],
  ])
  assert.equal(rows[0].client_id, undefined, 'input rows are not mutated')
})

test('parseWorkspace: main, known kinds, unknown kinds', () => {
  assert.equal(parseWorkspace(null), null)
  assert.equal(parseWorkspace(''), null)
  assert.deepEqual(parseWorkspace('agent-office: pixel-77d1'),
    { kind: 'agent-office', name: 'pixel-77d1', label: 'Agent Office · pixel-77d1', raw: 'agent-office: pixel-77d1' })
  assert.deepEqual(parseWorkspace('weird-thing'),
    { kind: 'other', name: 'weird-thing', label: 'weird-thing', raw: 'weird-thing' })
  assert.equal(parseWorkspace('newkind: x').kind, 'other')
})

test('facetCounts counts families by root, lists Unassigned last, keeps selected zero-count entries', () => {
  const fams = annotateSessions([
    { session_id: 'a', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog', workspace: null },
    { session_id: 'b', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog', workspace: 'agent-office: pixel-1' },
    { session_id: 'c', project_key: 'path:/p/sandbox', project_dir: '/p/sandbox', workspace: null },
  ], projectIndex(REGISTRY))
  const f = facetCounts(fams, { keep: { clients: ['acme'], projects: [], workspace: null } })
  assert.deepEqual(f.clients.map((c) => [c.id, c.count]), [['intelimail', 2], ['acme', 0], [UNASSIGNED, 1]])
  assert.deepEqual(f.projects.map((p) => [p.key, p.count]), [['git:gitlab.com/intelimail/blog', 2], ['path:/p/sandbox', 1]])
  assert.deepEqual(f.workspaces, { main: 2, worktrees: 1, byKind: [{ kind: 'agent-office', label: 'Agent Office', items: [{ value: 'agent-office: pixel-1', label: 'pixel-1', count: 1 }] }] })
})
```

- [ ] **Step 2: Run it and check it fails**

Run: `node --test src/lib/cc/session-projects.test.mjs`
Expected: FAIL, `Cannot find module './session-projects.mjs'`

- [ ] **Step 3: Implement**

```js
/**
 * Virtual-project view of sessions (#13): joins #12's `project_key` to #8's
 * register at read time, parses #12's `workspace`, and counts filter facets.
 * Pure and client-safe — the register itself is loaded server-side
 * (project-index.mjs) and only its index travels here.
 */

export const UNASSIGNED = '__unassigned'

export const WORKSPACE_KINDS = {
  'agent-office': 'Agent Office',
  'claude-worktree': 'Claude worktree',
  'git-worktree': 'Git worktree',
  scratchpad: 'Scratchpad',
  other: 'Other',
}

const baseName = (dir) => (dir ? dir.split('/').filter(Boolean).at(-1) : '') || '—'

export function projectIndex(registry) {
  const idx = new Map()
  for (const p of registry?.projects || []) {
    idx.set(p.key, { project_key: p.key, project_name: p.name, client_id: p.client?.id ?? null, client_name: p.client?.name ?? null })
  }
  return idx
}

export function annotateSessions(rows, index) {
  return (rows || []).map((r) => {
    const hit = r.project_key ? index?.get(r.project_key) : null
    return { ...r, project_name: hit?.project_name || baseName(r.project_dir), client_id: hit?.client_id ?? null, client_name: hit?.client_name ?? null }
  })
}

export function parseWorkspace(ws) {
  if (!ws) return null
  const i = ws.indexOf(': ')
  const kind = i > 0 ? ws.slice(0, i) : null
  if (!kind || !WORKSPACE_KINDS[kind] || kind === 'other') return { kind: 'other', name: ws, label: ws, raw: ws }
  const name = ws.slice(i + 2)
  return { kind, name, label: `${WORKSPACE_KINDS[kind]} · ${name}`, raw: ws }
}

const lastUnassigned = (a, b) => (a.id === UNASSIGNED) - (b.id === UNASSIGNED) || b.count - a.count || a.name.localeCompare(b.name)

export function facetCounts(families, { keep = {} } = {}) {
  const clients = new Map(), projects = new Map(), kinds = new Map()
  let main = 0, worktrees = 0
  for (const f of families || []) {
    const cid = f.client_id || UNASSIGNED
    const c = clients.get(cid) || { id: cid, name: f.client_name || 'Unassigned', count: 0 }
    c.count++; clients.set(cid, c)
    const pk = f.project_key || `dir:${f.project_dir || ''}`
    const p = projects.get(pk) || { key: pk, name: f.project_name || baseName(f.project_dir), client_id: f.client_id ?? null, count: 0 }
    p.count++; projects.set(pk, p)
    const ws = parseWorkspace(f.workspace)
    if (!ws) { main++; continue }
    worktrees++
    const k = kinds.get(ws.kind) || { kind: ws.kind, label: WORKSPACE_KINDS[ws.kind], items: new Map() }
    const it = k.items.get(ws.raw) || { value: ws.raw, label: ws.name, count: 0 }
    it.count++; k.items.set(ws.raw, it); kinds.set(ws.kind, k)
  }
  for (const id of keep.clients || []) if (!clients.has(id)) clients.set(id, { id, name: id === UNASSIGNED ? 'Unassigned' : id, count: 0 })
  for (const key of keep.projects || []) if (!projects.has(key)) projects.set(key, { key, name: key, client_id: null, count: 0 })
  const kindOrder = Object.keys(WORKSPACE_KINDS)
  return {
    clients: [...clients.values()].sort(lastUnassigned),
    projects: [...projects.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    workspaces: {
      main, worktrees,
      byKind: [...kinds.values()]
        .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))
        .map((k) => ({ ...k, items: [...k.items.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) })),
    },
  }
}
```

(When a kept client has count 0, the page passes its display name from the previous facet list, so `name: id` only shows for a deep-linked id that never loaded.)

- [ ] **Step 4: Run it and check it passes.** `node --test src/lib/cc/session-projects.test.mjs` → PASS
- [ ] **Step 5: Commit.** `git add src/lib/cc/session-projects.* && git commit -m "feat(sessions): virtual-project join, workspace parse and facet counts (#13)"`

## Task 2: Client / Project / Workspace filters

**Files:**
- Modify: `src/lib/cc/session-filters.mjs` (`filterSessions`)
- Test: `src/lib/cc/session-filters.test.mjs` (append)

**Interfaces:**
- Consumes: `UNASSIGNED`, `parseWorkspace` from Task 1. Rows annotated by `annotateSessions`.
- Produces: `filterSessions(sessions, { …existing, clients = [], projects = [], workspace = 'any' })`. `workspace` is `'any' | 'main' | 'worktrees' | <exact workspace string>`.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { UNASSIGNED } from './session-projects.mjs'

const VP = [
  { session_id: 'a', client_id: 'intelimail', project_key: 'git:x/blog', workspace: null },
  { session_id: 'b', client_id: 'intelimail', project_key: 'git:x/app', workspace: 'agent-office: pixel-1' },
  { session_id: 'c', client_id: null, project_key: 'path:/p/sandbox', workspace: 'claude-worktree: tmp' },
  { session_id: 'd', client_id: 'acme', project_key: null, workspace: null },
]

test('client filter: OR over selected ids, UNASSIGNED matches null', () => {
  assert.deepEqual(ids(filterSessions(VP, { clients: ['intelimail'] })), ['a', 'b'])
  assert.deepEqual(ids(filterSessions(VP, { clients: [UNASSIGNED, 'acme'] })), ['c', 'd'])
  assert.deepEqual(ids(filterSessions(VP, { clients: [] })), ['a', 'b', 'c', 'd'])
})

test('project filter matches project_key exactly', () => {
  assert.deepEqual(ids(filterSessions(VP, { projects: ['git:x/app', 'path:/p/sandbox'] })), ['b', 'c'])
})

test('workspace filter: main, worktrees, exact value', () => {
  assert.deepEqual(ids(filterSessions(VP, { workspace: 'main' })), ['a', 'd'])
  assert.deepEqual(ids(filterSessions(VP, { workspace: 'worktrees' })), ['b', 'c'])
  assert.deepEqual(ids(filterSessions(VP, { workspace: 'agent-office: pixel-1' })), ['b'])
  assert.deepEqual(ids(filterSessions(VP, { workspace: 'any' })), ['a', 'b', 'c', 'd'])
})

test('client, project and workspace combine with AND', () => {
  assert.deepEqual(ids(filterSessions(VP, { clients: ['intelimail'], workspace: 'main' })), ['a'])
})

test('search also matches client and virtual project names', () => {
  const rows = [{ session_id: 'x', client_name: 'Intelimail', project_name: 'blog', project_dir: '/p/blog-huha' }]
  assert.deepEqual(ids(filterSessions(rows, { search: 'inteli' })), ['x'])
})
```

- [ ] **Step 2: Run them and check they fail.** `node --test src/lib/cc/session-filters.test.mjs` → the new tests fail (the filters are ignored).
- [ ] **Step 3: Implement.** In `filterSessions`, extend the destructuring and add the tests before the quick filters:

```js
import { UNASSIGNED } from './session-projects.mjs'
// signature:
export function filterSessions(sessions, { search = '', ticket = '', quality = 'any', model = 'any', source = 'any', quick = [], clients = [], projects = [], workspace = 'any', now = Date.now() } = {}) {
  // …existing setup…
  const clientSet = clients?.length ? new Set(clients) : null
  const projectSet = projects?.length ? new Set(projects) : null
  const ws = !workspace || workspace === 'any' ? null : workspace
  // inside the filter callback, in the search block add:
  //   const matchClient = (s.client_name || '').toLowerCase().includes(needle)
  //   const matchVp = (s.project_name || '').toLowerCase().includes(needle)
  //   and include them in the `if (!… && !…) return false` condition
  // after the source check:
    if (clientSet && !clientSet.has(s.client_id || UNASSIGNED)) return false
    if (projectSet && !projectSet.has(s.project_key)) return false
    if (ws === 'main' && s.workspace) return false
    if (ws === 'worktrees' && !s.workspace) return false
    if (ws && ws !== 'main' && ws !== 'worktrees' && s.workspace !== ws) return false
```

- [ ] **Step 4: Run them and check they pass.** `node --test src/lib/cc/session-filters.test.mjs` → PASS (the old tests too).
- [ ] **Step 5: Commit.** `git commit -am "feat(sessions): client, virtual project and workspace filters (#13)"`

## Task 3: Sort by client and project, group by client

**Files:**
- Modify: `src/lib/cc/session-tree.mjs` (`GROUP_BY`, `SORT_KEYS`, `sortFamilies`)
- Test: `src/lib/cc/session-tree.test.mjs` (append)

**Interfaces:**
- Produces: `GROUP_BY.client`, `SORT_KEYS.client`, `SORT_KEYS.project`. `sortFamilies` puts `null` values last in both directions.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { UNASSIGNED } from './session-projects.mjs'

const fam = (id, client_name, project_name, cost) => ({ session_id: id, client_id: client_name ? client_name.toLowerCase() : null, client_name, project_name, rollup: { cost_usd: cost } })
const FAMS = [fam('a', 'Zeta', 'web', 1), fam('b', null, 'sandbox', 5), fam('c', 'Acme', 'api', 2), fam('d', 'Acme', 'web', 3)]
const sid = (fs) => fs.map((f) => f.session_id)

test('sort by client keeps Unassigned last in both directions', () => {
  assert.deepEqual(sid(sortFamilies(FAMS, { key: 'client', dir: 'asc' })), ['c', 'd', 'a', 'b'])
  assert.deepEqual(sid(sortFamilies(FAMS, { key: 'client', dir: 'desc' })), ['a', 'c', 'd', 'b'])
})

test('sort by project uses the virtual project name', () => {
  assert.deepEqual(sid(sortFamilies(FAMS, { key: 'project', dir: 'asc' })), ['c', 'b', 'a', 'd'])
})

test('group by client: buckets by cost, Unassigned last regardless of cost', () => {
  const g = groupFamilies(FAMS, 'client')
  assert.deepEqual(g.map((x) => [x.key, x.label, x.count]), [['acme', 'Acme', 2], ['zeta', 'Zeta', 1], [UNASSIGNED, 'Unassigned', 1]])
})
```

- [ ] **Step 2: Run them and check they fail.** `node --test src/lib/cc/session-tree.test.mjs`
- [ ] **Step 3: Implement**

```js
import { UNASSIGNED } from './session-projects.mjs'

// GROUP_BY, after `project`:
  client: { label: 'Client', key: (f) => f.client_id || UNASSIGNED, text: (k, items) => (k === UNASSIGNED ? 'Unassigned' : items[0].client_name || k), order: 'cost', last: UNASSIGNED },

// groupFamilies: build labels with `def.text ? def.text(key, items) : key`, and in the cost sort
// put `def.last` at the end:
  else groups.sort((a, b) => (a.key === def.last) - (b.key === def.last) || (b.sum.cost_usd - a.sum.cost_usd) || a.label.localeCompare(b.label));

// SORT_KEYS:
  client: (f) => f.client_name || null,
  project: (f) => f.project_name || null,

// sortFamilies comparator — nulls last whatever the direction:
    .sort((a, b) => {
      if (a.v == null || b.v == null) return (a.v == null) - (b.v == null) || a.i - b.i
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
      return c !== 0 ? c * sign : a.i - b.i;
    })
```

(The existing `text: (k) => projectName(k)` on `GROUP_BY.project` keeps working, because the extra argument is ignored.)

- [ ] **Step 4: Run them and check they pass.** Run `node --test src/lib/cc/session-tree.test.mjs`. Existing tests must stay green: the current keys never return null.
- [ ] **Step 5: Commit.** `git commit -am "feat(sessions): sort by client/project, group by client (#13)"`

## Task 4: Calendar "Color by: Client"

**Files:**
- Modify: `src/lib/cc/session-calendar.mjs` (`COLOR_MODES`, `colorBy`, `colorLegend`)
- Test: `src/lib/cc/session-calendar.test.mjs` (append)

**Interfaces:**
- Consumes: `UNASSIGNED`.
- Produces: `COLOR_MODES.client = { label: 'Client' }`, `colorBy(e, 'client')` → `{ key, label, color }`. Picked up automatically by `useColorMode` / the table's colour bar, which iterate `COLOR_MODES`.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { UNASSIGNED } from './session-projects.mjs'

test('colorBy client: hashed hue per client id, neutral for unassigned', () => {
  const a = colorBy({ client_id: 'intelimail', client_name: 'Intelimail' }, 'client')
  assert.equal(a.key, 'intelimail')
  assert.equal(a.label, 'Intelimail')
  assert.match(a.color, /^var\(--viz-[1-6]\)$/)
  assert.deepEqual(colorBy({ client_id: null }, 'client'), { key: UNASSIGNED, label: 'Unassigned', color: 'var(--viz-axis)' })
})

test('colorLegend client: most frequent first, Unassigned last, capped with +N more', () => {
  const ev = [
    ...Array(3).fill({ client_id: 'a', client_name: 'A' }),
    { client_id: null },
    ...'bcdefghij'.split('').map((c) => ({ client_id: c, client_name: c.toUpperCase() })),
  ]
  const legend = colorLegend(ev, 'client')
  assert.equal(legend[0].label, 'A')
  assert.equal(legend.at(-1).key, UNASSIGNED)
  assert.ok(legend.some((x) => x.key === 'more'))
})
```

- [ ] **Step 2: Run them and check they fail.** `node --test src/lib/cc/session-calendar.test.mjs`
- [ ] **Step 3: Implement.** Generalise the project special case into a "hashed" mode:

```js
import { UNASSIGNED } from './session-projects.mjs'

// COLOR_MODES, after `project`:
  client: { label: 'Client' },

const HASHED = {
  project: (e) => ({ key: e.project_dir || '', label: projectName(e.project_dir), color: projectColor(e.project_dir) }),
  client: (e) => (e.client_id
    ? { key: e.client_id, label: e.client_name || e.client_id, color: projectColor(e.client_id) }
    : { key: UNASSIGNED, label: 'Unassigned', color: NEUTRAL }),
}

export function colorBy(e, mode) {
  if (HASHED[mode]) return HASHED[mode](e)
  // …unchanged…
}

// colorLegend: replace `if (mode === 'project')` with `if (HASHED[mode])`, and pull a
// present UNASSIGNED bucket out before ranking, then append it after the "+N more" tail:
  if (HASHED[mode]) {
    const un = counts.get(UNASSIGNED)
    counts.delete(UNASSIGNED)
    const all = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    const head = all.length <= PROJECT_LEGEND_MAX + 1 ? all
      : [...all.slice(0, PROJECT_LEGEND_MAX), { key: 'more', label: `+${all.length - PROJECT_LEGEND_MAX} more`, color: null, count: all.slice(PROJECT_LEGEND_MAX).reduce((s, x) => s + x.count, 0) }]
    return un ? [...head, un] : head
  }
```

`projectColor` is just a string hash, so reusing it for client ids is fine. Six hues means collisions past six clients. The legend disambiguates, the same as for projects today.

- [ ] **Step 4: Run them and check they pass.** `node --test src/lib/cc/session-calendar.test.mjs` (the existing project-legend tests stay green).
- [ ] **Step 5: Commit.** `git commit -am "feat(sessions): Color by client (#13)"`

## Task 5: Server-side project index + `/api/sessions` annotation

**Files:**
- Create: `src/lib/cc/project-index.mjs`
- Test: `src/lib/cc/project-index.test.mjs`
- Modify: `src/app/api/sessions/route.js` (`handle`, `GET`)
- Test: `src/app/api/sessions/route.test.mjs` (append)

**Interfaces:**
- Consumes: `loadRegistry` (#8), `ledgerFile()`, `dataFile('registry.json')`, `projectIndex`, `annotateSessions`.
- Produces:
  - `loadProjectIndex({ base, load = loadRegistry, stat = fs.stat }) → Promise<{ index: Map, registry: object | null }>`. Memoised on `ledger mtime + registry.json mtime`. Never rejects; on failure it returns an empty Map and `registry: null`, warning once per distinct error message.
  - `resetProjectIndexMemo()` for tests.
  - `resolveClient(registry, q)` → `{ id, name } | 'unassigned' | null`. Matches `q` by id or by `clientKey(name)`. `'unassigned'` (case-insensitive) gives the sentinel.
  - `handle(searchParams, db, index = new Map())` annotates `sessions` (and `getSession`'s `session`, `children`, `parent`).

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/cc/project-index.test.mjs
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadProjectIndex, resetProjectIndexMemo, resolveClient } from './project-index.mjs'

const REG = { clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:x/blog'] }], projects: [{ key: 'git:x/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail' } }] }
beforeEach(() => resetProjectIndexMemo())

test('builds the index from the register and memoises on mtimes', async () => {
  let loads = 0, mtime = 1
  const opts = { base: '/b', load: async () => { loads++; return REG }, stat: async () => ({ mtimeMs: mtime }) }
  const a = await loadProjectIndex(opts)
  await loadProjectIndex(opts)
  assert.equal(loads, 1)
  assert.equal(a.index.get('git:x/blog').client_name, 'Intelimail')
  mtime = 2
  await loadProjectIndex(opts)
  assert.equal(loads, 2)
})

test('a missing registry.json still loads (stat failure is just a memo key)', async () => {
  const r = await loadProjectIndex({ base: '/b', load: async () => REG, stat: async () => { throw new Error('ENOENT') } })
  assert.equal(r.index.size, 1)
})

test('fails soft: a throwing register gives an empty index', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const r = await loadProjectIndex({ base: '/b', load: async () => { throw new Error('bad registry.json') }, stat: async () => ({ mtimeMs: 1 }) })
  assert.equal(r.index.size, 0)
  assert.equal(r.registry, null)
  assert.equal(warn.mock.callCount(), 1)
})

test('resolveClient by id, by name (case/space-insensitive) and unassigned', () => {
  assert.deepEqual(resolveClient(REG, 'intelimail'), { id: 'intelimail', name: 'Intelimail' })
  assert.deepEqual(resolveClient(REG, ' InteliMail '), { id: 'intelimail', name: 'Intelimail' })
  assert.equal(resolveClient(REG, 'Unassigned'), 'unassigned')
  assert.equal(resolveClient(REG, 'nobody'), null)
})
```

```js
// src/app/api/sessions/route.test.mjs — append (use the file's existing in-memory store seeding)
import { projectIndex } from '../../../lib/cc/session-projects.mjs'

test('handle annotates list rows with client and virtual project', () => {
  const db = openStore(':memory:')
  upsertSession(db, { session_id: 's1', project_dir: '/p/blog-huha', project_key: 'git:x/blog', started_at: '2026-10-01T10:00:00Z', ingested_at: 'x' })
  const idx = projectIndex({ projects: [{ key: 'git:x/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail' } }] })
  const out = handle(new URLSearchParams(), db, idx)
  assert.equal(out.sessions[0].client_name, 'Intelimail')
  assert.equal(out.sessions[0].project_name, 'blog')
  assert.equal(handle(new URLSearchParams(), db).sessions[0].client_id, null, 'no index → unassigned, not a crash')
})
```

(If #12's `upsertSession` doesn't accept `project_key`, set it with `db.prepare('UPDATE sessions SET project_key=? WHERE session_id=?').run(...)`. Task 0 tells you which.)

- [ ] **Step 2: Run them and check they fail.** `node --test --disable-warning=ExperimentalWarning src/lib/cc/project-index.test.mjs src/app/api/sessions/route.test.mjs`
- [ ] **Step 3: Implement `project-index.mjs`**

```js
/**
 * Server-side register → session index (#13). The register (#8) reads the
 * ledger plus every checkout's .stow meta, so it is memoised on the ledger
 * and registry.json mtimes. Never throws: sessions must render without it.
 */
import fs from 'fs/promises'
import { loadRegistry } from '../registry/registry.mjs'
import { clientKey } from '../registry/client.mjs'
import { ledgerFile, dataFile } from '../state-dir.mjs'
import { projectIndex } from './session-projects.mjs'

let memo = null
let lastWarn = null

export function resetProjectIndexMemo() { memo = null; lastWarn = null }

const mtime = async (stat, file) => { try { return (await stat(file)).mtimeMs } catch { return 0 } }

export async function loadProjectIndex({ base, load = loadRegistry, stat = fs.stat } = {}) {
  const sig = `${await mtime(stat, ledgerFile({ base }))}:${await mtime(stat, dataFile('registry.json', { base }))}`
  if (memo?.sig === sig) return memo.value
  let value
  try {
    const registry = await load({ base })
    value = { registry, index: projectIndex(registry) }
  } catch (err) {
    if (lastWarn !== err.message) { console.warn('[sessions] register unavailable, sessions shown unassigned:', err.message); lastWarn = err.message }
    value = { registry: null, index: new Map() }
  }
  memo = { sig, value }
  return value
}

export function resolveClient(registry, q) {
  const s = String(q || '').trim()
  if (!s) return null
  if (s.toLowerCase() === 'unassigned') return 'unassigned'
  const k = clientKey(s)
  const c = (registry?.clients || []).find((x) => x.id === s || clientKey(x.name) === k)
  return c ? { id: c.id, name: c.name } : null
}
```

(Check the `ledgerFile` / `dataFile` signatures in `state-dir.mjs`; today `dataFile(name, base)` is used positionally by the MCP server. Match whatever it is.)

- [ ] **Step 4: Wire the route**

```js
import { annotateSessions } from '../../../lib/cc/session-projects.mjs'
import { loadProjectIndex } from '../../../lib/cc/project-index.mjs'

export function handle(searchParams, db, index = new Map()) {
  const id = searchParams.get('id')
  if (id) {
    const d = getSession(db, id)
    if (!d) return { session: null }
    const [session] = annotateSessions([d.session], index)
    return { ...d, session, children: annotateSessions(d.children || [], index), parent: d.parent ? annotateSessions([d.parent], index)[0] : d.parent }
  }
  // …unchanged up to listSessions…
  const sessions = annotateSessions(listSessions(db, { project, limit, since, until }), index)
  return { sessions, agents: listSubagents(db, sessions.map((s) => s.session_id)) }
}

export async function GET(request) {
  const { index } = await loadProjectIndex({ base: process.cwd() })
  const db = openStore()
  // …unchanged, pass `index` to handle()…
}
```

- [ ] **Step 5: Run them and check they pass**, then measure. With the real data run `node -e "import('./src/lib/cc/project-index.mjs').then(async m => { console.time('cold'); await m.loadProjectIndex({ base: process.cwd() }); console.timeEnd('cold'); console.time('warm'); await m.loadProjectIndex({ base: process.cwd() }); console.timeEnd('warm') })"` and write both numbers into the PR. Warm must be under 5 ms.
- [ ] **Step 6: Commit.** `git add -A src/lib/cc/project-index.* src/app/api/sessions && git commit -m "feat(sessions): annotate sessions with client and virtual project from the register (#13)"`

## Task 6: `/sessions` UI — filters, Client column, sortable Project, URL deep link

**Files:**
- Modify: `src/app/sessions/page.js`
- Possibly create: `src/app/sessions/facet-select.js` (multi-select popover, see Step 1)

No unit tests (wiring). The logic is covered by Tasks 1–4. Verify in the browser.

- [ ] **Step 1: Multi-select component.** Reuse whatever multi-select #10 ships for the project table's Client filter (check `src/components/` after rebasing). If it isn't reusable, create `facet-select.js`: a shadcn `Popover` + checkbox list showing `name (count)`, with a "Clear" footer, the same markup as the Group filter in `src/app/project-table.js`. Props: `{ label, options: [{ value, label, count }], selected: string[], onChange }`. The trigger reads `Client: any` / `Client: Intelimail` / `Client: 3 selected`.
- [ ] **Step 2: State and facets.** Next to the other filter state:

```js
const [clientFilter, setClientFilter] = useState(() => (searchParams.get('client') ? [searchParams.get('client')] : []))
const [projectFilter, setProjectFilter] = useState([])
const [workspaceFilter, setWorkspaceFilter] = useState('any')
const facets = useMemo(() => facetCounts(families, { keep: { clients: clientFilter, projects: projectFilter } }), [families, clientFilter, projectFilter])
const projectOptions = clientFilter.length ? facets.projects.filter((p) => clientFilter.includes(p.client_id || UNASSIGNED) || projectFilter.includes(p.key)) : facets.projects
```

Pass `clients: clientFilter, projects: projectFilter, workspace: workspaceFilter` into the existing `filterSessions(...)` call (line ~510). Facets are counted over `families` **before** filtering, so the counts don't collapse as you tick.

- [ ] **Step 3: Controls.** Put them in the filter bar before Model:
  - `<FacetSelect label="Client" …>`, options from `facets.clients` (Unassigned last, as returned).
  - `<FacetSelect label="Project" …>`, options from `projectOptions`.
  - Workspace `<select className={SEL}>`: `Workspace: any`, `Main checkout (n)`, `All worktrees (n)`, then one `<optgroup label={k.label}>` per `facets.workspaces.byKind`, each item `label (count)` with `value={item.value}`. If the current `workspaceFilter` is a specific value that is no longer in the data, render it as an extra `<option>` with `(0)` (Review Focus 4).
  - Sync `clientFilter` to the URL (`?client=` when exactly one is selected, removed otherwise), using the existing `qs` helper at line ~452, so the analytics links (Task 7) and copy-paste work.
- [ ] **Step 4: Columns.**
  - Add a **Client** `<SortHead>` column right before Project. The cell shows `client_name`, or a muted "—" for unassigned.
  - Make the Project header a `SortHead` with key `project`. The cell shows `s.project_name` (falling back to `projectName(s.project_dir)`) with `title={s.project_dir}`. #12's workspace badge stays wherever #12 put it.
  - "Group: Client" appears automatically from `GROUP_BY`.
- [ ] **Step 5: Detail sheet.** Under the project name, add a line `Client: Intelimail` (or "Unassigned") as a button that sets `clientFilter=[id]`, mirroring the existing "filter to this project" button.
- [ ] **Step 6: Browser check** (`npm run dev`, port 3089) on real data:
  1. Pick Client = Intelimail. Only Intelimail rows remain, and the Project options shrink to Intelimail's projects.
  2. Pick Unassigned. You get unassigned rows only.
  3. Sort the Client column asc, then desc. Unassigned stays at the bottom both times.
  4. Workspace = All worktrees, then a specific `agent-office: …` worker.
  5. Switch to Calendar, Color by Client. The legend shows clients with Unassigned last, and the filters still apply.
  6. Change to an empty week with a client selected. The client is still listed with (0) and can be unticked.
  7. Open `/sessions?client=intelimail` directly. The filter is preselected.
  8. Check dark mode legibility of the new controls.
- [ ] **Step 7: Lint and commit.** `npx eslint src/app/sessions src/lib/cc` clean, then `git commit -am "feat(sessions): client/project/workspace filters and Client column (#13)"`

## Task 7: Analytics by client

**Files:**
- Modify: `src/lib/cc/analytics.mjs` (`sessionAnalytics`)
- Test: `src/lib/cc/analytics.test.mjs` (append)
- Modify: `src/app/api/analytics/route.js`, `src/app/analytics/page.js`

**Interfaces:**
- Consumes: `loadProjectIndex`, `UNASSIGNED`.
- Produces: `sessionAnalytics(db, { since, index = new Map() })` returns an extra `topClients: [{ client_id, client, sessions, cost_usd }]`. Sorted by cost, top 8 named clients, then Unassigned (if any) last. `sessions` counts top-level sessions only, matching `topProjects`.

- [ ] **Step 1: Write the failing test** (append; extend `seedStore` so `s1`/`s3` get `project_key: 'git:x/alpha'` and `s2` gets `'stow:gone'`, using the same mechanism as in Task 5)

```js
import { projectIndex, UNASSIGNED } from './session-projects.mjs'

test('topClients folds project_key costs into clients; unknown keys are Unassigned, last', () => {
  const db = seedStore()
  const index = projectIndex({ projects: [{ key: 'git:x/alpha', name: 'alpha', client: { id: 'acme', name: 'Acme' } }] })
  const { topClients } = sessionAnalytics(db, { index })
  assert.deepEqual(topClients.map((c) => [c.client_id, c.client, c.sessions, c.cost_usd]), [
    ['acme', 'Acme', 2, 11.5],
    [UNASSIGNED, 'Unassigned', 1, 3],
  ])
})
```

- [ ] **Step 2: Run it and check it fails.** `node --test --disable-warning=ExperimentalWarning src/lib/cc/analytics.test.mjs`
- [ ] **Step 3: Implement** (next to `topProjects`)

```js
  const byKey = all(`
    SELECT s.project_key, sum(parent_session_id IS NULL) sessions, coalesce(sum(cost_usd), 0) cost_usd
    FROM sessions s ${where} GROUP BY s.project_key`)
  const clientMap = new Map()
  for (const r of byKey) {
    const hit = r.project_key ? index.get(r.project_key) : null
    const id = hit?.client_id || UNASSIGNED
    const c = clientMap.get(id) || { client_id: id, client: hit?.client_name || 'Unassigned', sessions: 0, cost_usd: 0 }
    c.sessions += r.sessions; c.cost_usd += r.cost_usd
    clientMap.set(id, c)
  }
  const un = clientMap.get(UNASSIGNED)
  clientMap.delete(UNASSIGNED)
  const topClients = [...[...clientMap.values()].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 8), ...(un ? [un] : [])]
```

Add `topClients` to the returned object and `index = new Map()` to the options destructuring.

- [ ] **Step 4: Wire it.** In `src/app/api/analytics/route.js`, `const { index } = await loadProjectIndex({ base: process.cwd() })` before opening the db, then pass `{ since, index }`. In `src/app/analytics/page.js`, add a `<Card title="Top clients by cost" subtitle="list price, USD">` with `<HBar data={s.topClients} nameKey="client" valueKey="cost_usd" valueFormatter={fmtCost} />` next to "Top projects by cost". If `HBar` supports a click/href prop, link each bar to `/sessions?client=<client_id>`. If not, add a simple linked list under the chart rather than changing `HBar`'s API.
- [ ] **Step 5: Run it, check in the browser** (`/analytics`, 30d), **commit.** `git commit -am "feat(analytics): top clients by cost (#13)"`

## Task 8: MCP — `list_clients`, `list_client_projects`, client-aware `list_sessions`

**Files:**
- Modify: `src/mcp/server.mjs` (tool list + handlers)
- Create: `src/mcp/sessions-by-client.mjs` (pure helpers, so they can be tested without the stdio server)
- Test: `src/mcp/sessions-by-client.test.mjs`

**Interfaces:**
- Consumes: `loadProjectIndex`, `resolveClient`, `annotateSessions`, `filterSessions`, `UNASSIGNED`, `buildSessionTree`, `listSessions`.
- Produces:
  - `clientsSummary(registry, sessionsByKey)` → `[{ id, name, projects, sessions, cost_usd }]`, with Unassigned last. `sessionsByKey` is a `Map<project_key, { sessions, cost_usd }>`.
  - `clientProjects(registry, client)` → `[{ key, name, remote, primary, locations: [{ directory, role }] }]`. `client` is `{id}` or `'unassigned'`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientsSummary, clientProjects } from './sessions-by-client.mjs'

const REG = {
  clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:x/blog', 'git:x/app'] }],
  projects: [
    { key: 'git:x/blog', name: 'blog', remote: 'x/blog', primary: '/p/blog', client: { id: 'intelimail', name: 'Intelimail' }, locations: [{ directory: '/p/blog', role: 'primary' }, { directory: '/p/blog-huha', role: 'experiment' }] },
    { key: 'git:x/app', name: 'app', remote: 'x/app', primary: '/p/app', client: { id: 'intelimail', name: 'Intelimail' }, locations: [{ directory: '/p/app', role: 'primary' }] },
    { key: 'path:/p/sandbox', name: 'sandbox', remote: null, primary: '/p/sandbox', client: null, locations: [{ directory: '/p/sandbox', role: 'primary' }] },
  ],
}

test('clientsSummary: project counts from the register, session numbers from the period, Unassigned last', () => {
  const stats = new Map([['git:x/blog', { sessions: 3, cost_usd: 4.5 }], ['path:/p/sandbox', { sessions: 1, cost_usd: 1 }]])
  assert.deepEqual(clientsSummary(REG, stats), [
    { id: 'intelimail', name: 'Intelimail', projects: 2, sessions: 3, cost_usd: 4.5 },
    { id: 'unassigned', name: 'Unassigned', projects: 1, sessions: 1, cost_usd: 1 },
  ])
})

test('clientProjects lists a client’s projects with locations; unassigned works', () => {
  assert.deepEqual(clientProjects(REG, { id: 'intelimail' }).map((p) => [p.name, p.locations.length]), [['app', 1], ['blog', 2]])
  assert.deepEqual(clientProjects(REG, 'unassigned').map((p) => p.name), ['sandbox'])
})
```

- [ ] **Step 2: Run them and check they fail.** `node --test src/mcp/sessions-by-client.test.mjs`
- [ ] **Step 3: Implement `sessions-by-client.mjs`**

```js
/** Pure helpers behind the MCP client tools (#13). */
const pick = ({ key, name, remote, primary, locations }) => ({ key, name, remote, primary, locations: (locations || []).map(({ directory, role }) => ({ directory, role })) })

export function clientsSummary(registry, sessionsByKey = new Map()) {
  const rows = new Map()
  for (const p of registry?.projects || []) {
    const id = p.client?.id || 'unassigned'
    const r = rows.get(id) || { id, name: p.client?.name || 'Unassigned', projects: 0, sessions: 0, cost_usd: 0 }
    const s = sessionsByKey.get(p.key)
    r.projects++
    if (s) { r.sessions += s.sessions; r.cost_usd = Number((r.cost_usd + s.cost_usd).toFixed(2)) }
    rows.set(id, r)
  }
  return [...rows.values()].sort((a, b) => (a.id === 'unassigned') - (b.id === 'unassigned') || b.cost_usd - a.cost_usd || a.name.localeCompare(b.name))
}

export function clientProjects(registry, client) {
  const want = client === 'unassigned' ? null : client?.id
  return (registry?.projects || [])
    .filter((p) => (p.client?.id ?? null) === want)
    .map(pick)
    .sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Wire the server.**
  - Tool list additions:
    - `list_clients`: "List clients (from the virtual-project register) with their project count and, for an optional period, AI session count and cost. Unassigned projects are reported as client 'unassigned'." Params `since?`, `until?` (same format as `list_sessions`).
    - `list_client_projects`: "List the virtual projects of one client, each with its checkouts (directory + role). Pass the client id or name, or 'unassigned'." Param `client` (required).
    - `list_sessions`: add the params `client` (id/name/'unassigned'), `project_key`, `workspace` ('main' | 'worktrees' | exact value). Add the output fields `client`, `project_key`, `project_name`, `workspace`.
  - Handlers: `const { registry, index } = await loadProjectIndex({ base: STATE })` (the server's repo-root base, the same `STATE` it passes to `dataFile`).
    - `list_clients`: when `since`/`until` are given, `sessionsByKey` comes from `SELECT project_key, sum(parent_session_id IS NULL) sessions, coalesce(sum(cost_usd),0) cost_usd FROM sessions WHERE started_at >= ? AND started_at < ? GROUP BY project_key`. Otherwise use an empty Map. Return `clientsSummary(registry, sessionsByKey)`.
    - `list_client_projects`: `resolveClient(registry, args.client)`. On `null`, return an `isError` text that lists the available client names. Otherwise `clientProjects(...)`.
    - `list_sessions`: annotate `rows` with `annotateSessions(rows, index)` before `buildSessionTree`. Then apply `filterSessions(fams, { clients: c ? [c === 'unassigned' ? UNASSIGNED : c.id] : [], projects: args.project_key ? [args.project_key] : [], workspace: args.workspace || 'any' })` before the kind filter. An unknown `client` returns the same `isError` as above.
  - If `registry` is `null` (the register failed), the two new tools return an `isError` text saying the register is unavailable. `list_sessions` keeps working, with everything unassigned.
- [ ] **Step 5: Smoke test.** Run `npm run mcp` with the MCP inspector, or pipe a `tools/call` JSON-RPC line, and call `list_clients` and `list_client_projects {client:"intelimail"}`.
- [ ] **Step 6: Commit.** `git add src/mcp && git commit -m "feat(mcp): list_clients, list_client_projects, client filters on list_sessions (#13)"`

## Task 9: Docs, then full verification

**Files:** `CLAUDE.md`, `STATUS.md`

- [ ] **Step 1: CLAUDE.md.**
  - Add `src/lib/cc/session-projects.mjs`, `src/lib/cc/project-index.mjs` and `src/mcp/sessions-by-client.mjs` to Important Files.
  - Add a short "Virtual projects in sessions" paragraph under the session store section: read-time join, memo, Unassigned semantics, `?client=` deep link.
  - Add `client` to the Color by list.
  - MCP: "Tools (25)" plus the two new names, and the new `list_sessions` params.
- [ ] **Step 2: STATUS.md.** Set `NEXT:` via the status-keeper skill.
- [ ] **Step 3: Full checks.** `npm test` (all green), and `npm run lint` with no new errors compared to `main`.
- [ ] **Step 4: Commit, push, PR** with "Closes #13" and the Task 5 timing numbers.
