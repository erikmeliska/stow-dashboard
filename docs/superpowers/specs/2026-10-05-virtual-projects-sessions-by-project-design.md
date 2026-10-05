# Virtuálne projekty 5/6 — sessions podľa projektu (design)

Issue: #12 (TRI-STOW-0012). Series: #8–#14, label `virtual-projects`.
Depends on: **#8** (register model, project id). **Not merged yet.** This design is written against the model #8 *describes*. See "Contract assumed from #8". Where #9 (`project_id` on ledger rows) helps, it is used if present but not required.

## Goal

Every row in `data/cc-sessions.db` knows **which project it belongs to** and **which workspace it ran in**:

1. `sessions.project_key` (a column that exists today but is always empty) holds the **register project id** from #8.
2. Sessions that ran in a worktree or a scratchpad are attributed to the **main project**, not to a "project" named after the worktree:
   - `.agent-office/worktrees/<slug>`
   - `.claude/worktrees/<name>`
   - any linked git worktree (`git rev-parse --git-common-dir`)
   - Claude scratchpads `/private/tmp/claude-<uid>/<slug>/<session>/scratchpad/…`
3. A new field `workspace` records where it ran, e.g. `agent-office: pixel-77d1`. It is shown as a badge in the session table, calendar and detail panel.
4. Existing rows are backfilled. Session-side aggregations (analytics "top projects", the per-project session list, grouping and colouring by project) use the project, not the raw directory.

