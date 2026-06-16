# Stow Command Center — Plan Set Index

> **For agentic workers:** This is an INDEX over a set of independently-executable plans.
> Each sub-plan produces working, testable software on its own. Execute in the dependency
> order below. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> per sub-plan.

**Goal:** Turn the existing `stow-dashboard` into a "Command Center" so the user can close
the browser/terminals, return to an empty desktop, and instantly see what they were doing,
what's next, and resume — across many parallel client projects, without holding state in
their head, 80+ browser tabs, or 20+ running dev servers.

**Architecture:** Repo-as-truth. Per-project markdown files (`STATUS.md`, `TASKS.md`,
`CHANGELOG.md`) are the source of truth for intent, work, and history. `stow` enriches them
with machine-derived state (git, processes, scc) and aggregates across projects. Raycast is
the fast daily surface; the stow web dashboard handles heavy triage; Claude Code hooks push
notifications to the phone. No cloud — everything local.

**Tech Stack:** Node ESM (`.mjs`), `@modelcontextprotocol/sdk`, `simple-git`, Next.js 16
(stow web), `node:test` (new — built-in, zero deps), Raycast extension API (TypeScript),
Claude Code skills (markdown `SKILL.md`), Claude Code hooks (`~/.claude/settings.json`),
`ntfy` (existing `_DevOps/ntfy-scripts`), Obsidian vault (markdown).

---

## Locked design decisions (from grilling session 2026-06-16)

1. **Hybrid capture** — user writes only `NEXT:` (the intent); machine derives all context.
2. **`STATUS.md` in each repo = source of truth.** stow edits it; Obsidian mirrors it to mobile (read-only).
3. **3-tier skills** + per-project `CLAUDE.md` that references them enforces the ritual.
   `status-keeper` + `project-init` live in the global core (`~/.agents/skills` → `~/.claude/skills`).
4. **Skill distribution:** manifest + per-skill symlink (solo repos) / vendored copy (team repos) + `eject` for per-project override. Marketplace is a later upgrade for the Innovis pack.
5. **Project = resume unit.** "Focus" = a filter on `STATUS: active`. No cross-project task entity.
6. **Local orchestrator backbone, no cloud/GitHub.** Mobile steers one long-lived desktop
   "Dispatcher" (Cowork) session, which fans out parallel local `claude` sessions.
7. **Tabs are ephemeral.** Canonical project URLs live in `STATUS.md` `## Links`, opened
   on-demand. One browser profile. Research → Obsidian inbox via web clipper. One-time AI
   triage of the current 80 tabs.
8. **Default = nothing runs.** Dev servers start on-demand (for human review, not for agents)
   and stop on close. **Dispatch surface = Claude Desktop**; cmux demoted to ad-hoc terminal.
   **Handoff = via repo files** (stow writes a brief into the repo; the session reads it).
9. **Meeting pipeline:** Plaud → manual paste → Obsidian `Meetings/` note → `meeting-intake`
   skill extracts action items → routes each to a project of that client → `INTAKE` →
   on confirm, writes into target repos' `TASKS.md`. **No Slack intake**; instead a free-text
   quick-capture command writes to `INTAKE`.
10. **git = history of record.** Stable task IDs travel into commit messages.
    **Evidence-gated "done"** — stow flags any done task with no linked commit. Auto-generated
    `CHANGELOG.md` per repo.
11. **Entrypoint = Raycast** (menu-bar "What was I doing" + commands). stow CLI/web = backend.
    Tauri tray is dropped. Notifications: global `Notification` + `Stop` hooks → `ntfy` → iPhone.

---

## Data model — artifacts and ownership

| Artifact | Location | Role | Written by |
|---|---|---|---|
| `STATUS.md` (`NEXT`, `STATUS`, `UPDATED`, `## Links`) | repo root | current state + one next step + working URLs | user (NEXT) / `status-keeper` |
| `TASKS.md` | repo root | open, prioritized backlog with task IDs | stow / `meeting-intake` |
| `CHANGELOG.md` | repo root | human/client-readable history | auto from done-commits |
| `CLAUDE.md` | repo root | always-on rules + skill references | `project-init` |
| `.claude/skills/` + `skills.manifest.json` | repo | symlink(solo)/vendored(team) shared skills + project-custom skills | `project-init` / `skills sync` |
| `INTAKE.md` | Obsidian vault | central untriaged tasks (cross-project, mobile triage) | quick-capture / `meeting-intake` |
| `Meetings/*.md` | Obsidian vault | Plaud transcripts + frontmatter (`date`, `client`, `attendees`) | user (paste) |
| Command Center note | Obsidian vault | mirror of active `NEXT` lines (mobile read) | sync (stow CLI) |
| `git log` | repo | history of record (task IDs in messages) | dispatch sessions |

### File formats (canonical — referenced by all sub-plans)

