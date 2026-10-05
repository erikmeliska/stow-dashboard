# Virtuálne projekty 4/6: upratovanie, Reorg report nad registrom (design)

Issue: #11 (TRI-STOW-0011). Series: #8–#14, label `virtual-projects`.
Depends on:
- **#8**: register model (Client → Project → Locations, roles `primary/deploy/experiment/stale`, client resolution, register writer)
- **#9**: the scanner merges checkouts by identity, `checkout`/`identity`/`project_id` on ledger rows, `locations: []` orphans

**Neither is merged yet.** This design is written against the model those issues describe, and against the concrete contract in the #9 draft plan (PR #16, `docs/superpowers/specs/2026-10-05-virtual-projects-checkout-merge-design.md`). Every assumed name is listed in "Contract assumed from #8/#9". Plan Task 0 maps those names to what actually lands before any code is written.

## Goal

The Reorg report today (`src/components/ReorgReportDialog.js`) is a read-only list built from per-directory AI output (`ai_derived.placement_ok`, `suggested_path`, `status === 'archive-candidate'`). Its only action is "Copy `mv` command". Running that command silently breaks every link the dashboard keeps to the old path.

After this issue:

1. The report is built **from the register** (projects and their locations), not from loose directories. It answers four questions:
   - **Client project outside `_Bizz/<Client>`**: the project has a resolved client, but its primary location lives somewhere else.
   - **Stale copies**: a project has several locations, and a non-primary one is old, clean and adds nothing over the primary.
   - **Abandoned experiments**: an experiment (by role or by AI facets) that has had no code activity for a long time.
   - **Orphans**: register projects with `locations: []`, left behind by #9 when every checkout disappeared from disk.
2. **The default action only changes the virtual layer**: confirm the client, set a role, archive the project, or remove the orphan. All of it goes through #8's register writer. Nothing on disk moves.
3. **A physical move exists, but only as the exception.** It always shows a dry-run first, and it migrates every link the dashboard and the CLIs keep to the old path:
   - `cc-sessions.db`: `project_dir`, `cwd`, `raw_ref`, `ingest_state.path`, `subagents.raw_ref`
   - the Claude Code project folder `~/.claude/projects/<slug>`, **including `memory/`**
   - Codex sessions whose `cwd` was the old path
   - the usage cache, the ledger row, and the register location

   As the issue asks, it is verified on **one project first** (a CLI that does dry-run by default and needs `--apply` to act).

