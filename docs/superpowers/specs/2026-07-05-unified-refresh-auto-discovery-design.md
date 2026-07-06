# Unified 60s Refresh + Project Auto-Discovery — Design

**Date:** 2026-07-05
**Status:** Approved
**Goal:** One opt-in 60s refresh cycle that detects running processes, auto-discovers new projects from their working directories, and refreshes git info for active projects — replacing today's two separate cycles. Full/Force scan buttons move into an overflow menu.

## Context

Today there are two independent client-driven cycles:

- `useProcesses(30000)` polls `GET /api/processes` every 30 s, always, while the
  dashboard is open. Read-only overlay (Running column, ports). Its four
  matching loops (processes, claude sessions, terminals, docker) silently drop
  any cwd that doesn't match a known project (`src/app/api/processes/route.js`).
- Quick refresh (`POST /api/scan/quick`, SSE) runs on click or via a 60 s
  opt-in auto-refresh toggle in `ScanControls`. It re-runs its own lsof/docker
  sweep, then refreshes `git_info` + `last_modified` for projects with a
  running process and writes the JSONL.

Problem being solved: a newly created directory (opened in cmux/Zed/terminal,
or with a script running inside) never appears in the dashboard until a full
scan, even though the process detection already sees its cwd — and drops it.

The detection layer already recognizes cmux and Zed as terminal hosts
(`src/lib/processes.mjs:100-101`), so the common "I opened a new dir" case is
observable today; only the unmatched-cwd handling is missing.

## Decisions (user-confirmed)

1. **Bare directories are NOT added.** A candidate becomes a project only when
   it has a project indicator per existing scanner rules (package.json, .git,
   README.md, …). Candidates are re-checked every cycle, so a dir appears
   within one cycle of `git init`/`npm init`.
2. **Discovery runs inside the unified refresh cycle** (not a separate poll).
3. **One cycle, 60 s, opt-in.** The always-on 30 s process poll goes away.
   The cycle runs only while the existing auto-refresh toggle is ON (same
   semantics as today's quick auto-refresh), plus a manual refresh button that
   triggers the same combined refresh once. The sync-ago/countdown indicator
   stays.
4. **Scan and Force buttons move into a `⋯` overflow dropdown** next to the
   refresh controls. They stay fully functional (SSE progress as today);
   tray "Rescan Projects", MCP and CLI continue to use the same full-scan API
   unchanged. Full scan remains the only path that (a) removes deleted
   projects from the JSONL, (b) finds projects never touched by a process,
   (c) refreshes scc/size/stack metrics.

## Architecture

### Server: one combined SSE endpoint

Extend `POST /api/scan/quick` (name kept; it is "the refresh cycle" now).
One lsof/docker sweep per cycle, reused three ways:

1. **Processes** — collect the same structures `GET /api/processes` builds
   (processes/claude/terminals/docker per project). Included in the final SSE
   event as `processes` so the UI updates the Running column from the same
   sweep. `GET /api/processes` remains for the details sheet
   (`?directory=`) and any external consumers; it is no longer polled.
2. **Discovery (new)** — unmatched cwds go through `discoverProjects`:
   - keep only cwds under a `SCAN_ROOTS` root (and not equal to a root)
   - walk UP from the cwd to the nearest ancestor (still under the root) that
     has a project indicator, using the scanner's existing indicator rules;
     no indicator anywhere → not a candidate this cycle
   - skip excluded paths (same exclusion rules as the scanner: `_Sandbox`,
     `node_modules`, hidden dirs, temp)
   - candidate not in JSONL → targeted scan of just that directory via the
     existing scanner (`processProject`-level API), append to JSONL, emit SSE
     `{type: 'discovered', directory, project_name}`
   - **negative cache** (module-level Map, dir → timestamp, TTL ~5 min) so
     repeatedly-seen non-candidates aren't re-walked every cycle; a
     discovered project's cwd naturally stops being unmatched
3. **Git refresh** — existing quick logic (git_info + last_modified for
   projects with a running process), now including projects discovered in
   step 2. JSONL written once at the end.

### Discovery logic placement

Pure logic (`resolveCandidateRoot(cwd, scanRoots, indicatorCheck)`,
cache handling) lives in a new `src/lib/discovery.mjs` with unit tests
(`node --test`, following the repo's existing test conventions). The route
only orchestrates.

### Client: ScanControls + shared processes state

- `ScanControls` toolbar becomes:
  `[Autorefresh toggle (60s) + countdown/sync-ago] [Manual refresh] [⋯ menu: Full scan, Force rescan]`
  - autorefresh toggle keeps today's localStorage persistence and
    run-immediately-on-enable behavior
  - manual refresh triggers one combined cycle (disabled while running)
- Processes state moves from `useProcesses`'s own polling to data delivered
  by the refresh cycle: the final SSE event's `processes` map is pushed into
  shared state (ProjectContext), which `useProcesses` consumers read.
  `useProcesses` keeps its helper API (`getRunningInfo`, …) but no longer
  self-polls (interval 0); it exposes `refresh()` that hits
  `GET /api/processes` once for on-demand cases (details sheet open).
- After a cycle that discovered or updated projects, the table data is
  refreshed (`router.refresh()` — same mechanism the current quick scan uses
  on completion).
- SSE progress shows discovery: "Discovered: <name>".

### Behavior changes (intentional)

- With autorefresh OFF, the Running column does not update by itself —
  manual refresh or toggle-on updates it. (User-requested.)
- System load drops: one lsof sweep per 60 s (opt-in) instead of 2/min
  always + 1/min opt-in.

## Error handling

- Discovery failures (scan of one candidate throws) are per-candidate: log,
  emit SSE `{type:'discover_error', directory, message}`, continue the cycle.
- The cycle never leaves the JSONL half-written: same single-write-at-end
  pattern as current quick.
- lsof/docker absence: same silent-degrade behavior as today.

## Testing

- Unit (node --test): `resolveCandidateRoot` (nested cwd → project root;
  bare dir → null; excluded paths → null; cwd == scan root → null;
  indicator at multiple levels → nearest), negative-cache TTL behavior.
- Manual (recorded in the plan's verification steps): create dir under a
  scan root → open terminal in it → refresh → not added (bare); `git init` →
  refresh → appears; delete dir → stays until Full scan removes it; Running
  column updates only via refresh; ⋯ menu Full/Force work with progress.

## Out of scope (YAGNI)

- Scheduled/automatic full scan (daily or on app start) — noted as a possible
  future improvement for dead-project cleanup.
- Toast notifications for discovered projects (SSE progress + table refresh
  is enough).
- Changes to tray/MCP/CLI scan entry points.
