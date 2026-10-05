# Sessions day timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A day view of `/sessions` (`?view=calendar&span=day&date=YYYY-MM-DD`, issue #31): time runs horizontally, one swimlane per workspace, grouped client → project → workspace, so a day with 50+ concurrent agents stays readable and shows how many ran at once on which project.

**Architecture:** Pure logic in a new `src/lib/cc/session-timeline.mjs` (bars, track packing, concurrency profile, the client → project → workspace tree, the visible time window), built on `session-calendar.mjs`'s placement (`calendarSlot`, `daySegment`) and `colorBy`. `session-calendar.mjs` learns a `day` span (`periodRange` / `shiftPeriod` / `periodLabel`). UI in a new `src/app/sessions/timeline-view.js` rendered by `CalendarView` when `range.span === 'day'`, reusing `EventDot`, `HarnessBadge`, `OutcomeMark`, `eventTip`, `ColorLegend`/`ColorSelect` and the existing detail panel (via `onOpen`).

**Tech Stack:** Next.js 16 / React 19 client components, date-fns, Tailwind; `node --test`.

**Spec:** GitHub issue #31 (Návrh + Akceptácia). Design decisions from the brainstorm are recorded below under "Design".

## Design

- **Route:** `span=day` on the existing calendar view (no new `view=timeline`). `periodRange(date, 'day')` → `{span:'day', since: startOfDay, until: +1 day, days:[since], loadSince: since − 1 day}`. The page loads from `loadSince` so a session started late the previous day that runs into this one is present; the timeline then keeps only events with a segment on the day (stats and the summary banner count those).
- **Rows:** client (cost desc, Unassigned last — same rule as `GROUP_BY.client`) → project (`sessionProjectKey`, cost desc) → workspace lane (main checkout first, then worktrees by name — same order as `workspaceLanes`). A lane whose sessions overlap (two sessions in the same checkout) packs them into stacked *tracks* (greedy interval packing), so nothing ever draws over anything else.
- **Bars:** session = horizontal bar from `daySegment(calendarSlot(e), day)` (same placement as week view, incl. 15-min minimum and the >5 h rule); a point session (#32) is a dot. Colour = shared Color by (`colorBy`). Click → `onOpen(session_id)` → existing detail panel.
- **Children:** linked children (security reviews) and nested subagents are thin strips under the parent bar, at their own times (`subs`). Track packing uses the bar's extent incl. subs. Concurrency counts families only.
- **Concurrency:** every client and project header carries `peak` (max sessions running at once) and a step `profile` drawn as a heat strip on the header row, so a collapsed group still shows its parallelism. Points (no duration) are excluded.
- **Collapse:** per client and per project, click the header; Collapse all / Expand all button. UI state only.
- **Time axis:** whole hours from the earliest bar start to the latest end of the day (min 4 h span; empty day → 8:00–18:00), percentage positions in a container with `min-width = hours × 72px` (scrolls sideways in a narrow window); sticky label column; a now-line when the day is today.
- **Navigation:** span toggle Day · Week · Month; ← → shift one day; Today. Week view day headers and month view day numbers / "+N more" open the day. Merge toggle is week-only (lanes already separate concurrency).
- **Filters/chips:** the page passes the already filtered families; the `+ agent/scheduled` chip still applies (muted bars).

## Global Constraints

- Pure modules client-safe (no fs), colocated `*.test.mjs` with `node:test` + `node:assert/strict`.
- Local time, Monday-first weeks (existing helpers).
- No new dependencies. `npm test` and `npm run lint` (0 errors) pass.

## Review Focus

1. A session starting the previous evening and running into the day → appears clipped at 0:00 (`continued`). Test in Task 2 (`timelineBars` clips; event from previous day kept).
2. A lane where two sessions of the same workspace overlap → stacked tracks, not drawn on top. Test in Task 2 (`packTracks`).
3. A day with no sessions → empty state and a sane default window, no crash. Test in Task 2 (`timeWindow([])`).
4. Unassigned client and sessions without `project_key` → listed (last), never dropped. Test in Task 2 (`buildTimeline`).
5. Child sessions outside the parent's own span → still drawn and still reserve their track space. Test in Task 2 (extent includes subs).

---

### Task 1: `day` span in session-calendar.mjs

**Files:** Modify `src/lib/cc/session-calendar.mjs`; Test `src/lib/cc/session-calendar.test.mjs`

**Produces:** `periodRange(date,'day')` → `{span:'day', since, until, days:[since], loadSince}`; `shiftPeriod(date,'day',±1)` → ±1 day; `periodLabel({span:'day'})` → `'EEE d MMM yyyy'`. `loadKey` unchanged (uses `since`/`until`).

- [x] Test: `periodRange(L(9,15),'day')` → since `L(9)`, until `L(10)`, `days.length===1`, `loadSince === L(8)`; `shiftPeriod(L(9),'day',-1)` → `L(8)`; `periodLabel` → `'Wed 9 Sep 2026'`.
- [x] Implement, run `node --test src/lib/cc/session-calendar.test.mjs`, commit.

### Task 2: `session-timeline.mjs` (pure)

**Files:** Create `src/lib/cc/session-timeline.mjs`, `src/lib/cc/session-timeline.test.mjs`

**Interfaces (produced):**
- `timelineBars(events, day)` → `Bar[]`, `Bar = {id, e, start, end, point, continued, continues, subs: [{id, kind:'agent'|'child', start, end, point, row}], extentStart, extentEnd}` (minutes from local midnight); events without a segment on `day` are dropped.
- `packTracks(bars)` → `Bar[][]` greedy by `extentStart`, a bar goes to the first track whose last `extentEnd <= extentStart` (points use `start..start+POINT_MIN` as extent).
- `concurrencyProfile(bars)` → `{steps: [{start, end, count}], peak}` over non-point bars.
- `buildTimeline(events, day)` → `Client[]`; `Client = {id, name, unassigned, stats, peak, profile, projects: Project[]}`, `Project = {key, name, stats, peak, profile, lanes: Lane[]}`, `Lane = {workspace, label, tracks: Bar[][]}`; `stats = clusterStats(events)`.
- `timeWindow(bars, {minHours=4})` → `{startHour, endHour}`.

- [x] Tests (each Review Focus item plus): ordering of clients/projects/lanes; peak = 3 for three overlapping sessions in different worktrees; touching sessions don't overlap (peak 1, same track).
- [x] Implement, run, commit.

### Task 3: Timeline UI + navigation

**Files:** Create `src/app/sessions/timeline-view.js`; Modify `src/app/sessions/calendar-view.js` (export `EventDot`, `OutcomeMark`, `eventTip`; Day in the span toggle; Merge only for week; week headers + month day number/“+N more” open the day; render `DayTimeline` for `span==='day'`; day-filtered events for stats/banner/legend), `src/app/sessions/page.js` (`span` accepts `day`; load from `range.loadSince ?? range.since`).

- [x] Implement; `npm run lint`; check in the running app on 2026-10-05 (collapse, colours, click → detail, ← → / Today, back to week, dark mode); commit.

### Task 4: Docs + PR

- [x] CLAUDE.md "Session calendar" section: day view paragraph, `session-timeline.mjs` + `timeline-view.js` in Important Files.
- [x] `npm test`, `npm run lint`, rebase on `origin/main`, push, PR with "Closes #31".