Out of scope: the register model and client derivation (#8), merging checkouts in the scanner (#9), projects UI and location editing (#10), `project_key` and worktree mapping (#12/#13), and the agent-office export (#14).

## Why physical moves need more than `mv` (verified in this repo)

| Link | Keyed by | What breaks after a bare `mv` |
|---|---|---|
| `cc-sessions.db` `sessions.project_dir` / `cwd` | absolute path from the transcript (`ingest.mjs:123`) | the sessions page shows the old path; the per-project filter loses history |
| `sessions.raw_ref`, `ingest_state.path`, `subagents.raw_ref` | transcript file path under `~/.claude/projects/<slug>/` | once the slug folder is renamed, batch summaries skip these sessions as "transcript gone" (`summary-batch` raw_ref check) |
| `~/.claude/projects/<slug>/` (+ `memory/`) | slug = cwd with `/`, `_`, `.` turned into `-` (lossy, so it can't be inverted) | Claude Code opens an **empty** project in the new folder: no memory, no `--resume` history |
| `data/usage-cache.json` | transcript **file path** → `{state.cwd, …}` | renaming the slug folder turns the old files into `missing` ghosts **and** re-parses them as new files, so **AI cost is counted twice**. Without the rename, cost stays attached to the old cwd, which no longer matches any project. |
| Codex rollouts `~/.codex/sessions/**` | `session_meta.cwd` inside the file | `project_dir` stays the old path on every re-ingest |
| Transcripts' own `cwd` lines | inside append-only Claude files | a `cc:ingest --full` re-derives `project_dir` from the transcript, which **undoes** a DB-only rewrite |

The last two rows decide the design. Rewriting derived data alone isn't durable, because the next full re-ingest or `npm run usage -- --rebuild` restores the old path. So moves are recorded in a **durable path-alias table**, and every place that maps a cwd to a project applies it. We **don't** rewrite third-party history files (Claude transcripts, Codex rollouts).

## Concepts

- **Suggestion**: `{ id, kind, projectId, location?, reason, evidence, action, move? }`
  - `kind` ∈ `client-placement | stale-copy | abandoned | orphan`
  - `id` is stable: `${kind}:${projectId}:${location ?? ''}`
  - `action` is the virtual default (below). `move` is the optional physical alternative `{ from, to }`, offered only for `client-placement` and `abandoned`.
- **Virtual action** (one per kind):
  - `client-placement` → `{ type: 'confirm-client', client }`. Pins the resolved client as a manual override, so the project shows under the client whatever its disk path is. The project is then "placed": the report stops suggesting it.
  - `stale-copy` → `{ type: 'set-role', directory, role: 'stale' }`
  - `abandoned` → `{ type: 'archive-project' }`. This needs a project-level `archived` flag from #8 (open question Q2).
  - `orphan` → `{ type: 'remove-project' }`
- **Dismissal**: "not a problem, stop suggesting it". Stored per suggestion id in `dataFile('reorg-dismissed.json')` (`{ [id]: { at, fingerprint } }`). The fingerprint holds the evidence values, so a dismissal comes back when the evidence changes (for example, a dismissed stale copy gets new commits and then goes stale again). Dismissals live outside the register on purpose: they are UI state, not facts about the project.
- **Path move**: `{ from, to, at, id }`. Kept in `dataFile('path-moves.json')`, append-only. `resolveMovedPath(p, moves)` rewrites `p` if it is `from` or lies under `from/`, applying moves in order, so chains `a → b → c` resolve.

## Detection rules (pure, `src/lib/reorg.mjs`)

Inputs: `register`, ledger `rows` (each with `project_id`, `checkout`, `git_info`, `ai_analysis`, `ai_derived`, `last_modified`), `baseDir`, `now`, `dismissed`. **No new git or fs calls.** Everything comes from data the scanner and the refresh cycle already maintain, so the report stays cheap.

### client-placement
- The project has a resolved client (#8: `project.client`, with `client_source`).
- Its primary location's checkout root is **not** under `<baseDir>/_Bizz/<client>/` (compared case-insensitively, since folder names and client names differ in case).
- Skipped when `client_source === 'manual'`: the user has already decided, so the disk path is irrelevant.
- Skipped when the AI client is low confidence and there is no stronger source.
- `move.to = <baseDir>/_Bizz/<client>/<basename(primary root)>`. If that path already exists, no `move` is offered.

This replaces today's "Moves" section. The old section used `ai_derived.suggested_path` for every category (`_AI`, `_Testing`, …). In the virtual model only the client folder matters, because category is a facet and not a place. The non-`_Bizz` category moves are dropped (Q4).

### stale-copy
For a project with ≥ 2 locations, a **non-primary** location qualifies when **all** of these hold:
- the checkout root row has `git_info.uncommitted_changes === 0` and `ahead === 0` (no local work would be lost), and git exists. Non-git copies only qualify when their `content_size_bytes` and file-type mix equal the primary's (a cheap proxy for a byte copy).
- its last activity (`max(last_total_commit_date, last_modified)`) is ≥ `STALE_COPY_MONTHS` (default 6) months older than the primary's
- its role isn't already `stale`, `deploy` or `experiment`. A deploy checkout looks stale by design.

`evidence = { behind, ahead, uncommitted, lastActivity, primaryLastActivity }`. A physical move is never offered: deleting a copy is the user's call, done outside the dashboard.

### abandoned
- The project's primary location has role `experiment`, **or** `ai_analysis.maturity` ∈ `{idea, prototype, abandoned-wip}`, **or** `ai_analysis.project_type === 'prototype-poc'` (values from `FACETS` in `src/lib/analyzer.mjs`).
- `ai_derived.status` ∈ `{dead, archive-candidate}`: ≥ 18 months without code activity, per the existing `deriveStatus`.
- No running process and no container. The report receives `runningDirs` from the client, which already has them from the refresh cycle.
- `move.to = <baseDir>/_Archive/<basename>` (folder name is Q5).

This absorbs today's "Archive candidates" section.

### orphan
- `project.locations.length === 0`.
- `evidence` lists the last known directories, if #8/#9 keep them, plus whether the project has a manual client, a role override or sessions (`project_key`, once #12 lands). That warns the user before they drop curated data.

Output ordering: each kind sorted by a severity heuristic (client-placement by code size, stale by age gap, abandoned by size ascending, the same as today), plus `summary` counts per kind and `unassigned` (projects with no client, as a hint for #10).

## Physical move (`src/lib/relocate.mjs`)

Two functions. All side effects go through an injected `deps` (`fs`, `exec`, `openStore`, `homedir`, `now`), per the repo's injectable-exec convention.

### `planRelocation({ from, to }, deps)` → `{ ok, blockers[], warnings[], steps[], planHash }`

Read-only. **Blockers** (any one refuses the move):
- `from` is not a register location, or `to` already exists
- `from` and `to` are on different devices. `fs.rename` would fail, and copy+delete is too risky to do silently.
- a running process or container has its cwd under `from` (reuses `src/lib/discovery.mjs` / the processes detection via `deps.exec`)
- `from` has **linked git worktrees** (`git worktree list --porcelain` shows more than one entry), e.g. `.agent-office/worktrees/*` or `.claude/worktrees/*`. Moving the main checkout breaks their `gitdir` links (Q6: refuse, or run `git worktree repair` afterwards).
- `from` is itself a linked worktree. Moving it would break its main repo's admin entry.
- uncommitted changes. This is a warning only, overridable with `force: true`: a move doesn't lose them, but a dirty tree usually means work in progress.

**Steps** (each is `{ kind, description, detail }` and is what the dry-run shows):
1. `mv` `from` → `to` (`fs.rename`)
2. Claude project folders: list `~/.claude/projects/*`, read the `cwd` of the first transcript line that has one (the slug can't be inverted), and select the folders whose cwd is `from` or under `from/`. Each is renamed to `slug(resolveMovedPath(cwd))`. A folder whose target slug already exists (Claude Code was already started in `to`) is **merged**: files move one by one, and a name collision is a blocker. `memory/` is listed explicitly in the step detail so the user sees it travel.
3. `cc-sessions.db`, one transaction: `project_dir`, `cwd` via `resolveMovedPath`, and `raw_ref`, `ingest_state.path`, `subagents.raw_ref` via the transcript-folder renames from step 2
4. `usage-cache.json`: rename the `files` keys for renamed transcripts and keep `size`/`mtimeMs`/`offset`/`state`, so there's no re-parse and no ghosts. The stored `state.cwd` is left alone; the alias table handles it at aggregation time.
5. Append to `path-moves.json`
6. Ledger: rewrite `directory` (and `checkout.root`) for the rows under `from`. AI data follows, because the rows are the same rows.
7. Register: point the location at `to` through #8's writer (`relocateLocation({ from, to })`, assumed)

The **Codex** rollouts and the **Claude transcripts** are not edited. Their old `cwd` resolves through `path-moves.json` (step 5). The `~/.claude.json` per-project entry (trust, allowed tools, MCP servers keyed by absolute path) is **reported as a warning, not rewritten**, because it is Claude Code's own config (Q7).

`planHash` = sha256 of `{from, to, steps}`. The executor refuses a plan whose hash doesn't match a fresh re-plan, so the user always confirms exactly what will happen.

### `executeRelocation(plan, deps)` → `{ ok, done[], failed?, rolledBack }`

- First write the journal `dataFile('relocations/<ts>-<id>.json')` (`{ plan, done: [] }`), then run the steps in order, appending to `done` after each one.
- On failure, undo the completed steps in reverse. Every step has an inverse: rename back, a DB transaction that never committed, cache keys renamed back, the alias entry removed. The journal records the outcome. A crash mid-way leaves the journal, and `scripts/relocate.mjs --resume <journal>` finishes or rolls back.
- A concurrent ingest or usage run would race with steps 3–4. The executor holds the existing serialised ingest lock (`runIngest` sharing) and refuses while an analyze or summary batch is running (`summary_jobs` running row, analyze status).

### Alias consumers (so the move survives re-ingests)
- `src/lib/path-moves.mjs`: `loadPathMoves()` (state dir, at call time) and `resolveMovedPath()`
- `ingest-run.mjs`: Claude and Codex rows get `project_dir = resolveMovedPath(project_dir)` and `cwd = resolveMovedPath(cwd)` before upsert
- `usage.mjs` `aggregateUsage`: `st.cwd` is resolved before the deepest-project match
- With an empty `path-moves.json` the hot paths behave exactly as today (an early return when there are no moves)

## API, CLI, UI

- `GET /api/reorg?running=<dirs>` → `{ suggestions, summary }`. It reads the register, ledger and dismissals at request time (state-dir helpers, never at module eval).
- `POST /api/reorg/apply { id, action }` → runs the virtual action through #8's writer and returns the refreshed report
- `POST /api/reorg/dismiss { id }` / `DELETE` to undo
- `POST /api/reorg/relocate { from, to, dryRun: true }` → the plan. `{ from, to, planHash, force? }` → executes it.
- `scripts/relocate.mjs --from <dir> --to <dir> [--apply] [--force] [--resume <journal>]`: dry-run by default, prints the plan. This is the "verify on one project first" path. `npm run relocate`.
- **ReorgReportDialog**, rebuilt on the report:
  - sections Client placement, Stale copies, Abandoned, Orphans, each with a count
  - per row: the primary button is the virtual action (e.g. "Confirm client InteliMail", "Mark stale", "Archive", "Remove"), plus Dismiss and Open details
  - "Move on disk…" sits in a ⋯ menu, only where `move` exists. It opens a dry-run panel (steps, blockers, warnings, memory folders) with a confirm button that is disabled while there are blockers.
  - The "Copy mv command" button is removed: it was the unsafe path this issue exists to replace.
  - Until the register exists (no `register` in state), the dialog falls back to today's AI-only view. Since #8 and #9 merge first this should not matter, but it keeps the dialog working if the register file is missing.

## Error handling

- A missing register is treated as an empty register, so the report is empty except for the legacy fallback.
- Missing or malformed `reorg-dismissed.json` / `path-moves.json` → treated as empty. A malformed `path-moves.json` is **not** overwritten: the error shows in the report, because losing aliases would silently re-split history.
- Relocation: any step error leads to rollback, and the result shows what was undone. A rollback that itself fails leaves the journal and returns a clear "manual fix needed" with the journal path.

## Testing (colocated `*.test.mjs`, `node --test`)

- `src/lib/reorg.test.mjs`: each rule, with positive and negative fixtures (manual client skipped, case-insensitive `_Bizz` match, deploy copy not stale, dirty copy not stale, running experiment not abandoned, orphan evidence), dismissal and its fingerprint invalidation, stable ids, ordering
- `src/lib/path-moves.test.mjs`: exact match, prefix with a `/` boundary (`/a/foo` doesn't match `/a/foobar`), chained moves, malformed file
- `src/lib/relocate.test.mjs`: everything in `mkdtemp` with a fake home and a temp `node:sqlite` file DB:
  - plan blockers (exists, cross-device via an injected `stat.dev`, running process via injected exec, linked worktree via injected exec)
  - slug-folder selection by transcript cwd, including a sub-folder session and a folder that only looks similar
  - merge into an existing target slug, and a collision blocker
  - DB rewrite, usage-cache rekey with no re-parse, ledger and register updates
  - a failure injected at each step rolls back to the exact prior state
  - `planHash` mismatch refused, and resume from a journal
- `src/lib/cc/ingest-run.test.mjs` / `src/lib/usage.test.mjs`: an alias applied on re-ingest and on aggregation, with no behaviour change when there are no moves
- Manual: `npm run relocate -- --from … --to …` dry-run on one real throwaway project, then `--apply`. Check that Claude Code in the new folder sees memory and `--resume` history, that the sessions page shows the new path, and that the AI `$` is unchanged before and after.

## Contract assumed from #8/#9

| Need | Assumed shape | Source |
|---|---|---|
| Register I/O | `loadRegister()` / `saveRegister(reg)` under the state dir | #9 spec |
| Register shape | `{ projects: [{ id, identity, client, client_source, locations: [{ directory, role, primary }] }] }` | #8 issue, #9 spec (`client`/`client_source` from #10's plan) |
| Ledger row link | `row.project_id`, `row.checkout = { root, subpath, git }` | #9 spec. #10's plan assumes `row.vp` instead, so Task 0 reconciles the two. |
| Writers | `setProjectClient({ projectId, client, source: 'manual' })`, `setLocationRole({ directory, role })`, `removeProject(projectId)`, `relocateLocation({ from, to })`, `setProjectArchived(projectId, bool)` | #10's plan assumes the first two. The last three are new asks for #8 (Q1, Q2). |
| Orphans | projects with `locations: []` are kept by the scanner | #9 spec |

If #8 lands with other names, only the imports in `reorg-apply.mjs` and `relocate.mjs` change.