Out of scope (sibling issues): the register itself and client derivation (#8), checkout merging and `.stow/project.json` (#9), projects UI and the per-virtual-project AI `$` sum across locations (#10), physical moves and rewriting `project_dir`/`cwd` (#11), session **filters**/sorting by client/project/workspace, Color by client, MCP `list_clients` (#13), agent-office export (#14).

## What the live data says (session store, 2026-10-05, 1338 rows)

| | rows | distinct dirs |
|---|---|---|
| `project_key` filled | 0 | — |
| in `.agent-office/worktrees/*` | 49 | 19 (plynconvertor alone: 17 worktrees, 46 sessions, vs 9 in its main checkout) |
| in `.claude/worktrees/*` | 11 | 7 |
| in `/private/tmp/claude-*/…/scratchpad` | 3 | 2 (one of them is a scratchpad *of* a `.claude` worktree) |
| **total split off their project** | **63** | 28 |

- All 19 agent-office worktrees are **already deleted** (the office removes them on `send_home`). Only 5 of the `.claude` worktrees still exist. So git can't be the primary signal. **Path rules come first**, and git only covers live worktrees with an unknown layout.
- The ledger has **no** worktree rows (dot-dirs are ignored by the scanner). Worktrees are therefore never register locations. They are workspaces *of* a location.
- 143 distinct session dirs. After stripping worktree segments, 35 are not under any ledger project, and 30 of those still exist (`~`, `~/Projekty`, `_Sandbox/qr-demo`, …). That bounds the git probes per run at about 30, and they are memoized.
- By source: 1214 Claude, 53 Gemini/Antigravity, ~70 Codex. Every worktree session is a Claude session today, but the rules are path-based and apply to every source.

## Concepts

- **Run dir**: the directory the session ran in. For Claude it is `cwd`. For Codex and Gemini it is the existing `project_dir` (already the source-specific best guess: `deepestProject`, Gemini's `accessedPaths`), else `cwd`.
- **Workspace**: a disposable working copy or scratch space attached to a project checkout. Stored as `kind:name`, displayed as `kind: name`. `null` means the session ran in the checkout itself.

  | kind | recognised by | name |
  |---|---|---|
  | `agent-office` | `<base>/.agent-office/worktrees/<slug>[/rest]` | `<slug>` (= the worker, e.g. `pixel-77d1`) |
  | `claude-worktree` | `<base>/.claude/worktrees/<name>[/rest]` | `<name>` |
  | `scratchpad` | `/private/tmp/claude-<uid>/<slug>/<uuid>/scratchpad[/rest]` (also `/tmp/…`) | first 8 chars of `<uuid>` |
  | `git-worktree` | live dir, `git rev-parse` says linked worktree | basename of its toplevel |

- **Base dir**: the run dir mapped back onto the main checkout, keeping any sub-path. For example, `<base>/.agent-office/worktrees/x/packages/a` becomes `<base>/packages/a`, so monorepo members keep their attribution. If nothing matches, base dir = run dir.
- **Project key**: the register project whose location (or, with #9, ledger row with `project_id`) is the **deepest ancestor-or-self** of the base dir. `null` if there is none. It is never a path; the issue requires the register id.

### Scratchpad slug decoding

Claude names a scratchpad's parent directory after the session's cwd with every non-alphanumeric character replaced by `-`. For example, `/Users/ericsko/Projekty/_Bizz/TriSoft/vydavatelstvo/.claude/worktrees/admiring-williamson-fa72a2` becomes `-Users-ericsko-Projekty--Bizz-TriSoft-vydavatelstvo--claude-worktrees-admiring-williamson-fa72a2`. That encoding is lossy, so it is **matched, not decoded**: encode every known location (and ledger directory) the same way and take the longest one where `slug === enc` or `slug.startsWith(enc + '-')`. The workspace stays `scratchpad`, because that is where the session ran. If the remainder encodes a worktree (`--agent-office-worktrees-…`, `--claude-worktrees-…`), base dir is the matched location itself. If nothing matches, then `base_dir = null`, `project_key = null`, and the workspace is still `scratchpad:<id>`.

## Store changes (`store.mjs`)

| column | type | owner | meaning |
|---|---|---|---|
| `project_key` | TEXT (exists) | placement pass | register project id or null |
| `workspace` | TEXT (new, migration) | placement pass | `kind:name` or null |
| `base_dir` | TEXT (new, migration) | placement pass | main-checkout dir (with sub-path) or null |

- New index `idx_sessions_project_key`.
- `project_dir` and `cwd` keep today's meaning (where it ran). #11 rewrites them on physical moves, and `session-link.mjs` uses `project_dir` for its same-directory rule. This issue changes neither.
- The three columns are **not** in `SESSION_COLS`. Like the summary columns, an ingest upsert never touches them. One writer: `setPlacement(db, rows)`.

## Placement pass (`src/lib/cc/project-key.mjs`, pure + injectable exec)

```
resolveWorkspace(runDir, { locations, exists, gitProbe }) → { base_dir, workspace }
buildProjectIndex({ register, ledgerRows }) → { lookup(baseDir) → project_id|null, encodedDirs }
placeSession(row, ctx) → { project_key, workspace, base_dir }
assignPlacements(db, ctx) → { checked, updated }     // ingest-run calls it once per run
```

Order of rules in `resolveWorkspace`: agent-office → claude-worktree → scratchpad → (dir exists **and** has no ancestor-or-self that is a known location) git probe → plain.

- The git probe is `git -C <dir> rev-parse --path-format=absolute --git-common-dir --show-toplevel`. It is a linked worktree when the common dir ends in `/.git` and `dirname(common) !== toplevel`. Then base = `dirname(common)` + the dir's path relative to the toplevel. A bare common dir (no `/.git` suffix) means no mapping. Results are memoized per process in a `Map` (path → result), since a path's worktree-ness doesn't change. In the 60 s cycle only the first run pays the ~30 spawns.
- `assignPlacements` runs **after** the three ingest loops and **before** `linkChildren`. It reads `session_id, cwd, project_dir, project_key, workspace, base_dir` for **all** rows (~1.3k), recomputes, and writes only the rows that differ, in one transaction. Recomputing everything (no signature) is what makes it the backfill, and lets register changes (a project created, a location moved by #9) propagate within one cycle. Cost target: < 30 ms warm on today's DB, measured in the plan.
- Locations come from #8's `loadRegister()` at call time (state dir, never at module eval). If the register is missing or unreadable, `project_key` stays null, and `workspace`/`base_dir` are still filled. So the worktree fix works even before the register has data.

## Consumers

**API** `GET /api/sessions`:
- Rows carry the new columns. `project_name` = the register project's name if #8 has one, else the basename of `base_dir || project_dir`.
- The existing `?project=<dir>` matches `base_dir = dir OR base_dir LIKE dir || '/%'` (falls back to `project_dir` when `base_dir` is null), so a project's worktree sessions are included.
- New `?project_key=<id>`, used by the details-sheet "View sessions →" link when the project has an id.
- The filter picker UI is #13's.

**UI** (`src/app/sessions/*`):
- `WorkspaceBadge` (small outline badge, `agent-office: pixel-77d1`) next to the project name:
  - session table project cell
  - calendar chip: non-compact line + tooltip
  - detail panel header, which also shows the raw `project_dir` as today
- Project label everywhere = `project_name`.
- Table "group by project" and calendar "Color by project" key on `project_key || base_dir || project_dir`. The colour hash uses the same key, so all of plynconvertor's sessions get one colour.
- `session-filters.mjs` search also matches `workspace` and `base_dir`.

**Analytics** (`analytics.mjs` `topProjects`): `GROUP BY coalesce(project_key, base_dir, project_dir)`. Label = `project_name` as above. The response adds `project_key`.

**MCP** `list_sessions`: adds `project_key` and `workspace` to each family. `project` = the project name as above.

**Usage ledger** (`usage.mjs aggregateUsage`): today it maps a cwd to the deepest ledger dir by prefix. That already folds `.agent-office`/`.claude` worktrees into their project, because they live *inside* it. Scratchpads in `/private/tmp` are dropped. The design runs the cwd through `resolveWorkspace` (path rules only, no git probe) before matching, so scratchpad cost lands on its project. Summing a virtual project across several checkout locations is #10's job, not this one. See open question Q4.

## Error handling

- The git probe fails (not a repo, safe.directory refusal, ENOENT) → no mapping. That result is memoized too.
- A malformed register → treated as an empty index, plus one `console.warn` per run. Ingest never fails because of placement.
- `assignPlacements` throws → caught in `ingestAll`, which logs it and returns `placement_error`. Session upserts from that run are already committed.

## Testing

Colocated `*.test.mjs`, `node --test`, exec injected, no real git or home:

- `project-key.test.mjs`:
  - each workspace kind, including a sub-path inside a worktree and a scratchpad of a `.claude` worktree (the real vydavatelstvo case)
  - an undecodable scratchpad
  - deepest-location wins (monorepo member vs repo root)
  - no register → null key with workspace still set
  - git-probe linked / main / bare / failure
  - memoization (exec called once)
- `store.test.mjs`: migration adds `workspace`/`base_dir` on an old-schema DB, and an upsert leaves the placement columns untouched.
- `ingest-run.test.mjs`:
  - backfill: existing rows with null placement get filled in one run
  - a register change re-keys rows on the next run
  - an unchanged second run writes 0 rows
- `analytics.test.mjs`: a project with main and worktree sessions is one top-project entry.
- `route.test.mjs`: `?project=` includes worktree rows, `?project_key=` works.
- `session-tree` / `session-calendar` tests: the group key and colour key use `project_key`.
- `usage.test.mjs`: scratchpad cwd attributed to its project.

## Contract assumed from #8

These are the same names as in the #9 plan (PR #16), so the two stay consistent. If #8 lands with different names, only the import in `project-key.mjs` changes.

| Need | Assumed shape |
|---|---|
| Register I/O | `loadRegister() → { projects: [...] }` under the state dir |
| Project | `{ id, name?, locations: [{ directory, role, primary }] }` |
| Ledger row (optional, #9) | `project_id` on rows of `projects_metadata.jsonl` |

## Alternatives considered

1. **Resolve at read time** (API joins paths to the register on every request, no schema change). Rejected: analytics groups in SQL, and the MCP server and CLI would each need the same join. Both would also pay git probes per request.
2. **Rewrite `project_dir` to the main checkout.** Rejected: it loses where the session actually ran, conflicts with #11 (which rewrites `project_dir` on moves) and changes `session-link`'s same-directory rule as a side effect.
3. **A separate `session_projects` mapping table.** Rejected: there is one row per session anyway, so plain columns are simpler to query.

## Open questions (for the PR)

1. **Non-primary checkouts**: a session in `intelimail/blog-huha` (a second location of the blog project, per #9). Should it get `workspace = null` (it's a checkout, not a worktree; base_dir already says which), or `checkout: blog-huha` so #13 can filter "main checkout vs. others"? The design proposes `null`.
2. **Scratchpad workspace name**: the design uses `scratchpad:<8-char session uuid>`. The uuid is the parent session's id, so it could also link the scratchpad session as a child in the family tree. Should we do that here, or later?
3. **`project_key` for sessions outside any project** (`~`, `~/Projekty`, Obsidian vault): it stays null and shows as "—". Should the register (#8) get pseudo-projects for these, or is "Unassigned" fine?
4. **Project AI `$` column**: is the scratchpad tweak to `aggregateUsage` wanted here, or does all of "cena projektu" belong to #10 (summing across locations)?
5. **Security-review linking**: `linkChildren` prefers a parent in the same `project_dir`. Comparing `base_dir` instead would link reviews of worktree sessions better. Should that be a follow-up issue rather than part of #12? The design leaves it as a follow-up.