`STATUS.md`:
```markdown
---
status: active        # active | paused | blocked | done
updated: 2026-06-16
---

NEXT: <one sentence — the single next action>

## Links
- https://localhost:3000  — dev
- https://gitlab.com/...   — repo
- https://...              — client dashboard

## Notes
(free text, optional)
```

`TASKS.md`:
```markdown
# Tasks

## P1
- [ ] [INV-CLM-0042] Add SSO logout redirect — from Meetings/2026-06-10-innovis.md
## P2
- [ ] [INV-CLM-0043] Validate PQQ upload size
```

**Task ID scheme:** `<CLIENT>-<PROJECT>-<NNNN>` (e.g. `INV-CLM-0042`). Client + project codes
are derived from the stow group path (`_Bizz/Innovis/clm-backend` → `INV` + `CLM`). The
`NNNN` is a zero-padded monotonic counter stored per project in `.stow/seq` (created on first
task). IDs are immutable once assigned.

---

## Sub-plans and dependency order

Execute top to bottom. Each is a separate file in this directory.

### `01-stow-mcp-foundation.md`  ← FULLY DETAILED, START HERE
**Why first:** every other subsystem calls stow's MCP/CLI. This unblocks dispatch, status
read/write, on-demand dev servers, and process accuracy.
**Delivers:** `node:test` harness; `src/lib/scripts.mjs`, `src/lib/status.mjs`,
`src/lib/processes.mjs` (extracted, shared, tested); MCP tools `list_scripts`, `run_script`,
`get_status`, `set_status`; `scc` stats surfaced in `get_project_details`; stale duplicate
`getRunningProcesses()` removed.

### `02-intent-skills.md`
**Depends on:** 01 (`get_status`/`set_status`).
**Delivers:** global skills `status-keeper` (reads/updates `STATUS.md`, the 10-second ritual)
and `project-init` (bootstraps a new/existing project: writes `CLAUDE.md`, `STATUS.md`,
`skills.manifest.json`, symlinks/vendors shared skills, sets the stow group). Plus the
**rollout**: run `project-init` on the active projects that lack `CLAUDE.md` — Innovis
`clm-backend`, `clm-ui`, `pqq-backend`, `pqq-ui` (confirmed missing), Intelimail apps, stow itself.
**Key tasks:**
- Author `~/.agents/skills/status-keeper/SKILL.md` — instructs the agent: on session start read
  `STATUS.md` `NEXT`; on session end rewrite `NEXT` + bump `updated`; never invent a NEXT.
- Author `~/.agents/skills/project-init/SKILL.md` — interview (stack, client, which shared
  skill packs), then generate `CLAUDE.md` (always-on rules + `@status-keeper` reference),
  seed `STATUS.md`, create `skills.manifest.json`, materialize skills (symlink if solo / copy
  if team), and call stow's scanner so the project appears with the right group.
- Define `skills.manifest.json` schema: `{ "mode": "symlink|vendored", "shared": [{ "name": "...", "source": "~/.agents/skills|/abs/client/pack" }], "custom": ["local-skill-dir"] }`.
- Write the `skills sync` + `eject` helper (`scripts/skills.mjs` in stow, exposed as `stow skills sync|eject <name>`): reads manifest, recreates symlinks or refreshes vendored copies, shows a diff; `eject` replaces a symlink with a real copy.
- Rollout task: for each project missing `CLAUDE.md`, run `project-init` in non-interactive
  mode with the Innovis pack at `_Bizz/Innovis/skills/claude-skills-src/.claude/skills`.
**Verification:** `clm-backend/CLAUDE.md` exists and references `status-keeper`; a fresh
`claude` session in that repo reads `NEXT` on start; `stow skills sync` is idempotent.

### `03-tasks-and-meeting-intake.md`
**Depends on:** 01 (status/CLI), 02 (`project-init` so projects have the files).
**Delivers:** `TASKS.md` model + task-ID allocator; stow web "Tasks board" aggregating
`TASKS.md` across projects; `INTAKE.md` in the Obsidian vault; `meeting-intake` skill.
**Key tasks:**
- `src/lib/tasks.mjs` (in stow): parse/serialize `TASKS.md`, `allocateTaskId(projectDir)`
  (reads/increments `.stow/seq`, derives client/project codes from group path), `moveIntakeToTask(...)`. TDD with `node:test`.
- MCP tools `list_tasks` (cross-project, filter by client/priority/status) and `add_task(projectDir, text, priority, sourceRef)`.
- `src/lib/intake.mjs`: read/append/remove items in `INTAKE.md` (path from `OBSIDIAN_VAULT` env). TDD.
- stow web: `/tasks` route + board component (reuse TanStack Table) reading `list_tasks`.
- Author `~/.agents/skills/meeting-intake/SKILL.md`: input = an Obsidian `Meetings/*.md` note;
  uses stow MCP `search_projects {group: <client>}` to get routing candidates; extracts action
  items; for each proposes `{projectDir, priority, brief}`; appends to `INTAKE.md` with a
  backlink to the meeting note; on user confirmation calls `add_task` per item (which allocates
  the ID and writes `TASKS.md`).
