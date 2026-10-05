# Virtual Projects 3/6: Projects UI (client → project, filters) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** #10 (TRI-STOW-0010). **Blocked by:** #8 (register model) and #9 (scanner merges checkouts). Neither is merged as of 2026-10-05, so this plan is written against the data model those issues *describe*. Everything that depends on their exact field names is isolated in one adapter (`locationMeta`, Task 1) and one route (Task 4) — re-check both against the merged #8/#9 before starting.

**Goal:** The projects page shows *virtual projects* (one row per project, its checkouts as expandable sub-rows), optionally grouped by client, with a Client filter, a copy-role filter, an "Unassigned" bucket, a "Multiple copies" quick filter, sorting by client / project / last activity / AI cost, and a Locations section in the details sheet that edits client, role and primary.

**Architecture:** All grouping, aggregation, filtering and ordering logic lives in one pure, client-safe module (`src/lib/virtual-projects.mjs`) tested with `node --test`. A project row is the *primary location's record* spread with aggregates on top, so every existing column renders unchanged on both project rows and location sub-rows. The table keeps its current flat directory mode behind a `Projects | Directories` toggle. Writes go through a thin `PATCH /api/projects/meta` route that validates input and delegates to the register writer from #8.

**Tech Stack:** Next.js 16 App Router (React 19), TanStack React Table v8 (`getExpandedRowModel`, already a dependency), shadcn/ui, Tailwind, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** the *Design* section below (this plan doubles as the spec, since the PR is plan-only until #8/#9 land). Siblings for context: #8 model/register, #9 scanner merge, #11 reorg, #12/#13 sessions, #14 export.

---

## Design

### What the prerequisites give us (assumed contract)

From #8 and #9, as written in the issues:

- **Client → Project → Locations.** A *location* is one checkout directory on disk (= one record in `projects_metadata.jsonl`, as today). A *project* is identified by its normalised remote URL, or — without a remote — by a stable id stored in `<dir>/.stow/project.json` (`id`, `client`, `role`).
- **Copy role** per location: `primary | deploy | experiment | stale`.
- **Client** resolution: manual override > `ai_analysis.client` > GitLab group / GitHub owner > path `_Bizz/<Client>`. The resolved value and where it came from are attached by #8/#9.
- **Disk is never moved** — this is a virtual layer.
- **#9** merges checkouts of one identity into one project, does *not* count sub-directories of one repo as copies (btstack 49×), and follows a moved directory by id.

This plan assumes #9 keeps **one JSONL record per location** and annotates each with:

```js
record.vp = {
  project_id: 'git:gitlab.com/intelimail/blog' /* or 'stow:<uuid>' */,
  client: 'InteliMail' /* or null */,
  client_source: 'manual' | 'ai' | 'remote' | 'path' | null,
  role: 'primary' | 'deploy' | 'experiment' | 'stale' | null,
}
```

`locationMeta(record)` (Task 1) is the **only** place that reads these fields. If #9 ships different names, or a separate register file instead of per-record fields, only `locationMeta` and `page.js` change. A record without `vp` (old ledger, scan not re-run) becomes its own single-location project with no client — the page never breaks.

For writes this plan assumes #8 exports from `src/lib/register.mjs`:

```js
setProjectClient({ projectId, client /* string | null = back to automatic */ }) // → Promise<void>
setLocationRole({ directory, role /* one of ROLES */ })                        // → Promise<void>
```

and that `setLocationRole(..., 'primary')` keeps the *one primary per project* invariant itself (demoting the previous primary). If #8 names them differently, only the route in Task 4 changes.

### UI decisions

1. **Two views, one table.** A `Projects | Directories` segmented toggle in the toolbar, persisted in the existing `stow-dashboard-table-settings` localStorage blob (`view`). *Directories* is today's table, unchanged, plus the new Client/Role filters (each record knows its client and role). *Projects* is the new default.
2. **Project rows.** `buildVirtualProjects(records)` returns one row per `project_id`: `{ ...primaryRecord, vpId, client, clientSource, locations, copyCount, roles, primaryConflict, last_modified: max over locations, usage: summed over locations }`. Existing columns (git, branch, lines, tasks…) therefore show the primary checkout; *Last modified* and *AI $* show the aggregate. Projects with more than one location get a chevron and a `×N` copies badge; expanding shows the locations as TanStack sub-rows (each is a plain record — every column works on it) with a role pill.
3. **Primary choice when the data has none:** the most recently modified location. When the data has two primaries (should not happen), the alphabetically first directory wins and the row gets a warning dot (`primaryConflict`).
4. **Client column** (new, visible by default in Projects view): client name, muted `Unassigned` when null, source as tooltip (`manual`, `AI`, `remote owner`, `path`).
5. **Group by client.** A `Group by client` checkbox in the View menu (persisted, `groupByClient`). When on, client is forced as the primary sort key (A→Z, `Unassigned` last) and the user's chosen sort applies inside each client; a header row (`InteliMail · 7 projects · $123.40`) is rendered whenever the client changes on the current page. Pagination counts projects, not header rows, so page size stays honest. Header totals are computed over the client's **filtered** projects, not just the visible page.
6. **Client filter** — multi-select with counts, built like the Groups filter (counts from search-filtered rows, auto-pruned when a selected client disappears). `Unassigned` is a fixed last entry (sentinel `UNASSIGNED`). OR within the filter, AND with every other filter.
7. **Role filter** — multi-select over the four roles with counts. A project matches when **any** of its locations has a selected role. Expanded sub-rows still show all locations (the filter picks projects, it does not hide checkouts).
8. **Quick filter `Multiple copies`** — 3-state like the others: yes = `copyCount > 1`, no = exactly one.
9. **Existing quick filters in Projects view use any-location semantics** (Running = some checkout runs; Uncommitted = some checkout is dirty; Behind/Ahead likewise). That is what "this project needs attention" means; the Directories view is there for per-checkout precision.
10. **Sorting.** `client` (Unassigned last in both directions), `project_name`, `last_modified` (aggregate), `ai_cost` (aggregate; no usage = −1 as today). All four are column header sorts; `client` is new.
11. **Search** also matches the client name.
12. **Details sheet.** Opening a project row opens the sheet on its primary location (all live panels — git status, processes, scripts — stay per directory, unchanged). A new **Locations** section at the top (only when the sheet was opened from a project row) shows:
    - **Client**: a select of existing clients + "New client…" input + "Automatic" (clears the manual override); the current source is shown as a badge.
    - **Locations list**: relative path, branch + dirty dot, last modified, a role `<select>`, a `Primary` radio, and a "Show" button that switches the sheet's live panels to that location.
    - Saving calls `PATCH /api/projects/meta`, then `router.refresh()` (the page is `force-dynamic`, so the JSONL is re-read). Errors are shown inline next to the control; controls are disabled while a request is in flight.
13. **UI copy is English** like the rest of the projects page (`Unassigned` for *Nezaradené*, `Multiple copies` for *Má viac kópií*).

### Out of scope (other issues)

Identity/merge/`.stow/project.json` reading and writing (#8, #9); reorg report (#11); sessions `project_key` and worktree mapping (#12); sessions client/project filters and MCP `list_clients` (#13); export for agent-office (#14). No MCP changes here.

---

## Global Constraints

- No new dependencies.
- Field names from #8/#9 are read **only** in `locationMeta()`; register writes happen **only** in `src/app/api/projects/meta/route.js`.
- `src/lib/virtual-projects.mjs` is pure and client-safe: no `fs`, no `process.env`, no imports from `state-dir.mjs`.
- Never build `data/` paths by hand; the route resolves nothing itself — the #8 writer owns paths (`.stow/project.json`, register file via `dataFile()`).
- Roles are exactly `['primary', 'deploy', 'experiment', 'stale']`; the unassigned-client sentinel is `'__unassigned__'`.
- Existing localStorage key `stow-dashboard-table-settings` is extended, not renamed; old saved settings must still load.
- Tests are colocated `<module>.test.mjs`; one file: `node --test src/lib/virtual-projects.test.mjs`; all: `npm test`; lint: `npm run lint`.
- UI copy in English.

## Review Focus

1. **Ledger without `vp` fields** (before a #9 rescan, or a partially rescanned ledger): every directory is its own project, client `Unassigned`, no role — no crash, no empty table. Pinned in Task 1.
2. **Unpriced usage in one of several checkouts:** the project's AI $ must keep the unpriced marker, never collapse to a confident `$0`/sum. Pinned in Task 1.
3. **Client name whitespace variants** (`"InteliMail "` vs `"InteliMail"`) must not produce two filter entries / two header groups. Pinned in Task 1 (trim) and Task 2 (stats).
4. **A selected client or role disappears after a rescan / reassignment:** the selection is pruned like Groups so the table never sits empty on a ghost filter. Pinned in Task 2 (`pruneSelection`).
5. **Group by client + descending sort:** `Unassigned` stays last and header rows appear exactly once per client per page, even when a client spans two pages. Pinned in Task 3.

---

## File Structure

- **Create** `src/lib/virtual-projects.mjs` — adapter + grouping/aggregation (`locationMeta`, `buildVirtualProjects`, `sumUsage`, `pickPrimary`), filters/stats (`clientStats`, `roleStats`, `filterVirtual`, `anyLocation`, `pruneSelection`), ordering (`compareClients`, `withClientHeaders`), patch validation (`validateMetaPatch`).
- **Create** `src/lib/virtual-projects.test.mjs`.
- **Create** `src/app/api/projects/meta/route.js` — `PATCH`, validates and delegates to #8's writer; logic in an exported `handleMetaPatch(body, deps)` for testability.
- **Create** `src/app/api/projects/meta/route.test.mjs`.
- **Create** `src/components/CountedMultiSelect.js` — the Groups-style dropdown (checkbox items with counts, clear link), reused for Client and Role.
- **Create** `src/components/ProjectLocations.js` — the Locations section of the details sheet.
- **Modify** `src/app/project-table.js` — view toggle, project rows + sub-rows, Client column, filters, quick filter, group headers, settings persistence, search.
- **Modify** `src/components/ProjectDetailsSheet.js` — accept `virtualProject`, render `ProjectLocations`, switch live panels between locations.
- **Modify** `CLAUDE.md` — Important Files + a short "Virtual projects UI" paragraph.

---

### Task 1: Adapter and project aggregation

**Files:**
- Create: `src/lib/virtual-projects.mjs`
- Test: `src/lib/virtual-projects.test.mjs`

**Interfaces:**
- Produces:
  - `ROLES: string[]`, `UNASSIGNED: '__unassigned__'`
  - `locationMeta(record) → { projectId: string, client: string|null, clientSource: string|null, role: string|null }`
  - `pickPrimary(locations) → { primary: record, conflict: boolean }`
  - `sumUsage(usages: (object|undefined)[]) → object|undefined` — same shape as a `usage.json` project entry (`costUsd`, `sessions`, `activeMinutes`, `tokens`, `unpricedModels`)
  - `buildVirtualProjects(records) → VirtualProject[]` where `VirtualProject = { ...primaryRecord, vpId, client, clientSource, locations: record[], copyCount, roles: string[], primaryConflict, last_modified, usage }`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, UNASSIGNED, locationMeta, pickPrimary, sumUsage, buildVirtualProjects } from './virtual-projects.mjs'

const rec = (directory, vp, extra = {}) => ({ directory, project_name: directory.split('/').pop(), ...(vp ? { vp } : {}), ...extra })

test('constants', () => {
  assert.deepEqual(ROLES, ['primary', 'deploy', 'experiment', 'stale'])
  assert.equal(UNASSIGNED, '__unassigned__')
})

test('locationMeta falls back to a per-directory project when vp is missing', () => {
  assert.deepEqual(locationMeta(rec('/p/a')), { projectId: 'dir:/p/a', client: null, clientSource: null, role: null })
})

test('locationMeta trims the client, drops blank clients and unknown roles', () => {
  assert.deepEqual(
    locationMeta(rec('/p/a', { project_id: 'git:x', client: '  InteliMail ', client_source: 'manual', role: 'deploy' })),
    { projectId: 'git:x', client: 'InteliMail', clientSource: 'manual', role: 'deploy' },
  )
  assert.deepEqual(
    locationMeta(rec('/p/a', { project_id: 'git:x', client: '   ', client_source: 'ai', role: 'weird' })),
    { projectId: 'git:x', client: null, clientSource: null, role: null },
  )
})

test('pickPrimary prefers role primary, else the most recently modified location', () => {
  const a = rec('/p/a', { project_id: 'g', role: 'deploy' }, { last_modified: '2026-10-01T00:00:00Z' })
  const b = rec('/p/b', { project_id: 'g', role: 'primary' }, { last_modified: '2026-01-01T00:00:00Z' })
  assert.deepEqual(pickPrimary([a, b]), { primary: b, conflict: false })
  const c = rec('/p/c', { project_id: 'g' }, { last_modified: '2026-10-02T00:00:00Z' })
  assert.deepEqual(pickPrimary([a, c]), { primary: c, conflict: false })
})

test('pickPrimary with two primaries picks the alphabetically first and flags a conflict', () => {
  const z = rec('/p/z', { project_id: 'g', role: 'primary' })
  const m = rec('/p/m', { project_id: 'g', role: 'primary' })
  assert.deepEqual(pickPrimary([z, m]), { primary: m, conflict: true })
})

test('sumUsage adds numbers and tokens, keeps unpriced models, returns undefined when nothing is there', () => {
  assert.equal(sumUsage([undefined, undefined]), undefined)
  const s = sumUsage([
    { costUsd: 1.5, sessions: 2, activeMinutes: 10, tokens: { input: 100, output: 5 }, unpricedModels: [] },
    undefined,
    { costUsd: 0.5, sessions: 1, activeMinutes: 5, tokens: { input: 50, codexInput: 7 }, unpricedModels: ['mystery-1'] },
  ])
  assert.deepEqual(s, {
    costUsd: 2, sessions: 3, activeMinutes: 15,
    tokens: { input: 150, output: 5, codexInput: 7 },
    unpricedModels: ['mystery-1'],
  })
})

test('buildVirtualProjects merges locations by project id and aggregates', () => {
  const rows = buildVirtualProjects([
    rec('/p/blog', { project_id: 'git:blog', client: 'InteliMail', client_source: 'remote', role: 'primary' },
      { last_modified: '2026-09-01T00:00:00Z', usage: { costUsd: 1, sessions: 1, activeMinutes: 1, tokens: {}, unpricedModels: [] } }),
    rec('/p/blog-test', { project_id: 'git:blog', client: 'InteliMail', client_source: 'remote', role: 'experiment' },
      { last_modified: '2026-10-01T00:00:00Z', usage: { costUsd: 2, sessions: 1, activeMinutes: 1, tokens: {}, unpricedModels: [] } }),
    rec('/p/solo'),
  ])
  assert.equal(rows.length, 2)
  const blog = rows.find(r => r.vpId === 'git:blog')
  assert.equal(blog.directory, '/p/blog')          // primary's record fields
  assert.equal(blog.client, 'InteliMail')
  assert.equal(blog.clientSource, 'remote')
  assert.equal(blog.copyCount, 2)
  assert.deepEqual(blog.roles, ['experiment', 'primary'])
  assert.equal(blog.last_modified, '2026-10-01T00:00:00Z') // newest location
  assert.equal(blog.usage.costUsd, 3)
  assert.deepEqual(blog.locations.map(l => l.directory), ['/p/blog', '/p/blog-test']) // primary first, then by path
  const solo = rows.find(r => r.vpId === 'dir:/p/solo')
  assert.equal(solo.client, null)
  assert.equal(solo.copyCount, 1)
  assert.equal(solo.usage, undefined)
})

test('buildVirtualProjects takes the client from the primary when locations disagree', () => {
  const [p] = buildVirtualProjects([
    rec('/p/a', { project_id: 'g', client: 'A', role: 'deploy' }),
    rec('/p/b', { project_id: 'g', client: 'B', role: 'primary' }),
  ])
  assert.equal(p.client, 'B')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: FAIL — `Cannot find module './virtual-projects.mjs'`.

- [ ] **Step 3: Implement**

```js
/**
 * Virtual projects (Client → Project → Locations) for the projects page.
 * Pure and client-safe. `locationMeta` is the only reader of the fields #8/#9
 * attach to a ledger record — change it, not the callers, if they move.
 */

export const ROLES = ['primary', 'deploy', 'experiment', 'stale']
export const UNASSIGNED = '__unassigned__'

export function locationMeta(record) {
  const vp = record?.vp || {}
  const client = typeof vp.client === 'string' && vp.client.trim() ? vp.client.trim() : null
  return {
    projectId: vp.project_id || `dir:${record.directory}`,
    client,
    clientSource: client ? (vp.client_source || null) : null,
    role: ROLES.includes(vp.role) ? vp.role : null,
  }
}

function time(r) {
  const t = Date.parse(r?.last_modified)
  return Number.isNaN(t) ? -Infinity : t
}

const byDir = (a, b) => a.directory.localeCompare(b.directory)

export function pickPrimary(locations) {
  const primaries = locations.filter(l => locationMeta(l).role === 'primary').sort(byDir)
  if (primaries.length) return { primary: primaries[0], conflict: primaries.length > 1 }
  const newest = [...locations].sort((a, b) => time(b) - time(a) || byDir(a, b))[0]
  return { primary: newest, conflict: false }
}

export function sumUsage(usages) {
  const present = usages.filter(Boolean)
  if (!present.length) return undefined
  const out = { costUsd: 0, sessions: 0, activeMinutes: 0, tokens: {}, unpricedModels: [] }
  const unpriced = new Set()
  for (const u of present) {
    out.costUsd += u.costUsd || 0
    out.sessions += u.sessions || 0
    out.activeMinutes += u.activeMinutes || 0
    for (const [k, v] of Object.entries(u.tokens || {})) {
      if (typeof v === 'number') out.tokens[k] = (out.tokens[k] || 0) + v
    }
    for (const m of u.unpricedModels || []) unpriced.add(m)
  }
  out.unpricedModels = [...unpriced]
  return out
}

export function buildVirtualProjects(records) {
  const groups = new Map()
  for (const r of records || []) {
    const id = locationMeta(r).projectId
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(r)
  }
  const out = []
  for (const [vpId, locs] of groups) {
    const { primary, conflict } = pickPrimary(locs)
    const meta = locationMeta(primary)
    const locations = [primary, ...locs.filter(l => l !== primary).sort(byDir)]
    const newest = [...locs].sort((a, b) => time(b) - time(a))[0]
    out.push({
      ...primary,
      vpId,
      client: meta.client,
      clientSource: meta.clientSource,
      locations,
      copyCount: locs.length,
      roles: [...new Set(locs.map(l => locationMeta(l).role).filter(Boolean))].sort(),
      primaryConflict: conflict,
      last_modified: newest?.last_modified ?? primary.last_modified,
      usage: sumUsage(locs.map(l => l.usage)),
    })
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/virtual-projects.mjs src/lib/virtual-projects.test.mjs
git commit -m "feat(projects): virtual-project adapter and aggregation over checkouts"
```

---

### Task 2: Filters and filter stats

**Files:**
- Modify: `src/lib/virtual-projects.mjs`
- Test: `src/lib/virtual-projects.test.mjs`

**Interfaces:**
- Consumes: `locationMeta`, `ROLES`, `UNASSIGNED` (Task 1).
- Produces:
  - `anyLocation(row, pred) → boolean` — `pred` on every location of a project row, or on the row itself when it has no `locations` (directory view).
  - `clientStats(rows) → { value: string, label: string, count: number }[]` — clients A→Z (case-insensitive), `UNASSIGNED` (label `Unassigned`) last, only entries with count > 0.
  - `roleStats(rows) → { value, label, count }[]` — in `ROLES` order, count = rows with any location of that role, entries with count 0 omitted.
  - `filterVirtual(rows, { clients = [], roles = [], multiCopy = null }) → rows`
  - `pruneSelection(selected: string[], stats) → string[]` — keeps only values present in `stats`; returns the **same array** when nothing changed (so a React effect does not loop).

Rows here are either `VirtualProject`s or plain records; both carry what's needed because plain records are read through `locationMeta`.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { anyLocation, clientStats, roleStats, filterVirtual, pruneSelection } from './virtual-projects.mjs'

const P = buildVirtualProjects([
  rec('/p/blog', { project_id: 'g:blog', client: 'InteliMail', role: 'primary' }),
  rec('/p/blog-x', { project_id: 'g:blog', client: 'InteliMail ', role: 'experiment' }),
  rec('/p/shop', { project_id: 'g:shop', client: 'acme', role: 'primary' }),
  rec('/p/loose'),
])
const vids = rows => rows.map(r => r.vpId)

test('anyLocation checks every checkout of a project, or the record itself', () => {
  const blog = P.find(r => r.vpId === 'g:blog')
  assert.equal(anyLocation(blog, l => l.directory === '/p/blog-x'), true)
  assert.equal(anyLocation(rec('/p/z'), l => l.directory === '/p/z'), true)
})

test('clientStats: trimmed names merge, A→Z case-insensitive, Unassigned last', () => {
  assert.deepEqual(clientStats(P), [
    { value: 'acme', label: 'acme', count: 1 },
    { value: 'InteliMail', label: 'InteliMail', count: 1 },
    { value: UNASSIGNED, label: 'Unassigned', count: 1 },
  ])
})

test('clientStats over plain records (directory view) counts records', () => {
  const recs = [rec('/a', { project_id: 'g', client: 'X' }), rec('/b', { project_id: 'g', client: 'X ' })]
  assert.deepEqual(clientStats(recs), [{ value: 'X', label: 'X', count: 2 }])
})

test('roleStats counts projects having at least one checkout in the role', () => {
  assert.deepEqual(roleStats(P), [
    { value: 'primary', label: 'primary', count: 2 },
    { value: 'experiment', label: 'experiment', count: 1 },
  ])
})

test('filterVirtual by client, including Unassigned', () => {
  assert.deepEqual(vids(filterVirtual(P, { clients: ['acme'] })), ['g:shop'])
  assert.deepEqual(vids(filterVirtual(P, { clients: [UNASSIGNED] })), ['dir:/p/loose'])
  assert.deepEqual(vids(filterVirtual(P, { clients: ['acme', UNASSIGNED] })), ['g:shop', 'dir:/p/loose'])
})

test('filterVirtual by role matches when any checkout has it', () => {
  assert.deepEqual(vids(filterVirtual(P, { roles: ['experiment'] })), ['g:blog'])
})

test('filterVirtual multiCopy is 3-state', () => {
  assert.deepEqual(vids(filterVirtual(P, { multiCopy: true })), ['g:blog'])
  assert.deepEqual(vids(filterVirtual(P, { multiCopy: false })), ['g:shop', 'dir:/p/loose'])
  assert.equal(filterVirtual(P, { multiCopy: null }).length, 3)
})

test('pruneSelection drops vanished values and keeps identity when unchanged', () => {
  const stats = clientStats(P)
  const sel = ['acme', 'Gone Ltd']
  assert.deepEqual(pruneSelection(sel, stats), ['acme'])
  const ok = ['acme']
  assert.equal(pruneSelection(ok, stats), ok)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: FAIL — `anyLocation` (etc.) is not exported.

- [ ] **Step 3: Implement** (append to `virtual-projects.mjs`)

```js
export function anyLocation(row, pred) {
  return Array.isArray(row?.locations) ? row.locations.some(pred) : pred(row)
}

const clientOf = row => (row.vpId ? row.client : locationMeta(row).client)
const rolesOf = row => (row.vpId ? row.roles : [locationMeta(row).role].filter(Boolean))
const copiesOf = row => (row.vpId ? row.copyCount : 1)

export function clientStats(rows) {
  const counts = new Map()
  let unassigned = 0
  for (const r of rows) {
    const c = clientOf(r)
    if (c) counts.set(c, (counts.get(c) || 0) + 1)
    else unassigned++
  }
  const out = [...counts]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([value, count]) => ({ value, label: value, count }))
  if (unassigned) out.push({ value: UNASSIGNED, label: 'Unassigned', count: unassigned })
  return out
}

export function roleStats(rows) {
  return ROLES
    .map(role => ({ value: role, label: role, count: rows.filter(r => rolesOf(r).includes(role)).length }))
    .filter(s => s.count > 0)
}

export function filterVirtual(rows, { clients = [], roles = [], multiCopy = null } = {}) {
  return rows.filter(r => {
    if (clients.length && !clients.includes(clientOf(r) ?? UNASSIGNED)) return false
    if (roles.length && !rolesOf(r).some(x => roles.includes(x))) return false
    if (multiCopy !== null && (copiesOf(r) > 1) !== multiCopy) return false
    return true
  })
}

export function pruneSelection(selected, stats) {
  const present = new Set(stats.map(s => s.value))
  const kept = selected.filter(v => present.has(v))
  return kept.length === selected.length ? selected : kept
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/virtual-projects.mjs src/lib/virtual-projects.test.mjs
git commit -m "feat(projects): client/role/multi-copy filters and filter stats"
```

---

### Task 3: Client ordering and group header rows

**Files:**
- Modify: `src/lib/virtual-projects.mjs`
- Test: `src/lib/virtual-projects.test.mjs`

**Interfaces:**
- Consumes: `clientOf` (internal), `UNASSIGNED`.
- Produces:
  - `compareClients(a: string|null, b: string|null, desc = false) → number` — case-insensitive; `null` (Unassigned) sorts **last regardless of `desc`**. Used for plain-array sorts (and as the string comparator of the table's `client` column, where Task 5 keeps Unassigned last via `sortUndefined: 'last'`, because TanStack negates a `sortingFn` for desc).
  - `withClientHeaders(pageRows, allRows) → Array<{ type: 'header', client: string|null, count: number, costUsd: number, unpriced: boolean } | { type: 'row', row }>` — inserts a header before the first row of each client run on the page; `count`/`costUsd` are totals over `allRows` (all filtered rows of that client, not just the page). `pageRows` items are TanStack rows (`row.original` is the data).

- [ ] **Step 1: Write the failing tests** (append)

```js
import { compareClients, withClientHeaders } from './virtual-projects.mjs'

test('compareClients is case-insensitive and keeps Unassigned last in both directions', () => {
  const names = ['beta', null, 'Alpha']
  assert.deepEqual([...names].sort((a, b) => compareClients(a, b)), ['Alpha', 'beta', null])
  assert.deepEqual([...names].sort((a, b) => compareClients(a, b, true)), ['beta', 'Alpha', null])
})

test('withClientHeaders emits one header per client run with totals over all filtered rows', () => {
  const mk = (vpId, client, costUsd, unpriced = []) => ({ vpId, client, usage: costUsd === undefined ? undefined : { costUsd, unpricedModels: unpriced } })
  const all = [mk('a', 'A', 1), mk('b', 'A', 2), mk('c', 'B', undefined), mk('d', null, 4, ['x'])]
  const page = [all[1], all[2], all[3]].map(original => ({ original })) // 'a' sits on the previous page
  const out = withClientHeaders(page, all)
  assert.deepEqual(out.map(x => x.type), ['header', 'row', 'header', 'row', 'header', 'row'])
  assert.deepEqual(out[0], { type: 'header', client: 'A', count: 2, costUsd: 3, unpriced: false })
  assert.deepEqual(out[2], { type: 'header', client: 'B', count: 1, costUsd: 0, unpriced: false })
  assert.deepEqual(out[4], { type: 'header', client: null, count: 1, costUsd: 4, unpriced: true })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: FAIL — `compareClients` is not exported.

- [ ] **Step 3: Implement** (append)

```js
export function compareClients(a, b, desc = false) {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  const c = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return desc ? -c : c
}

export function withClientHeaders(pageRows, allRows) {
  const totals = new Map()
  for (const r of allRows) {
    const k = clientOf(r) ?? UNASSIGNED
    const t = totals.get(k) || { count: 0, costUsd: 0, unpriced: false }
    t.count++
    t.costUsd += r.usage?.costUsd || 0
    if ((r.usage?.unpricedModels || []).length) t.unpriced = true
    totals.set(k, t)
  }
  const out = []
  let prev
  for (const row of pageRows) {
    const client = clientOf(row.original) ?? null
    const key = client ?? UNASSIGNED
    if (key !== prev) {
      out.push({ type: 'header', client, ...totals.get(key) })
      prev = key
    }
    out.push({ type: 'row', row })
  }
  return out
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/lib/virtual-projects.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/virtual-projects.mjs src/lib/virtual-projects.test.mjs
git commit -m "feat(projects): client ordering and group header rows"
```

---

### Task 4: `PATCH /api/projects/meta` (client, role, primary)

**Files:**
- Modify: `src/lib/virtual-projects.mjs` (add `validateMetaPatch`)
- Create: `src/app/api/projects/meta/route.js`
- Test: `src/lib/virtual-projects.test.mjs`, `src/app/api/projects/meta/route.test.mjs`

**Interfaces:**
- Consumes: `ROLES` (Task 1); from #8 `setProjectClient({ projectId, client })`, `setLocationRole({ directory, role })` in `src/lib/register.mjs` (**verify names against merged #8 first**).
- Produces:
  - `validateMetaPatch(body) → { ok: true, op: { kind: 'client', projectId, client } | { kind: 'role', directory, role } } | { ok: false, error: string }`
    Body shapes: `{ projectId, client }` (client: non-empty trimmed string ≤ 80 chars, or `null` = back to automatic) or `{ directory, role }` (absolute path, role in `ROLES`). Exactly one shape.
  - `handleMetaPatch(body, { setProjectClient, setLocationRole }) → Promise<{ status: number, json: object }>`
  - `PATCH(request)` → `Response`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/virtual-projects.test.mjs`:

```js
import { validateMetaPatch } from './virtual-projects.mjs'

test('validateMetaPatch accepts a client change and a reset to automatic', () => {
  assert.deepEqual(validateMetaPatch({ projectId: 'git:x', client: '  Acme ' }),
    { ok: true, op: { kind: 'client', projectId: 'git:x', client: 'Acme' } })
  assert.deepEqual(validateMetaPatch({ projectId: 'git:x', client: null }),
    { ok: true, op: { kind: 'client', projectId: 'git:x', client: null } })
})

test('validateMetaPatch accepts a role change on an absolute directory', () => {
  assert.deepEqual(validateMetaPatch({ directory: '/p/a', role: 'primary' }),
    { ok: true, op: { kind: 'role', directory: '/p/a', role: 'primary' } })
})

test('validateMetaPatch rejects bad input', () => {
  for (const body of [
    null, {}, { projectId: 'x' }, { projectId: 'x', client: '   ' }, { projectId: 'x', client: 'a'.repeat(81) },
    { directory: 'rel/path', role: 'deploy' }, { directory: '/p/a', role: 'boss' },
    { projectId: 'x', client: 'A', directory: '/p/a', role: 'deploy' },
  ]) {
    assert.equal(validateMetaPatch(body).ok, false, JSON.stringify(body))
  }
})
```

Create `src/app/api/projects/meta/route.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMetaPatch } from './route.js'

const spyDeps = () => {
  const calls = []
  return {
    calls,
    setProjectClient: async (a) => { calls.push(['client', a]) },
    setLocationRole: async (a) => { calls.push(['role', a]) },
  }
}

test('client patch calls setProjectClient', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ projectId: 'git:x', client: 'Acme' }, d)
  assert.equal(res.status, 200)
  assert.deepEqual(d.calls, [['client', { projectId: 'git:x', client: 'Acme' }]])
})

test('role patch calls setLocationRole', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ directory: '/p/a', role: 'stale' }, d)
  assert.equal(res.status, 200)
  assert.deepEqual(d.calls, [['role', { directory: '/p/a', role: 'stale' }]])
})

test('invalid body is a 400 and writes nothing', async () => {
  const d = spyDeps()
  const res = await handleMetaPatch({ directory: '/p/a', role: 'boss' }, d)
  assert.equal(res.status, 400)
  assert.equal(d.calls.length, 0)
})

test('writer failure is a 500 with the message', async () => {
  const res = await handleMetaPatch({ projectId: 'x', client: 'A' }, {
    setProjectClient: async () => { throw new Error('read-only volume') },
    setLocationRole: async () => {},
  })
  assert.equal(res.status, 500)
  assert.match(res.json.error, /read-only volume/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/lib/virtual-projects.test.mjs src/app/api/projects/meta/route.test.mjs`
Expected: FAIL — `validateMetaPatch` not exported; `./route.js` not found.

- [ ] **Step 3: Implement**

Append to `src/lib/virtual-projects.mjs`:

```js
const CLIENT_MAX = 80

export function validateMetaPatch(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const isClient = 'projectId' in body || 'client' in body
  const isRole = 'directory' in body || 'role' in body
  if (isClient === isRole) return { ok: false, error: 'send either {projectId, client} or {directory, role}' }
  if (isClient) {
    if (typeof body.projectId !== 'string' || !body.projectId) return { ok: false, error: 'projectId required' }
    if (!('client' in body)) return { ok: false, error: 'client required (null = automatic)' }
    if (body.client === null) return { ok: true, op: { kind: 'client', projectId: body.projectId, client: null } }
    const client = typeof body.client === 'string' ? body.client.trim() : ''
    if (!client || client.length > CLIENT_MAX) return { ok: false, error: `client must be 1–${CLIENT_MAX} characters` }
    return { ok: true, op: { kind: 'client', projectId: body.projectId, client } }
  }
  if (typeof body.directory !== 'string' || !body.directory.startsWith('/')) return { ok: false, error: 'directory must be an absolute path' }
  if (!ROLES.includes(body.role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')}` }
  return { ok: true, op: { kind: 'role', directory: body.directory, role: body.role } }
}
```

Create `src/app/api/projects/meta/route.js`:

```js
import { validateMetaPatch } from '../../../../lib/virtual-projects.mjs'
import { setProjectClient, setLocationRole } from '../../../../lib/register.mjs' // from #8 — verify names

export async function handleMetaPatch(body, deps) {
  const v = validateMetaPatch(body)
  if (!v.ok) return { status: 400, json: { error: v.error } }
  try {
    if (v.op.kind === 'client') await deps.setProjectClient({ projectId: v.op.projectId, client: v.op.client })
    else await deps.setLocationRole({ directory: v.op.directory, role: v.op.role })
    return { status: 200, json: { ok: true } }
  } catch (err) {
    return { status: 500, json: { error: err?.message || String(err) } }
  }
}

export async function PATCH(request) {
  let body
  try { body = await request.json() } catch { body = null }
  const { status, json } = await handleMetaPatch(body, { setProjectClient, setLocationRole })
  return Response.json(json, { status })
}
```

Note: imports in `route.js` are **relative**, not `@/…` — `node --test` does not resolve the alias, and the existing route tests (`src/app/api/sessions/route.test.mjs` imports `./route.js`) rely on the same convention. If #8's `register.mjs` touches `fs` at import time, that is fine for the test (the deps are injected; the module is only imported).

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/lib/virtual-projects.test.mjs src/app/api/projects/meta/route.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/virtual-projects.mjs src/lib/virtual-projects.test.mjs src/app/api/projects/meta
git commit -m "feat(projects): PATCH /api/projects/meta for client, role and primary"
```

---

### Task 5: Projects table — view toggle, project rows, Client column, filters, grouping

**Files:**
- Create: `src/components/CountedMultiSelect.js`
- Modify: `src/app/project-table.js`

**Interfaces:**
- Consumes: everything exported in Tasks 1–3.
- Produces: `CountedMultiSelect({ label, icon, stats, selected, onToggle, onClear, clearLabel })`; the details sheet is opened with `{ open: true, project: row, virtualProject: row.vpId ? row : null }` (Task 6 reads `virtualProject`).

No component test infra exists in the repo; the logic is in the tested module, this task is wiring. Verify in the browser (Step 7).

- [ ] **Step 1: Extract the Groups dropdown into `CountedMultiSelect`**

```jsx
'use client'

import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function CountedMultiSelect({ label, icon: Icon, stats, selected, onToggle, onClear, clearLabel = 'Clear selection' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={selected.length > 0 ? 'border-primary' : ''}>
          {Icon && <Icon className="h-4 w-4 sm:mr-2" />}
          <span className="hidden sm:inline">{label}</span>
          {selected.length > 0 && (
            <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">{selected.length}</span>
          )}
          <ChevronDown className="ml-1 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
        {selected.length > 0 && (
          <div className="px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:text-foreground" onClick={onClear}>
            {clearLabel}
          </div>
        )}
        {stats.map(({ value, label: text, count }) => (
          <DropdownMenuCheckboxItem key={value} checked={selected.includes(value)} onCheckedChange={() => onToggle(value)}>
            <span className="flex-1 truncate">{text}</span>
            <span className="ml-2 text-xs text-muted-foreground tabular-nums">{count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

Replace the inline Groups dropdown (`project-table.js` ~1140–1175) with `<CountedMultiSelect label="Groups" icon={FolderTree} stats={groupStats.map(g => ({ value: g.name, label: g.name, count: g.count }))} selected={selectedGroups} onToggle={toggleGroup} onClear={clearGroups} />`. Check the page looks identical before continuing.

- [ ] **Step 2: State, settings, view toggle**

Add state next to `selectedGroups`:

```js
const [view, setView] = React.useState('projects')            // 'projects' | 'directories'
const [groupByClient, setGroupByClient] = React.useState(true)
const [selectedClients, setSelectedClients] = React.useState([])
const [selectedRoles, setSelectedRoles] = React.useState([])
```

Add `multiCopy: null` to `defaultFilters()`. Restore/save `view`, `groupByClient`, `selectedClients`, `selectedRoles` in the existing load/save effects (old blobs lack the keys → defaults stay). Reset them in the existing "reset all" handler. Toolbar, before the search input:

```jsx
<div className="inline-flex rounded-md border p-0.5">
  {['projects', 'directories'].map(v => (
    <Button key={v} variant={view === v ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2 capitalize"
      onClick={() => { setView(v); setExpanded({}) }}>{v}</Button>
  ))}
</div>
```

- [ ] **Step 3: Rows pipeline**

```js
import { buildVirtualProjects, clientStats, roleStats, filterVirtual, anyLocation, pruneSelection, withClientHeaders, compareClients, UNASSIGNED } from '@/lib/virtual-projects.mjs'

const baseRows = React.useMemo(
  () => (view === 'projects' ? buildVirtualProjects(projects) : projects),
  [view, projects],
)
```

Change `searchFilteredProjects` to start from `baseRows` and to also match `(row.vpId ? row.client : locationMeta(row).client)` against the search string. Compute `clientFilterStats = clientStats(searchFilteredProjects)` and `roleFilterStats = roleStats(searchFilteredProjects)`; prune with an effect mirroring the groups one:

```js
React.useEffect(() => {
  setSelectedClients(prev => pruneSelection(prev, clientFilterStats))
  setSelectedRoles(prev => pruneSelection(prev, roleFilterStats))
}, [clientFilterStats, roleFilterStats])
```

At the start of `filteredProjects`, after the group filter:

```js
result = filterVirtual(result, { clients: selectedClients, roles: selectedRoles, multiCopy: filters.multiCopy })
```

Switch every existing git/process quick filter to any-location semantics by wrapping its predicate, e.g.:

```js
if (filters.running !== null) {
  result = result.filter(project => {
    const isRunning = anyLocation(project, l => isProjectRunning(l.directory))
    return filters.running ? isRunning : !isRunning
  })
}
```

Apply the same `anyLocation(project, l => …)` wrapping to `hasGit`, `hasRemote`, `uncommitted`, `behind`, `ahead`, `hasOwnCommits`, `hasReadme`, `hasTasks`. Leave the AI quick filters (`analyzed`, `misplaced`, `poorDocs`) on the row itself (= primary). Add `selectedClients, selectedRoles` to the memo deps.

Add the `Multiple copies` 3-state chip to the existing quick-filter list, wired to `filters.multiCopy` exactly like the others; only render it when `view === 'projects'`.

Put `<CountedMultiSelect label="Client" … stats={clientFilterStats} …/>` and `<CountedMultiSelect label="Role" … stats={roleFilterStats} …/>` next to Groups. Render selected clients as chips like selected groups (label `Unassigned` for `UNASSIGNED`).

- [ ] **Step 4: Client column, expander, copies badge**

New column, inserted after `project_name`:

```js
{
  id: 'client',
  accessorFn: row => (row.vpId ? row.client : locationMeta(row).client) ?? undefined, // undefined → sortUndefined keeps Unassigned last
  sortingFn: (a, b) => compareClients(a.getValue('client'), b.getValue('client')),
  sortUndefined: 'last',
  header: ({ column }) => (
    <Button variant="ghost" size="sm" className="h-8 px-2 -ml-2"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}>
      Client <ArrowUpDown className="ml-1 h-3 w-3" />
    </Button>
  ),
  cell: ({ row }) => {
    const c = row.getValue('client')
    const src = row.original.vpId ? row.original.clientSource : locationMeta(row.original).clientSource
    return c
      ? <span className="text-sm" title={src ? `client from: ${src}` : undefined}>{c}</span>
      : <span className="text-sm text-muted-foreground">Unassigned</span>
  },
},
```

Unassigned-last in *both* directions: TanStack negates `sortingFn` for desc, which would move `null` first. That is why `accessorFn` maps `null` to `undefined`: `sortUndefined: 'last'` keeps it last regardless of direction, and `compareClients` only ever sees strings. Checked manually in Step 7 (item 5).

In the `project_name` cell, when `row.original.copyCount > 1` render a chevron button (`row.getToggleExpandedHandler()`, rotate when `row.getIsExpanded()`) and a `×{copyCount}` badge; when `row.original.primaryConflict` add an amber dot with title `Two checkouts are marked primary`. For a sub-row (`row.depth > 0`) indent with `pl-6` and show `locationMeta(row.original).role ?? 'no role'` as a small pill instead of the badge.

Table options:

```js
const [expanded, setExpanded] = React.useState({})
// in useReactTable:
getSubRows: row => (view === 'projects' && row.copyCount > 1 ? row.locations : undefined),
getExpandedRowModel: getExpandedRowModel(),
onExpandedChange: setExpanded,
paginateExpandedRows: false,
state: { ..., expanded },
```

Sub-rows are plain records, so `getSubRows` must return `undefined` for them (they have no `copyCount`) — it does.

- [ ] **Step 5: Group-by-client sorting and header rows**

```js
const effectiveSorting = React.useMemo(
  () => (view === 'projects' && groupByClient
    ? [{ id: 'client', desc: false }, ...sorting.filter(s => s.id !== 'client')]
    : sorting),
  [view, groupByClient, sorting],
)
```

Pass `effectiveSorting` as `state.sorting`; keep `onSortingChange: setSorting` but strip the forced `client` entry when grouping is on (`updater` receives the effective array; filter `id === 'client'` out before storing). In the View menu add a `DropdownMenuCheckboxItem` "Group by client" bound to `groupByClient` (Projects view only).

In `TableBody`, when grouping is on, iterate over `withClientHeaders(table.getRowModel().rows.filter(r => r.depth === 0), filteredProjects)`, and for each `{type:'row', row}` render the row followed by its expanded sub-rows (`row.getIsExpanded() && row.subRows`). Header item:

```jsx
<TableRow key={`h:${item.client ?? UNASSIGNED}`} className="bg-muted/40 hover:bg-muted/40">
  <TableCell colSpan={table.getVisibleLeafColumns().length} className="py-1.5 text-xs font-medium">
    {item.client ?? 'Unassigned'}
    <span className="ml-2 text-muted-foreground">
      {item.count} {item.count === 1 ? 'project' : 'projects'} · {formatUsdWithUnpriced(item.costUsd, item.unpriced)}
    </span>
  </TableCell>
</TableRow>
```

Without grouping, render rows exactly as today.

- [ ] **Step 6: Open the sheet with the virtual project**

Where the row's details button sets `setDetailsSheet({ open: true, project })`, use `setDetailsSheet({ open: true, project: row.original, virtualProject: row.original.vpId ? row.original : null })` and pass `virtualProject={detailsSheet.virtualProject}` to `<ProjectDetailsSheet>`. (For a sub-row: `project` = the location, `virtualProject` = `row.getParentRow().original`.)

- [ ] **Step 7: Verify in the browser, lint, commit**

Run: `npm run dev` (port 3089). With a ledger that has `vp` fields (after #9 rescan) check:
1. Projects view: `blog` shows once with `×4`; expanding lists 4 checkouts with role pills; Last modified is the newest checkout's.
2. Client filter counts match the visible rows; selecting `Unassigned` shows only projects without a client.
3. Role `experiment` keeps projects having any experiment checkout.
4. `Multiple copies` yes/no/any cycles.
5. Group by client on: header rows once per client per page, `Unassigned` last; flipping the Last-modified sort reorders inside clients only; Client column sort desc keeps `Unassigned` last.
6. Directories view: identical to today plus the Client column/filters.
7. Reload: view, grouping and filters are restored. Delete the settings key → defaults, no errors.
8. With the **current** ledger (no `vp` fields): Projects view = one row per directory, all `Unassigned`, nothing breaks.

Run: `npm run lint && npm test`
Expected: no lint errors; all tests pass.

```bash
git add src/components/CountedMultiSelect.js src/app/project-table.js
git commit -m "feat(projects): virtual project rows, client grouping, client/role/multi-copy filters"
```

---

### Task 6: Details sheet — Locations section with editing

**Files:**
- Create: `src/components/ProjectLocations.js`
- Modify: `src/components/ProjectDetailsSheet.js`

**Interfaces:**
- Consumes: `virtualProject` prop (Task 5), `locationMeta`, `ROLES` (Task 1), `PATCH /api/projects/meta` (Task 4), `clientStats` for the client list.
- Produces: `ProjectLocations({ virtualProject, clients: string[], activeDirectory, onShowLocation(directory), onSaved() })`.

- [ ] **Step 1: `ProjectLocations` component**

```jsx
'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ROLES, locationMeta } from '@/lib/virtual-projects.mjs'
import { formatTimeAgo, cn } from '@/lib/utils'

async function patchMeta(body) {
  const res = await fetch('/api/projects/meta', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
}

export function ProjectLocations({ virtualProject: vp, clients, activeDirectory, onShowLocation, onSaved }) {
  const [busy, setBusy] = React.useState(null)   // key of the control being saved
  const [error, setError] = React.useState(null) // { key, message }
  const [newClient, setNewClient] = React.useState('')

  const run = async (key, body) => {
    setBusy(key); setError(null)
    try { await patchMeta(body); onSaved() } catch (e) { setError({ key, message: e.message }) } finally { setBusy(null) }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Locations</h3>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Client</span>
        <select
          className="h-8 rounded-md border bg-background px-2"
          disabled={busy === 'client'}
          value={vp.clientSource === 'manual' ? vp.client : ''}
          onChange={e => run('client', { projectId: vp.vpId, client: e.target.value || null })}
        >
          <option value="">Automatic{vp.clientSource !== 'manual' && vp.client ? ` (${vp.client})` : ''}</option>
          {clients.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <Input className="h-8 w-40" placeholder="New client…" value={newClient}
          onChange={e => setNewClient(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newClient.trim()) { run('client', { projectId: vp.vpId, client: newClient }); setNewClient('') } }} />
        {vp.clientSource && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{vp.clientSource}</span>}
        {error?.key === 'client' && <span className="text-xs text-red-600">{error.message}</span>}
      </div>

      <ul className="divide-y rounded-md border">
        {vp.locations.map(loc => {
          const meta = locationMeta(loc)
          const key = `role:${loc.directory}`
          return (
            <li key={loc.directory} className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-sm', loc.directory === activeDirectory && 'bg-muted/40')}>
              <input type="radio" name={`primary-${vp.vpId}`} aria-label="Primary"
                checked={meta.role === 'primary'} disabled={busy !== null}
                onChange={() => run(key, { directory: loc.directory, role: 'primary' })} />
              <span className="flex-1 truncate font-mono text-xs" title={loc.directory}>{loc.groupParts?.concat(loc.projectDir).join('/') || loc.directory}</span>
              {loc.git_info?.current_branch && <span className="text-xs text-muted-foreground">{loc.git_info.current_branch}</span>}
              {loc.git_info?.is_clean === false && <span className="h-2 w-2 rounded-full bg-amber-500" title="Uncommitted changes" />}
              {loc.last_modified && <span className="text-xs text-muted-foreground">{formatTimeAgo(loc.last_modified)}</span>}
              <select className="h-7 rounded-md border bg-background px-1 text-xs" value={meta.role ?? ''} disabled={busy !== null}
                onChange={e => run(key, { directory: loc.directory, role: e.target.value })}>
                {meta.role === null && <option value="">no role</option>}
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onShowLocation(loc.directory)}>Show</Button>
              {error?.key === key && <span className="w-full text-xs text-red-600">{error.message}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
```

`git_info.current_branch` is the scanner's field (`src/scanner/index.mjs`, `'unknown'` when not on a branch). `formatTimeAgo` must render client-only (hydration note in CLAUDE.md) — the sheet is client-only after open, so this is safe; confirm no SSR of the sheet.

- [ ] **Step 2: Wire into `ProjectDetailsSheet`**

Signature becomes `ProjectDetailsSheet({ open, onOpenChange, project, virtualProject = null, clients = [] })`. Add `const [activeDirectory, setActiveDirectory] = React.useState(project?.directory)` reset whenever `project?.directory` changes, and derive `const current = virtualProject?.locations.find(l => l.directory === activeDirectory) ?? project`. Replace `project` with `current` in the three live fetch effects and their dependency arrays (`project-details`, `processes`, `scripts`), so "Show" switches all live panels. Render, right under the `SheetHeader`:

```jsx
{virtualProject && (
  <ProjectLocations
    virtualProject={virtualProject}
    clients={clients}
    activeDirectory={current.directory}
    onShowLocation={setActiveDirectory}
    onSaved={() => router.refresh()}
  />
)}
```

with `const router = useRouter()` from `next/navigation`. In `project-table.js` pass `clients={clientFilterStats.filter(s => s.value !== UNASSIGNED).map(s => s.value)}`.

After `router.refresh()` the table rebuilds rows; keep the sheet showing the same project by re-finding it in the table on refresh: in `project-table.js`, derive the sheet's `virtualProject` from `baseRows.find(r => r.vpId === detailsSheet.virtualProject?.vpId)` instead of the stored object, so edits are reflected immediately.

- [ ] **Step 3: Verify, lint, commit**

With #8's writer in place, in `npm run dev`:
1. Open `blog`: Locations lists 4 checkouts, primary radio on the primary one.
2. "Show" on `blog-test` switches git status / processes / scripts to that directory and highlights the row.
3. Set role `stale` on `blog-volaco` → table re-renders with the new role pill; Role filter counts update.
4. Make `blog-test` primary → previous primary demoted (by #8), project row now shows `blog-test`'s branch.
5. Pick a client from the list; type a new client + Enter; choose `Automatic` → source badge goes back to `remote`/`ai`/`path`.
6. Force an error (e.g. stop #8's writer / read-only state dir): inline red message, controls re-enabled.

Run: `npm run lint && npm test` — Expected: clean.

```bash
git add src/components/ProjectLocations.js src/components/ProjectDetailsSheet.js src/app/project-table.js
git commit -m "feat(projects): Locations section — edit client, role and primary"
```

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Under *Important Files* add `src/lib/virtual-projects.mjs` (virtual-project grouping/filters/ordering; `locationMeta` is the only reader of #8/#9 fields), `src/app/api/projects/meta/route.js` (PATCH client/role/primary), `src/components/ProjectLocations.js`, `src/components/CountedMultiSelect.js`. Under *Quick Filters* add `Multiple copies (Projects view)`. Add a short *Virtual projects UI* paragraph: Projects | Directories toggle, any-location semantics of quick filters in Projects view, Group by client (Unassigned last), Client/Role filters.
- [ ] **Step 2:** `npm test && npm run lint`, then:

```bash
git add CLAUDE.md
git commit -m "docs: virtual projects UI in CLAUDE.md"
```

---

## Self-review notes

- Spec coverage: grouping client → project (Tasks 1, 3, 5), Client filter with counts (2, 5), Role filter (2, 5), Unassigned (2, 3, 5), Multiple copies (2, 5), sort by client / project / last activity / AI cost (1 aggregates, 3, 5), details-panel locations with client/role/primary editing (4, 6).
- Two items are deliberately left as *verify against #8/#9* rather than guessed: the `vp` field names (Task 1, single adapter) and the writer names (Task 4, single route).
