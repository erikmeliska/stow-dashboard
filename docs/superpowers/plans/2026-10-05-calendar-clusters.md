# Calendar: merge concurrent sessions into clusters + column cap (#30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** #30. **Builds on:** #12 (`project_key`, `workspace`) and #13 (client join, Client/Project/Workspace filters), both merged. **Sibling in flight:** #32 (zero-length sessions as dots in `calendarSlot`/`daySegment`, default Color by project) touches the same files — this plan does **not** touch `calendarSlot`, `daySegment` or the `colorBy` default, so the rebase stays small.

**Goal:** The week view stays readable and clickable on a day with 50+ overlapping sessions (2026-10-05: 176 sessions): overlapping sessions of one project (or client) collapse into one cluster block, and no overlap group ever gets more than 4 columns.

**Architecture:** Two new pure steps in `src/lib/cc/session-calendar.mjs`, run per day after `daySegment`: `clusterDay(segs, mergeBy)` merges transitively overlapping segments with the same merge key into one item, then `layoutDay(items, { maxCols })` lays the items out in at most `maxCols` columns and folds the rest into "+N" overflow chips in the last column. Small pure helpers produce what a cluster block draws (`clusterColor`, `workspaceLanes`). `calendar-view.js` renders cluster blocks, overflow chips and one shared popover listing the sessions behind a cluster or chip; the header gets a `Merge: Project | Client | None` toggle.

**Tech Stack:** Next.js 16 / React 19 client component, Tailwind, date-fns, `node:test`. No new dependencies.

**Spec:** this plan (design below) + issue #30.

## Design