- Obsidian `Meetings/` note template (frontmatter `date`, `client`, `attendees`).
**Verification:** pasting a sample transcript note and running `meeting-intake` produces
`INTAKE.md` entries routed to the correct Innovis projects; confirming writes ID'd lines into
the right `TASKS.md`.

### `04-raycast-surface.md`
**Depends on:** 01 (CLI/lib), 03 (tasks/intake) for the task commands; the project/status
commands depend only on 01.
**Delivers:** a Raycast extension (separate TS project, e.g. `_Bizz/TriSoft/stow-raycast` or
inside the repo under `raycast/`) backed by the `stow` CLI + direct file reads/writes.
**Key tasks (one Raycast command each):**
- `Projects` — list (Focus = `status:active` first), search/filter; actions: Open workspace,
  Open in Claude Desktop, Show STATUS, Dispatch.
- `What was I doing` — **menu-bar command**: active projects + their `NEXT`, untriaged count,
  needs-input count. Replaces the dropped Tauri tray.
- `Capture Task` — global-hotkey free-text → append to `INTAKE.md` (+ AI project suggestion).
- `Triage Intake` — list `INTAKE.md` items, assign project + priority inline → `add_task`.
- `Open workspace` action — open Zed (`zed <dir>`) + start dev on-demand (CLI → `run_script`)
  + open `## Links` in the single browser profile.
- `Open Project Links`, `Stop All` (stop every running dev/container), `Kill Port`,
  `Project Switcher`, `New Meeting Note`.
**Verification:** `npm run dev` in the extension; each command runs against real stow data;
menu-bar shows live counts.

### `05-dispatch-verify-notify.md`
**Depends on:** 01, 03, 04.
**Delivers:** dispatch (brief → repo → Claude Desktop), evidence-gated done, auto `CHANGELOG.md`,
meeting-loop closure, and the notification hooks.
**Key tasks:**
- `src/lib/dispatch.mjs`: `writeBrief(projectDir, taskId, text)` → writes `BRIEF.md` (or sets
  `STATUS.md` `NEXT`) and returns the path; `openInClaudeDesktop(projectDir)` (open the repo;
  document the exact mechanism after verifying Claude Desktop's local-open path). TDD the writer.
- `src/lib/history.mjs`: `scanDoneCommits(projectDir)` (git log grepping `[<TASK-ID>]`),
  `verifyTask(projectDir, taskId)` → `{done, commits[], hasEvidence}`; `generateChangelog(projectDir)`. TDD against a temp git repo.
- MCP/CLI: `verify_task`, `completed_tasks` (cross-project). stow web "Completed" view; flag
  any `TASKS.md` item marked done with no matching commit.
- Meeting-loop view: given a `Meetings/*.md`, join its task IDs to git → per-meeting status.
- Hooks: add `Notification` + `Stop` (+ `SubagentStop`) to `~/.claude/settings.json` calling a
  new `~/.agents/bin/stow-notify.sh` that posts to `ntfy` (reuse `_DevOps/ntfy-scripts`).
  Payload includes project + state ("needs input" / "done").
**Verification:** a commit `[INV-CLM-0042]` makes the task show as verified-done; a done task
without a commit shows the red flag; finishing a `claude` run fires an `ntfy` push to the phone.

### `06-rollout-browser-mobile.md`
**Depends on:** 01–05.
**Delivers:** the one-time operational rollout and mobile mirror.
**Key tasks:**
- One-time tab triage: use Chrome MCP (or the existing `grab-chrome-tabs.sh`) to read current
  open tabs, cluster by project, propose `## Links` additions per `STATUS.md`, then close them.
- Obsidian Command Center note generator: `stow mirror` CLI writes active projects' `NEXT`
  lines into the vault note (cron or on `set_status`). Mobile reads it.
- Document the Cowork "Dispatcher" pattern: keep one desktop Cowork session; from the phone,
  message it to triage `INTAKE` and dispatch.
- Drop the Tauri tray: remove `src-tauri` from the default run path / docs (keep web + CLI).
**Verification:** empty desktop → Raycast menu-bar shows NEXTs; phone shows the same via the
Obsidian Command Center note; tab count is ~0 at rest.

---

## Self-review (against the locked design)

- Decisions 1–11 each map to a sub-plan: 1–2,7→`01`/`04`; 3–4→`02`; 5→`02`/`04`; 6→`05`/`06`;
  8→`05`; 9→`03`; 10→`05`; 11→`04`/`05`. No decision is unassigned.
- Quick win: `01` + `02` alone deliver "empty desktop → see `NEXT` per active project," and the
  `02` rollout fixes the missing Innovis `CLAUDE.md` files (a ~30-minute concrete gain).
- Open items deliberately deferred: Plaud auto-export (manual paste accepted), Slack intake
  (dropped), plugin/marketplace (later), exact Claude Desktop local-open mechanism (verify
  during `05`, fall back to "open repo + session reads `BRIEF.md`").
