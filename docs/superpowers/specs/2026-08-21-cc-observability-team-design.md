# Claude Code Observability, Guard & Team Sync — Design

Date: 2026-08-21
Status: Approved direction (hybrid). Pending spec review before planning.

## 1. Goal

Give an individual — and later a whole team across multiple machines — visibility and
control over Claude Code usage:

- **Guard**: block dangerous shell commands before they run (safety hooks).
- **Observability**: per-session audit + metrics — tokens, cost, tools, skills, duration,
  work context (Jira ticket / git branch / PR / project).
- **Eval / summaries**: AI-generated session summaries and a session quality score;
  detect whether skills/tools were used and whether skills were improved.
- **Team**: sync local session data to a shared server, aggregating across project dirs,
  machines, and users — with per-project egress control over what leaves each machine.

## 2. Key decision: build on stow-dashboard (hybrid), do NOT build a separate platform

Assessment of the existing `stow-dashboard` repo showed it already implements ~70% of the
observability core, working, with real data:

- **Transcript mining** from `~/.claude/projects/*.jsonl` (`src/lib/usage.mjs`): per-model
  token attribution (input/output/cache read, cache-write 5m/1h), Codex support, careful
  handling of duplicate token events and cache migration.
- **Pricing / cost** (`pricing-sync.mjs`, `usage-pricing.mjs`), incl. cache buckets; knows
  `claude-opus-4-8`. Real output in `data/usage.json` (per project, per model, session lists).
- **Skills subsystem** (`scripts/skills.mjs` + `skills.manifest.json`): link/vendor skills per project.
- **AI analyzer + distill** (`analyzer.mjs`, `distill.mjs`): per-project fact sheet + AI
  classification (the `aiCategory` / `aiCost` facets).
- **Dashboard + MCP + desktop**: Next.js 16 + shadcn, tables/filters/detail sheet, MCP server,
  Deno desktop app; `run-logs/`, state dir.

Rebuilding these separately would duplicate the transcript parser, pricing, per-model
attribution, skills manifest, dashboard, and MCP — and create two tools both reading
`~/.claude`. Therefore:

- **Observability / eval / team → extend stow-dashboard** (reuse parser, pricing, UI, MCP).
- **Guard → standalone tiny package `cc-guard`** — one file, zero deps, installs into
  `~/.claude/settings.json`, must run on every machine even without the dashboard. It only
  blocks and appends guard events to a local audit that stow ingests.

Rationale: the guard is a different discipline (real-time safety enforcement, must always run
and be fast). Everything else is the same observability mission stow already started.

## 3. Architecture (approach A: hook-driven guard + post-session transcript mining)

Two capture paths, one store, one viewer, one deferred sync.

1. **Guard path (synchronous, `cc-guard`)**: Bash tool call → PreToolUse `guard.mjs` →
   match against `guard.rules` → allow / deny (nonzero exit) → append guard event to local audit.
2. **Capture path (lightweight hooks)**: SessionStart / Stop / SessionEnd / UserPromptSubmit
   append lifecycle markers to the local audit.
3. **Process path (post-session, re-runnable)**: ingest reads the native transcript
   `~/.claude/projects/<proj>/<session>.jsonl` + lifecycle markers → normalize into events →
   eval computes metrics + work-context enrichment (git / Jira) + AI summary → write to the
   local store. Reuses stow's `usage.mjs` for token/cost extraction.
4. **View path**: session-centric viewer reads the local store ("kukátko" on your own sessions).
5. **Sync path (deferred)**: apply per-project config + egress policy → push selected data to
   the team server, which stitches it together.

Why A over a real-time daemon: the guard must be synchronous (it is a hook); everything else is
analytics that can run after the session from data Claude Code already writes. No always-on
component that can silently die (the exact failure of the current `localhost:8765` collector,
which is not even running).

## 4. Local data model (rich locally; egress is filtered at sync)

Principle: **collect richly locally, decide what leaves the machine only at sync time.**

