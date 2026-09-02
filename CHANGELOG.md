# Changelog

Notable changes, newest first. Dates instead of versions — the app isn't
versioned; the desktop build ships whatever `main` holds.

## 2026-09-02

- **Analytics page** (`/analytics`): two tabs of charts. *Agentic sessions* —
  KPI tiles (sessions, cost, tokens, active time, tool calls, guard hits,
  quality) plus per-day sessions/cost, model distribution, input vs output
  tokens by model, top tools/skills/projects and a quality histogram, scoped
  by a 7d/30d/90d/all range filter. *Project portfolio* — categories,
  maturity, top languages, AI cost and commit-activity charts over the whole
  ledger. New `GET /api/analytics`, aggregations in `src/lib/cc/analytics.mjs`,
  charts via recharts with a CVD-validated palette (light/dark stepped
  separately).
- **Desktop app renamed** to plain **"Stow Dashboard"** — window title, tray
  tooltip and the built bundle (`dist/Stow Dashboard.app`). The app-data dir
  stays `StowDashboardDeno`, so existing state carries over.

## 2026-08-22

- **Incremental session ingest**: `ingest_state` keeps a size+mtime signature
  per transcript (main + subagents); unchanged sessions are skipped (~0.1 s
  vs ~5 s full re-parse). Stable signatures across Node and Deno runtimes.
- **Session store kept fresh automatically**: `POST /api/sessions/ingest` runs
  on `/sessions` load/Reload and inside the 60 s refresh cycle.
- **Per-project session view**: "View sessions" link in the details sheet,
  `?project=` filter chip on `/sessions`.

## 2026-08-21

- **Claude Code observability, phase 1b**: `node:sqlite` session store
  (`data/cc-sessions.db`) — per-session tokens/cost/tools/skills parsed from
  `~/.claude` transcripts, cc-guard audit ingested as guard hits, `/sessions`
  viewer + `/api/sessions` API, `npm run cc:ingest`.
- **Phase 2 (eval + context)**: work context per session (git branch/repo,
  PR, tool-agnostic ticket id), transparent quality score v1 with stored
  components, and on-demand AI summaries via the local `claude` CLI
  (`npm run cc:eval -- --summaries`, Generate button).

## 2026-08-11

- Quick refresh now updates git status **table-wide** (cheap porcelain-v2
  pass for every repo, escalating to the full walk only when HEAD moved),
  not just for running projects.

## 2026-07-19 … 2026-07-27

- **AI usage pricing from a vendored LiteLLM snapshot** (`pricing-data.json`,
  `npm run pricing:sync`) — Claude and Codex priced identically per model;
  unknown models surface as `unpriced`, never silently $0. Per-model Codex
  attribution via `turn_context` deltas. `claude-opus-5` priced.
- **ccusage calibration script** (`scripts/calibrate-usage.mjs`) — hand-run
  cross-check of the ledger against an independent tool; documented the known
  Claude drift (TRI-STOW-0003, a pre-existing parse dedup bug).

## 2026-07-16

- **One state dir** for the web app, desktop app, CLIs and MCP server
  (`src/lib/state-dir.mjs`, `STOW_STATE_DIR`) — ends the era of two ledgers.

## 2026-07-10

- **AI usage tracking**: per-project token/cost ledger (`data/usage.json`)
  tail-parsed from Claude Code + Codex transcripts, AI `$` column and a
  details-sheet breakdown, refresh-cycle updates and `/api/usage/rebuild`.
- **AI project analysis**: on-device model (apfel) categorizes every project
  into the `_*` taxonomy with facets (type, domain, maturity, tech, docs);
  deterministic derivations (status, suggested path, merged tech tags);
  Ollama fallback for rejected/oversized projects; incremental batch with
  `input_hash` gating; UI columns, facet filters, AI Insights panel and a
  reorg report; background job with poll/resume.
- **MCP** exposes AI facets, usage costs and reusable-asset search.
- Scanner resilience: no data loss on errors, bounded discovery concurrency,
  per-request env reads.

## 2026-07-05 … 2026-07-08

- **Deno desktop shell** (`deno desktop`): window + tray running the Next.js
  standalone server in-process; verified against the Tauri shell and adopted
  as the shipped app (ADR 0002, Tauri kept as fallback).
- Unified 60 s refresh cycle (processes + auto-discovery + git refresh) with
  manual Refresh; project auto-discovery from process cwds.
- Open-with pickers (IDE/terminal split buttons) + settings dialog
  (`.env.local` editor in the header).

## Earlier (2026-02 … 2026-06)

- Interactive project table (TanStack), group/quick filters, details sheet
  with live git status, process & Docker monitoring with kill/stop controls,
  script runner with log capture, scc code stats + COCOMO estimates,
  README viewer, TASKS.md task counts, MCP server (21 tools), Tauri desktop
  app, incremental scanner with gitignore-aware sizing.