- **Merge key** (`mergeKey(e, mergeBy)`): `project` → `sessionProjectKey(e)` (`project_key || base_dir || project_dir`); `client` → `client_id || UNASSIGNED`; `none` → the session id (nothing merges). Muted (non-work) sessions get a `muted:` prefix so they never merge with work ones.
- **Cluster** = a maximal chain of same-key segments where each starts before the running end of the chain (`start < end`, touching blocks don't merge — same rule as `layoutDay`). A chain of one stays a plain session. Cluster item: `{ id: 'c:<key>:<first id>', start, end, members: [seg…], key }` sorted by start.
- **Column cap** (`MAX_COLS = 4`): greedy columns as today. An overlap group needing ≤ 4 columns renders as before. One needing more shows columns 0..2 and reserves column 3 for overflow: every item that landed in column ≥ 3 is hidden, and the hidden items are merged (transitively overlapping) into overflow chips `{ id: '+<n>', col: 3, cols: 4, start, end, ids }`. Blocks are therefore never narrower than ¼ of the day column.
  - `layoutDay(items, { maxCols = Infinity } = {})` returns `{ placed: Map<id, {col, cols}>, overflow: [...] }`; an item missing from `placed` is hidden in a chip. Default (`Infinity`) keeps today's behaviour.
- **Cluster block**: "`<project label>` · N sessions · $X" (+ client label when merging by client), coloured by `clusterColor(members, colorMode)`: the majority bucket when it covers ≥ 50 % of members, else a striped mix of the top ≤ 3 bucket colours. Inside, `workspaceLanes(members, start, end)` gives one thin vertical lane per workspace (main checkout first, then worktrees by name) with each member's span as a fraction of the cluster — the parallelism stays visible.
- **Expand**: clicking a cluster or an overflow chip opens one popover (absolutely positioned in the week grid, closes on Escape / outside click / opening a session) listing the member sessions as compact `EventBlock`s; picking one opens the detail panel. A selected session inside a cluster rings the cluster.
- **Toggle**: `Merge` segmented control in the calendar header, values `project` (default) / `client` / `none`, per viewer in localStorage `stow.calendar.mergeBy` (the issue says `stow.calendar.colorBy`, but that key already holds Color by; reusing it would make the two choices overwrite each other). With `none`, only the column cap applies.
- **Legend / stats** keep counting sessions (they read `events`, not clusters) — unchanged.
- Month view unchanged (it already caps chips per day with "+N more").

## Global Constraints

- Logic pure and client-safe in `src/lib/cc/session-calendar.mjs`; tests in `session-calendar.test.mjs` (`node --test`, `node:assert/strict`).
- Don't change `calendarSlot`, `daySegment`, `DEFAULT_COLOR_MODE` (#32 owns them).
- `npm test` and `npm run lint` pass; CLAUDE.md "Session calendar" section updated.

## Review Focus

- A day where one project runs all day with short overlapping sessions: the chain must merge into one cluster spanning the whole range, not split per pair → test in Task 1.
- Sessions of two projects overlapping each other: two clusters side by side, not merged → Task 1.
- `mergeBy = 'none'` with 10 overlapping sessions: 3 visible columns + one "+7" chip → Task 2.
- Hidden items in two separate time ranges of one overlap group: two chips, not one spanning the gap → Task 2.
- Muted and work sessions of the same project never share a cluster → Task 1.

---

### Task 1: `mergeKey` + `clusterDay`

**Files:** Modify `src/lib/cc/session-calendar.mjs`; Test `src/lib/cc/session-calendar.test.mjs`

**Produces:** `MERGE_MODES = ['project', 'client', 'none']`, `DEFAULT_MERGE = 'project'`, `mergeKey(e, mergeBy) → string`, `clusterDay(segs, mergeBy) → item[]` where `segs` are `{ top, height, e, … }` and each item is `{ id, start, end, segs }` (`segs.length === 1` = plain session; `id` = session id for those).

- [ ] Test: chain a(60–120) b(100–200) c(190–250) same project → one cluster 60–250 with 3 segs; d(300–330) same project → own item; another project overlapping a → separate item; `none` → 4 items; muted twin never merges; client mode merges two projects of one client and keeps Unassigned together.
- [ ] Run `node --test src/lib/cc/session-calendar.test.mjs` → FAIL (not exported).
- [ ] Implement: group by key, sort by top, merge while `top < runEnd`.
- [ ] Run → PASS. Commit.

### Task 2: column cap in `layoutDay`

**Files:** same.

**Produces:** `MAX_COLS = 4`; `layoutDay(items, { maxCols = Infinity } = {}) → { placed: Map<id,{col,cols}>, overflow: [{ id, col, cols, start, end, ids }] }`.

- [ ] Update the existing layoutDay test to the new return shape; add: 10 overlapping items with `maxCols: 4` → 3 placed with `cols: 4`, one chip `{col: 3, ids: 7}`; ≤ 4 columns → no chip and `cols` as before; hidden items in two disjoint ranges → two chips; a separate later group full width.
- [ ] Run → FAIL. Implement: per overlap group, if `colsEnd.length > maxCols` hide items with `col >= maxCols - 1` and merge them into chips; `cols = min(n, maxCols)`.
- [ ] Run → PASS. Commit.

### Task 3: cluster appearance helpers

**Produces:** `clusterColor(events, mode) → { color, colors, label, mixed }`, `workspaceLanes(segs, start, end) → [{ workspace, label, spans: [{ top, height }] }]` (fractions 0..1), `clusterStats(events) → { sessions, cost_usd, active_s }`.

- [ ] Tests: 3 of 4 done → majority colour, `mixed: false`; 2/2 split → `mixed: true`, two colours; lanes: main checkout first then worktrees sorted, spans as fractions; stats sum rollups.
- [ ] Implement over existing `colorBy`; `formatWorkspace` labels lanes. Run → PASS. Commit.

### Task 4: UI — Merge toggle, cluster block, overflow chip, popover

**Files:** Modify `src/app/sessions/calendar-view.js`.

- [ ] `useMergeMode()` hook (localStorage `stow.calendar.mergeBy`, read after mount, try/catch like `useColorMode`).
- [ ] `WeekGrid`: per day `segs → clusterDay → layoutDay(…, { maxCols: MAX_COLS })`; render plain items as `EventBlock`, clusters as `ClusterBlock`, overflow as `OverflowChip`; one `ClusterPopover` state `{ dayIndex, top, col, cols, events, title }`.
- [ ] Header: `Merge` segmented control next to Color by.
- [ ] `npm run lint`, then check `/sessions?view=calendar&date=2026-10-05` in the running app (merge project/client/none, popover, selection ring). Commit.

### Task 5: docs + rebase + PR

- [ ] CLAUDE.md "Session calendar" section: clustering, cap, toggle, localStorage key.
- [ ] `npm test`, `npm run lint`; `git rebase origin/main`; push; `gh pr create` with "Closes #30".