Local store (SQLite via better-sqlite3, or extend stow's existing state — see Open Questions):

- **sessions**: session_id, machine, user, project_dir, **project_key**, cwd, model,
  started_at, ended_at, duration, tokens (input/output/cacheRead/cacheWrite5m/cacheWrite1h),
  cost_usd, turns, status, git_repo, git_branch, pr, jira_ticket, quality_score, summary,
  raw_ref (path to local transcript).
- **events**: id, session_id, ts, type (`tool_use` | `prompt` | `guard` | `skill` | `lifecycle`),
  tool, skill, detail_json (rich local context lands here).
- **skill_usage** / **tool_usage**: session_id, name, count; `skill_edited` flag
  (= a skill file was modified → "we improved a skill").
- **guard_hits**: session_id, ts, command, rule, action (allow / deny / override).
- **sync_state**: per row/table — what has been sent, with which egress version + log level.

**Stable project identity now**: every session is tagged with a `project_key` (see §7) even
before the server exists, so cross-dir / cross-machine aggregation is bezbolestný later.

## 5. Guard policy (default: block + exceptions)

Default **deny** patterns (audited): `rm -rf` on `/`, `~`, or broad globs; `git push --force` /
`-f` to protected branches; `DROP TABLE` / `DROP DATABASE` / `TRUNCATE`; `chmod -R 777`;
`dd of=/dev/…`; `mkfs`; fork bomb; `kill -9 -1`. **Warn** (configurable to deny):
`git reset --hard`. Configurable **allowlist** per repo/user; one-shot **override** (env var or
marker). Every decision → `guard_hits` + event. Rules live in `guard.rules.json`.

## 6. Eval / summaries

- **Metrics**: tokens + cost (reuse stow), duration, turns, tools (+counts), skills (+counts,
  `skill_edited`), files touched, guard hits, work context.
- **Quality score v1**: transparent heuristic (completed vs errored, guard incidents,
  loops/retries, whether verification ran). Explicitly a heuristic; refine later.
- **AI summary**: a Claude call over the transcript → what was solved, skills/tools used,
  improvements, follow-ups. Stored per policy (metadata + summary; raw stays local only).

## 7. Team sync — Sentry-style model (deferred server, designed now)

Client model, analogous to Sentry DSNs:

- On the server, create a **group**; add **projects** to it. A project may aggregate multiple
  local project dirs — even the same project in different dirs, on different machines.
- Each local project carries a **project config** (DSN-like) in its directory: `project_key`,
  `ingest_url`, `log_level`. Storage TBD (`.env`, dedicated `.ccobs` file, or stow config).
- The **synchronizer** walks project dirs, reads that config, and — combined with the
  **egress policy** and `log_level` — decides **what** session data goes **where**.
- The **server** joins incoming data by `project_key` into logical projects and groups,
  stitching across dirs / machines / users.

Egress policy (`egress.rules.json`): per-field / per-table / per-project rules for what leaves
the machine. Default conservative (metadata + summaries); configurable to send more. Combined
with per-project `log_level`.

The `sync` adapter interface is defined in phase 3; the server implementation is out of scope
for the first phases (its data model — group/project/key aggregation — is captured here so the
local schema stays forward-compatible).

## 8. Components / repo layout

**`cc-guard`** (new standalone repo/package):

```
cc-guard/
  guard.mjs            # PreToolUse: deny destructive commands + append audit
  install.mjs          # writes hook into ~/.claude/settings.json
  guard.rules.json     # patterns + allowlist
```

**`stow-dashboard`** (extend existing):

```
src/lib/
  cc/ingest.mjs        # transcript + lifecycle → normalized events (reuses usage.mjs)
  cc/eval.mjs          # metrics + quality score + AI summary
  cc/context.mjs       # git branch/repo/PR + Jira ticket enrichment
  cc/store.mjs         # session-centric store (SQLite or extend stow state)
  cc/sync.mjs          # egress policy + push adapter (interface; impl phase 3)
hooks/
  lifecycle.mjs        # SessionStart/Stop/SessionEnd/UserPromptSubmit markers
src/app/sessions/      # session-centric viewer ("kukátko"): list + detail
```

New session-centric view is additive to stow's current project-centric UI.

## 9. Phasing

- **Phase 1 (MVP)**: `cc-guard` (block + exceptions + audit) + stow session ingest reusing
  `usage.mjs` + basic per-session metrics + minimal session view. Useful immediately, solo.
- **Phase 2**: AI summaries + quality score + work-context (Jira/branch/PR) + richer session view.
- **Phase 3**: sync layer + egress policy + per-project DSN config + team server + team dashboard
  (cross-dir / cross-machine / group aggregation).

## 10. Open questions (resolve during planning)

- Local store: new SQLite table set vs. extend stow's existing JSON state (`usage.json` +
  `projects_metadata.jsonl`). Leaning SQLite for session-level queries.
- Per-project sync config location: `.env` vs dedicated `.ccobs` file vs stow config.
- Server data model & transport (phase 3) — out of scope now, only the aggregation key
  (`project_key` → project → group) is fixed.
- Quality score formula details.
