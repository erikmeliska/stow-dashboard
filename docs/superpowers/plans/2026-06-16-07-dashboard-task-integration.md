# Phase 07 — Dashboard Task Integration Plan

> Surface per-project task information in the existing stow web dashboard (the project list
> and the project details sidebar), reusing the Phase-03 task libs and `/api/tasks`.

**Goal:** At a glance from the main dashboard, see how much open work each project has; and when
a project is opened in the details sidebar, see its actual open tasks.

**Depends on:** Phase 03 (`src/lib/tasks.mjs`, `readTasks`, `/api/tasks`).

## Tasks

### Task 1 — Open-task count in the project list
- **Data:** on the dashboard page (`src/app/page.js`), fetch `/api/tasks?status=open` once and
  build a `directory → openCount` map. (No scanner change needed.)
- **UI:** in the project row/table (`src/app/project-table.js`), show a small **task-count badge**
  per project (e.g. a checklist icon + N) when `openCount > 0`. Subtle/hidden when 0. Match the
  existing badge/accessory styling (the dirty/running indicators already there).
- **Sort/filter (optional):** allow sorting by open-task count, or a "has open tasks" filter, if
  it fits the existing controls cleanly — otherwise skip.

### Task 2 — Task details in the project sidebar
- **Data:** extend `src/app/api/project-details/route.js` to also return the project's tasks via
  `readTasks(directory)` from `@/lib/tasks.mjs` (open + done, or just open with a done count).
- **UI:** in `src/components/ProjectDetailsSheet.js`, add a **"Tasks" section** listing each open
  task: priority badge, monospace task id, text, and (if present) source. Show a count and an
  empty state ("No open tasks"). Place it near the existing README/git/process sections, matching
  their card/section styling.
- Link each task's id to its evidence later (Phase 05 `verify_task`) — out of scope here; just
  render the task rows now.

## Verify
- `npm run build` compiles; `npm test` unchanged (34/43 — libs untouched).
- The list shows counts for projects that have a `TASKS.md`; the sidebar lists that project's
  open tasks. Projects without `TASKS.md` show no badge / "No open tasks".

## Notes
- Reuse `/api/tasks` for the list join (already aggregates across projects). Reuse `readTasks`
  for the per-project detail. Do not duplicate parsing logic in the UI.
- Pending related cleanups (separate): exclude the `_Sandbox` group from the tasks board, and
  build the INTAKE→TASKS triage bridge (Raycast `Triage Intake` + `stow task add`).
