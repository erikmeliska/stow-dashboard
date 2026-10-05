# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stow Dashboard is a Next.js 16 web application (React 19) that visualizes projects scanned by `stow-agent`. It displays project metadata, Git information, file statistics, and technology stack detection from a JSONL data file.

Available as a web app or native desktop app. The shipped desktop app is the Deno shell (`src-deno/`, see ADR 0002); the Tauri shell (`src-tauri/`) is kept as a buildable fallback.

## Commands

```bash
# Development
npm run dev          # Start dev server with Turbopack (port 3089)

# Web Production
npm run build        # Build for production
npm run start        # Start production server (port 3088)

# Desktop App (Deno — shipped shell, requires Deno >= 2.9; see ADR 0002)
npm run deno:prepare  # Build Next.js + assemble src-deno/standalone
npm run deno:run      # Compile + launch dist/Stow Dashboard.app
npm run deno:build    # Build dist/Stow Dashboard.app
# Install/update: ditto "dist/Stow Dashboard.app" "/Applications/Stow Dashboard.app"

# Desktop App (Tauri — fallback shell, requires Rust)
npm run tauri:build  # Build native macOS app + DMG
npm run tauri:dev    # Run desktop app in dev mode

# AI Analysis & Usage
npm run analyze      # AI project analysis batch (incremental; --force, --retry-errors, --pilot, --data <file>)
npm run registry     # Read-only summary of the virtual-project register (--multi, --unassigned, --json)
npm run registry:export  # Write data/agent-office.json (client → building, project → floor) for agent-office (--unassigned, --stdout; --client <name> prints only, never writes)
npm run usage        # Rebuild the AI usage/cost ledger from CLI transcripts (--rebuild re-parses from zero)
npm run pricing:sync # Refresh src/lib/pricing-data.json (the vendored LiteLLM snapshot) from LiteLLM upstream
node scripts/calibrate-usage.mjs  # Cross-check usage.json's cost against ccusage (hand-run, not npm test — needs ccusage installed)
npm run cc:ingest    # Update the Claude Code session store (data/cc-sessions.db) from ~/.claude transcripts + cc-guard audit (incremental; --full re-parses)
npm run cc:eval -- --summaries [--limit N] [--id SID] [--since D --until D --concurrency N --model M --upgrade]  # AI summaries via the local `claude` CLI (batch over a period with --since/--until; live heartbeat clock)
npm run cc:import-summaries -- <sessions.json> [--dry-run]  # One-off import of PoC session descriptions as v2 summaries (keeps existing v2)

# Other
npm run lint         # Run ESLint
npm test             # Run tests (node --test)
```

**Ports:** Dev uses `3089`, Production/Tauri uses `3088`. Deno shell requests `3087`, but both `deno:run` and `deno:build` produce a compiled `deno desktop` app, which binds a runtime-assigned port exposed via `DENO_SERVE_ADDRESS` instead (see docs/deno-vs-tauri.md).

Next.js 16 uses Turbopack by default and separates dev/build outputs (`.next/dev` vs `.next/build`), so `npm run build` won't interfere with a running dev server.

### Tests

Tests use the built-in Node.js test runner (`node --test`, no framework dependency) with `node:assert/strict`. Test files are colocated with the code they cover as `<module>.test.mjs` (e.g. `src/lib/scripts.test.mjs`, `src/scanner/index.test.mjs`, `scripts/skills.test.mjs`). Run all with `npm test`, or a single file with `node --test src/lib/<file>.test.mjs`. Tests that need a filesystem or git create temp dirs via `mkdtemp` and clean up after themselves; subprocess-calling code takes an injectable exec so tests never require external tools.

### Scanner

```bash
npm run scan        # Scan projects and sync to JSONL
npm run scan:force  # Force rescan all projects
```

Or use the CLI directly:
```bash
node scripts/scan.mjs -s data/projects_metadata.jsonl
node scripts/scan.mjs -r ~/Projekty ~/Work -s   # Override roots
node scripts/scan.mjs -f -s                      # Force update
node scripts/scan.mjs --cleanup                  # Delete legacy .project_meta.json files
```

**Incremental scanning:** The scanner uses the JSONL file itself as a cache. On subsequent scans, only projects with files modified since the last scan are re-analyzed. This makes repeat scans ~8x faster.

**Scanner features:** Concurrent analysis (8 projects at a time), respects `.gitignore` files for accurate file type/size analysis, integrates `scc` for code metrics, uses `ignore` npm package for gitignore pattern matching.

API endpoint: `POST /api/scan` with optional `{ force: true }` or `{ cleanup: true }`

### Environment Variables

Configure in `.env.local`:
```bash
SCAN_ROOTS=/Users/ericsko/Projekty,/Users/ericsko/Work  # Comma-separated
BASE_DIR=/Users/ericsko/Projekty                         # For relative paths in UI
IDE_COMMANDS=code,cursor,zed        # Comma-separated IDE CLI commands (first = default; legacy IDE_COMMAND still honored)
TERMINAL_APPS=Terminal,Warp,cmux    # Comma-separated terminal apps (first = default; legacy TERMINAL_APP still honored)
OLLAMA_URL=http://localhost:11434   # AI-analysis fallback engine for language-rejected/oversized projects (default)
OLLAMA_MODEL=llama3                 # Ollama model for the fallback (default)
CC_CODEX_DIR=~/.codex/sessions      # Codex rollouts dir ingested as a third session source (default)
CC_SUMMARY_HARNESS=claude          # Which local CLI writes session summaries: claude | codex (Settings dialog)
CC_SUMMARY_MODEL=                   # Single Generate; empty = harness default (claude: haiku, codex: its built-in default)
CC_SUMMARY_BATCH_MODEL=             # Batch summaries; empty = harness default (claude: claude-sonnet-5-5, codex: its built-in default)
STOW_WRITE_PROJECT_FILES=1          # 0 = the scanner never creates .stow/project.json (no-remote checkouts fall back to a path: identity)
```

`STOW_STATE_DIR` is set in the *process env*, not `.env.local` (it decides which `.env.local` gets read): it overrides where `data/` and `.env.local` live — see "State Dir" under Data Requirements.

## Architecture

### Data Flow

```
data/projects_metadata.jsonl (JSONL file)
    ↓
lib/projects.js - readProjectsData() [Server-side]
    ↓
app/page.js [Server Component - async data loading]
    ↓
app/project-table.js [Client Component - interactive table]
    ↓
TanStack React Table (sorting, filtering, pagination)
```

### Server vs Client Components

- **Server Components**: `app/page.js` reads JSONL at request time, `app/layout.js`
- **Client Components**: `project-table.js` (marked with `'use client'`)

### Key Patterns

- **UI Components**: shadcn/ui components in `src/components/ui/` (copy-paste model, not npm-installed)
- **State Management**: React Context API defined in `app/context/ProjectContext.js`
- **Styling**: Tailwind CSS with CSS variables for theming, dark mode via `dark:` classes
- **Path Alias**: `@/*` maps to `./src/*`

### Important Files

- `src/app/project-table.js` - Main interactive table with filtering/sorting/group filter/quick filters
- `src/components/ProjectDetailsSheet.js` - Project details side panel with live git status and process info
- `src/components/ScanControls.js` - Scan buttons with progress indicator
- `src/app/api/open-with/route.js` - API for opening projects in IDE/Terminal/Finder (GET returns configured app lists; POST validates the app against them)
- `src/components/SettingsDialog.js` - Header settings dialog (.env.local editor)
- `src/components/SplitOpenButton.js` - Split button with app picker (IDE/terminal openers)
- `src/lib/open-with.mjs` - Open-with app lists, legacy fallback, allowlist validation
- `src/app/api/project-details/route.js` - API for live git status
- `src/app/api/processes/route.js` - API for detecting running processes and Docker containers
- `src/app/api/processes/docker/route.js` - API for Docker container operations (stop, restart, kill)
- `src/app/api/processes/kill/route.js` - API for killing processes
- `src/app/api/scripts/route.js` - API for listing available npm/shell scripts in a project
- `src/app/api/scripts/run/route.js` - API for running scripts in background with log capture
- `src/app/api/scripts/attach/route.js` - API for attaching terminal to running script output
- `src/hooks/useProcesses.js` - Process state hook (event-driven via the refresh cycle)
- `src/mcp/server.mjs` - Standalone MCP server for AI assistants
- `src/lib/projects.js` - JSONL parsing and data loading
- `src/lib/discovery.mjs` - Project auto-discovery from process cwds
- `src/lib/git-status.mjs` - Cheap per-repo working-tree status for the refresh cycle (porcelain v2 parse + HEAD-gated escalation to the full commit walk)
- `src/lib/utils.js` - Utility functions (cn, formatTimeAgo, getGitProvider)
- `src/scanner/index.mjs` - Project scanner (Node.js port of stow-agent)
- `src/lib/analyzer.mjs` - AI analysis: taxonomy, schema, apfel wrapper, deterministic derivations
- `src/lib/distill.mjs` - Builds the per-project distillate fed to the model
- `src/lib/tech-tags.mjs` - Deterministic tech-tag extraction and merge
- `src/lib/analyze-batch.mjs` - Incremental batch orchestration (input_hash/version gating)
- `src/lib/ollama.mjs` - Ollama fallback engine for rejected/oversized projects
- `src/lib/usage.mjs` - AI usage ledger: transcript tail-parse, aggregation, `data/usage.json`
- `src/lib/usage-pricing.mjs` - Token → USD lookup layer over the vendored LiteLLM snapshot (Claude + Codex)
- `src/lib/pricing-data.json` - Vendored LiteLLM pricing snapshot (refreshed by `npm run pricing:sync`, not hand-edited)
- `scripts/pricing-sync.mjs` - CLI that refreshes `pricing-data.json` from LiteLLM upstream
- `src/lib/scan-roots.mjs` - Resolves SCAN_ROOTS / project dirs for scan and usage
- `src/lib/state-dir.mjs` - Resolves the state dir (`data/`, `.env.local`) shared by web app, desktop app, CLIs and MCP
- `src/lib/registry/identity.mjs` - Virtual projects: remote URL normalisation → project key (`git:`/`stow:`/`path:`)
- `src/lib/registry/stow-meta.mjs` - Per-checkout `.stow/project.json` (id, client, role) read/write + git `info/exclude`
- `src/lib/registry/client.mjs` - Client key folding, `_Bizz/<Client>` detection, client catalog with aliases
- `src/lib/registry/registry.mjs` - Pure `buildRegistry` (Client → Project → Locations = checkout roots, roles) + `loadRegistry` / `data/registry.json`
- `scripts/registry.mjs` - Read-only CLI over `loadRegistry` (`npm run registry`)
- `src/lib/registry/agent-office-export.mjs` - Pure `buildAgentOfficeExport` (register → buildings/floors for agent-office, #14) + `exportAgentOffice` (atomic write of `data/agent-office.json`)
- `scripts/registry-export.mjs` - CLI over `exportAgentOffice` (`npm run registry:export`)
- `src/app/api/registry/agent-office/route.js` - `GET` the same export, built per request (`?unassigned=1`, `?client=`; unknown client → 404); never writes the file
- `src/lib/checkout-location.mjs` - Checkout root per ledger row (`git rev-parse --show-toplevel --git-common-dir`, else the row's dir; `main` for linked worktrees), bounded fan-out
- `src/lib/stow-project-file.mjs` - When the scanner creates `.stow/project.json` (no-remote roots only, never rewrites; `STOW_WRITE_PROJECT_FILES` opt-out) over #8's reader/writer
- `src/lib/checkout-merge.mjs` - Pure: stow homes needing a `.stow` id, per-checkout `identity`/`project_id` stamping, AI-data carry-forward across moves
- `src/lib/semaphore.mjs` - The `Semaphore` concurrency limiter (re-exported from the scanner)
- `scripts/scan.mjs` - CLI for running the scanner
- `scripts/analyze.mjs` - CLI for the AI analysis batch
- `scripts/usage.mjs` - CLI for rebuilding the usage ledger
- `scripts/calibrate-usage.mjs` - Hand-run cross-check of `data/usage.json` cost against `ccusage` (read-only, not part of `npm test`)
- `src/lib/cc/store.mjs` - `node:sqlite` session store (`data/cc-sessions.db`): sessions (+ `parent_session_id`/`kind`/`entrypoint`), subagents, tool_usage, skill_usage, guard_hits
- `src/lib/cc/session-link.mjs` - Session families: `kind` classification of hook-spawned SDK transcripts, the timing-based parent picker, and `effectiveKind` (work|agent-spawn|scheduled|trivial)
- `src/lib/cc/session-tree.mjs` - Pure family/rollup builder for the `/sessions` page (own vs subagents vs linked children) plus `groupFamilies` (day/week/project/branch/ticket/model with subtotals) and `sortFamilies`
- `src/lib/cc/workspace.mjs` - Pure path rules (client-safe): agent-office / `.claude` worktrees and Claude scratchpads → main-checkout `base_dir` + `workspace` (`kind:name`), `formatWorkspace`
- `src/lib/cc/project-key.mjs` - Session placement (#12): memoized git-worktree probe (injectable exec), register project index over `loadRegistry`, `placeSession`, `assignPlacements` (the backfill pass every ingest runs)
- `src/lib/cc/session-project.mjs` - Client-safe `sessionProjectKey` (`project_key` > `base_dir` > `project_dir`) / `sessionProjectLabel` (`project_name` > basename)
- `src/app/sessions/workspace-badge.js` - `WorkspaceBadge` (`agent-office: pixel-77d1`) for the session table, calendar and detail panel
- `src/lib/cc/session-filters.mjs` - Client-side filters for `/sessions`: search (ticket/project/branch/workspace), model, quality, source bucket (`sourceOf`), quick-filter chips (`QUICK_FILTERS`)
- `src/lib/cc/ingest.mjs` - Pure per-session transcript parser (reuses `usage.mjs` + `usage-pricing.mjs`; adds tools/skills/`skill_edited`)
- `src/lib/cc/guard-ingest.mjs` - Parses cc-guard's `~/.claude/cc-guard/audit.jsonl` into per-session guard hits
- `src/lib/cc/transcript.mjs` - Shared parsed-transcript helpers (`parseLines`, `bashCommands`, `toolUses`, `toolResults`, `userPrompts`, `assistantTexts`)
- `src/lib/cc/context.mjs` - Work context per session: git branch/repo, PR, tool-agnostic `ticket_id` + `ticket_source`
- `src/lib/cc/quality.mjs` - Quality score v1 (transparent heuristic, components stored as `quality_detail`)
- `src/lib/cc/summary.mjs` - AI summary engine (`distill` + `summarize` over `claude -p`, injectable exec) and `summarizeSession`
- `src/lib/cc/ingest-run.mjs` - Ingest runner (`ingestAll`, serialised `runIngest`): walks `~/.claude/projects` (+ subagent transcripts), computes context + quality, upserts the store; incremental via `ingest_state` signatures
- `scripts/cc-ingest.mjs` - Thin CLI over `ingest-run.mjs` (`--full`)
- `src/app/api/sessions/ingest/route.js` - `POST` runs the incremental ingest (called by the `/sessions` page on load/Reload and by the refresh cycle)
- `src/lib/cc/codex-ingest.mjs` - Codex rollout parser (`~/.codex/sessions`): sessions, tokens/cost, subagents linked to the root thread via `session_meta`
- `src/lib/cc/summary-view.mjs` - Summary v1/v2 normaliser, display-title priority, `needsSummary` (client-safe, no fs)
- `src/lib/cc/summary-batch.mjs` - Batch summary runner (never rejects; marks job `stopped` on fatal errors), estimate, job state in `summary_jobs`
- `src/lib/cc/session-calendar.mjs` - Pure calendar logic: local-day ranges, event placement, week/month layout, period stats
- `src/app/sessions/calendar-view.js` + `summary-banner.js` - Week/month calendar UI and the "fill in missing summaries" banner
- `src/app/api/sessions/summarize-batch/route.js` (+ `estimate/`) - Start/poll batch job (no stop endpoint), pre-run estimate
- `scripts/cc-import-summaries.mjs` - CLI for the PoC summary import
- `scripts/cc-eval.mjs` - CLI for on-demand AI summaries (`npm run cc:eval -- --summaries`)
- `src/app/api/sessions/route.js` + `summarize/route.js` + `src/app/sessions/page.js` - Session list/detail API, summarize action, and the session viewer
- `src/components/ReorgReportDialog.js` - Reorg report from AI `suggested_path` derivations
- `src/app/api/analyze/route.js` + `status/` - Start/poll the background AI analysis job
- `src/app/api/usage/rebuild/route.js` - Rebuild the usage ledger on demand
- `scripts/prepare-tauri.mjs` - Prepares standalone build for Tauri bundling
- `tailwind.config.js` - Custom color scheme with CSS variables

### Tauri Desktop App

The project includes a Tauri-based desktop app (`src-tauri/`):

- **System tray** - Click to show/hide window, right-click for menu
- **Bundled server** - Next.js standalone output (~19MB DMG)
- **Uses system Node.js** - Not bundled, must be installed
- **Includes .env.local** - Copied during build via `prepare-tauri.mjs`

Key Tauri files:
- `src-tauri/src/lib.rs` - Main Rust code (server startup, tray, window management)
- `src-tauri/tauri.conf.json` - Tauri configuration
- `src-tauri/Cargo.toml` - Rust dependencies

Build process:
1. `npm run build` - Creates Next.js standalone in `.next/standalone/`
2. `prepare-tauri.mjs` - Copies static assets, data, and .env.local
3. `tauri build` - Compiles Rust and bundles into .app/.dmg

### Deno Desktop App (shipped desktop shell)

The shipped desktop shell built with `deno desktop` (Deno 2.9+); Tauri kept as fallback:

- `src-deno/main.ts` - entrypoint (server start, window, hide-on-close)
- `src-deno/server.ts` - runs Next.js standalone in-process on port 3087; writable state in `~/Library/Application Support/StowDashboardDeno`
- `src-deno/tray.ts` - tray menu (Show/Hide/Rescan/Quit)
- Comparison: `docs/deno-vs-tauri.md`, decision: `docs/adr/0002-switch-desktop-shell-to-deno.md` (supersedes 0001)

### Process Monitoring

The dashboard detects running processes and Docker containers for each project:

- Uses `lsof` to find processes with listening ports and their working directories
- Uses `docker ps` with compose labels to detect containers from `docker compose`
- Matches processes/containers to projects by comparing cwd with project directories
- Refresh cycle (opt-in): the toolbar's Auto toggle runs a combined 60s cycle — process detection, project auto-discovery, git refresh (`POST /api/scan/quick`); a manual Refresh button runs the same once. With Auto off, the Running column updates only on manual refresh.
- Git refresh has two tiers. *Active* projects (a running process, or just auto-discovered) get the full `getGitInfo()` commit walk plus a tree-mtime pass. Every **other** project that still has a `.git` on disk gets a cheap working-tree refresh via `src/lib/git-status.mjs` — one `git --no-optional-locks status --porcelain=v2 --branch -u` per repo, 16 at a time — so branch/ahead/behind/uncommitted are current table-wide, not just for what's running. It escalates to the full walk only when `git_info.head_sha` shows HEAD moved (commit counts and remotes can't change while HEAD sits still) or when a directory has newly become a repo. A ledger with no `head_sha` yet counts as "no news", so the first cycle after an upgrade doesn't walk every repo at once. `-u` and the `HEAD` label for a detached checkout exist for parity with the full scan's simple-git call — without them the Uncommitted column would jump depending on which tier last touched the project (cross-checked against simple-git over ~500 real repos). Measured cost on a ~1200-entry ledger (≈500 live repos): 5-6s per cycle end to end.
- Auto-discovery: unmatched process cwds under `SCAN_ROOTS` are walked up to the nearest directory with a project indicator and added to the JSONL automatically (bare directories are skipped; 5-min negative cache); weak-only group directories (just `.git` with sub-projects) are skipped, same as the full scan. Every cycle also runs `assignProjects` (checkout/identity/`project_id`, see Virtual Projects) — cheap once rows have a `checkout`. Full scan remains the only path that removes deleted projects and refreshes scc/size metrics.
- Full scan / Force rescan moved into the ⋯ menu next to the refresh controls.
- Displays process count (green) and container count (blue) in Running column
- Project details sheet shows full process/container info with Kill/Stop buttons
- Process entries have Globe button to open localhost port and Terminal button to attach
- TASKS.md task counts are read live at every page render — a Refresh/reload picks up new tasks, no scan needed

### Script Runner

The project details sheet includes a script runner dropdown (Play button):

- Lists available npm scripts from `package.json` and `.sh` files from project root
- Runs scripts in background via `nohup`, captures output to log files in `/tmp/stow-scripts/`
- Tracks running scripts by PID, polls to detect when they finish
- Attach button opens terminal with `tail -f` on the script's log file
- API: `GET /api/scripts?directory=...`, `POST /api/scripts/run`, `POST /api/scripts/attach`

### Code Stats (scc)

The scanner integrates with [scc](https://github.com/boyter/scc) (Sloc Cloc and Code) for code metrics:

- Runs `scc --by-file -f json` on each project during scanning
- Collects: lines of code, comments, blank lines, complexity, file count per language
- Estimates project value (COCOMO model), schedule, and team size
- Table shows "Lines" and "Value" columns (Value hidden by default)
- Project details sheet shows full code stats breakdown with language list

### AI Project Analysis

The scanner's data is enriched by an on-device AI pass (`npm run analyze`, `src/lib/analyzer.mjs`):

- Runs Apple's on-device model via the `apfel` CLI with `--schema`-guided JSON output (4k context)
- Builds a per-project *distillate* (`distill.mjs`) → categorizes into the `_*` folder taxonomy plus facets: `project_type`, `domain`, `maturity`, `tech`, `reusable_assets`, `doc_score`/`doc_gaps`
- Deterministic derivations happen in Node (not the model): `status` from code activity, `suggested_path`, and a merged `tech` list (`tech-tags.mjs`)
- Incremental via `input_hash` + `ANALYSIS_VERSION` — only changed/stale projects re-run (`analyze-batch.mjs`)
- Language-safe retry, then an **Ollama fallback** (`ollama.mjs`) for unsupported-language / too-large / error cases
- Records gain `ai_analysis` (facets or `{error, error_detail}`) and `ai_derived` (`status`, `tech`, `placement_ok`, `suggested_path`)
- UI: table columns, AI facet filters, an AI Insights panel, and a Reorg report; runs as a background job with poll/resume (`/api/analyze`, `/api/analyze/status`)

### AI Usage Tracking

Per-project AI token cost is derived from local CLI transcripts (`npm run usage`, `src/lib/usage.mjs`):

- Reads Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) transcripts — append-only, so parsing is an incremental tail-parse keyed by size/mtime
- Durable "ghost" ledger entries survive transcript pruning (a deleted transcript stays counted)
- One tokens-only ledger, priced at aggregation time (`usage-pricing.mjs`) from the vendored LiteLLM snapshot — Claude and Codex are priced identically, per model; an unknown model id is surfaced as `unpriced`, never guessed at as $0
- Output is `data/usage.json`, joined to projects at render time — surfaces an AI `$` column and a details-sheet breakdown (list-price value, not an invoice)
- Refreshed in every refresh cycle and on demand via `/api/usage/rebuild`
- After `npm run pricing:sync` (or whenever the `$` figures look off), revalidate against [ccusage](https://github.com/ryoppippi/ccusage) — an independent third-party tool reading the same transcripts — with `node scripts/calibrate-usage.mjs`. It's a hand-run script, not a `node --test` test (it shells out to the `ccusage` binary), and it's read-only: it never rebuilds `data/usage.json`, so run `npm run usage` first if the ledger is stale or missing.
- Known current FAIL (`TRI-STOW-0003`): the gate reports a large Claude drift against ccusage. This is a pre-existing parse bug the calibration script surfaced, **not** a pricing regression — `parseClaudeLines()` does no cross-file dedup, while ccusage dedups assistant messages by `(message.id, requestId)`, so resumed/sidechain transcript rewrites get double-counted. A second, still-unexplained discrepancy sits alongside it: the ledger's token counts match neither the raw transcripts nor a deduplicated pass, suggesting the incremental tail-parse double-counts some regions across re-parses. Codex is separately excluded from the gate until `npm run usage -- --rebuild` re-derives the ledger. Don't read this FAIL as a pricing-snapshot problem, and scope any fix to `usage.mjs` with regression tests.

### Claude Code Session Store (cc observability, phase 1b)

A second, session-centric view of Claude Code usage lives in `data/cc-sessions.db` (`node:sqlite`, built into Node ≥ 24 and Deno — no dependency; verified in the compiled Deno desktop binary, file-backed with WAL). It is a **new** store, not a migration: `projects_metadata.jsonl` and `usage.json` are untouched.

- `npm run cc:ingest` walks `~/.claude/projects/<slug>/<session>.jsonl`, reuses `parseClaudeLines` + `costForClaude` for tokens/cost, and adds a second pass for tool/skill counts and `skill_edited` (an Edit/Write under a skills dir after a Skill call). Subagent transcripts (`<slug>/<session>/subagents/*.jsonl`) are folded into the parent session's tokens/cost/tool counts; turns and timing come from the main transcript. **Incremental**: `ingest_state` keeps a size+mtime signature per session (main + subagent files); unchanged sessions are skipped (guard hits still refreshed), so a run is ~0.1 s when nothing changed vs ~5 s for a `--full` re-parse of ~250 sessions. Idempotent upserts.
- The store is kept fresh automatically: the `/sessions` page POSTs `/api/sessions/ingest` on load and on Reload, and the 60 s refresh cycle (`/api/scan/quick`) runs the same incremental ingest after the usage rebuild (`cc_ingested` event). Concurrent callers share one run.
- cc-guard (separate repo `../cc-guard`) appends `{ts, action, rule, command, session_id, cwd}` lines to `~/.claude/cc-guard/audit.jsonl`; that file is the only contract between the two repos and is ingested as `guard_hits`. Missing audit = zero hits, not an error.
- `GET /api/sessions?project=&project_key=&limit=` lists (`project` matches the main-checkout dir subtree, worktree sessions included, minus sub-dirs owned by another register project; rows carry `project_name` from the register), `?id=` returns `{session, tools, skills, guard_hits}`; `/sessions` renders them. The route opens the DB per request (never at module eval — see State Dir).
- `node:sqlite` still emits an ExperimentalWarning on Node 24, so `npm test` and `cc:ingest` run with `--disable-warning=ExperimentalWarning`.
- **Phase 2 (eval + context)**: every ingest also computes, from the main transcript only:
  - *Work context* (`context.mjs`): `git_branch` (most common non-`HEAD` `gitBranch` value), `git_repo` (first github/gitlab/bitbucket URL seen in Bash commands or tool results), `pr` (from `gh pr` output), and a **tool-agnostic** `ticket_id` + `ticket_source` (`branch` → first `prompt` → `git commit -m` message, first match wins). Default pattern `\b[A-Z]{2,10}(?:-[A-Z]{2,10})?-\d+\b` with a small stoplist (UTF/ISO/RFC/SHA/CVE…); override via `CC_TICKET_PATTERN` in `.env.local` for Linear/YouTrack/`#123`-style ids. Never call it Jira — it's whatever tracker you use.
  - *Quality score* (`quality.mjs`): heuristic 0–100 = verification ran (25, `CC_VERIFY_PATTERN`) + clean finish (25) + tool error rate (25 → 0 at ≥20 %) + no loops (15) + no guard deny/override (10). Components are stored in `quality_detail` and shown in the UI, which labels the number "heuristic".
  - *AI summary* (`summary.mjs`) is **on-demand only** — `npm run cc:eval -- --summaries` or the Generate button → `POST /api/sessions/summarize`. It shells out to the local `claude` CLI with `--no-session-persistence` (mandatory: otherwise each summary writes a transcript that the next ingest indexes), `--tools ""`, no MCP servers, no setting sources and a custom system prompt — ~1k context tokens per summary instead of ~150k for a naive `claude -p` in the repo cwd. `CC_SUMMARY_MODEL` (default `haiku`). With `CC_SUMMARY_HARNESS=codex` it runs `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --output-schema … -o …` in an empty temp dir instead (`--ephemeral` is the loop-breaker there; the instructions lead the prompt since codex has no system-prompt flag; an unset model records the one codex reports). Harness + both models are editable in the Settings dialog; summaries record `harness`. `cc:eval` reads them from `.env.local`; the MCP server only at startup. `upsertSession` never touches `summary*` columns, so re-ingests keep summaries; `setSummary` is the only writer.
- **Session families** (parents, nested subagents, hook-spawned children): every Agent-tool run under `<session>/subagents/` is folded into the parent row (as before) *and* recorded in the `subagents` table (`agent_type` + `description` from the sibling `.meta.json`, model, tokens, cost, active time). Separately, the security-guidance plugin's Stop/SubagentStop hook spawns **its own top-level transcripts** through the Agent SDK (`entrypoint: sdk-py`, first prompt "Review this change for security vulnerabilities…"); nothing on disk names their parent. `session-link.mjs` classifies them (`kind = 'security-review'`, table-driven — add a kind there when another hook starts spawning sessions) and `linkChildren` in `ingest-run.mjs` attaches each to a parent **by timing**: among Claude main sessions running at the child's start (any directory — the reviewer runs in the repo root of the edited files, and the parent may sit in a sibling or ancestor dir), the one whose assistant/tool line came closest before the child (≤ 5 min; a same-directory candidate with a plausible gap wins over a closer one elsewhere). No plausible gap → stays unlinked and is shown as its own row with a badge; unlinked children are retried every run for 24 h (all of them on `--full` or when `ingest_state` is empty, e.g. right after the schema migration). Child rows keep their **own** numbers and nested agents stay folded, so analytics never double-counts; rollups are computed at read time (`session-tree.mjs`). `listSessions` returns top-level rows (the limit applies to those) plus every linked child of them; `GET /api/sessions` adds `agents`, `?id=` adds `agents`, `children`, `parent`. The analytics "sessions" KPI counts top-level sessions only; cost/tokens include children. Verified on ~530 real sessions: all 136 reviews linked, 78 of them across directories; incremental run stays ~0.1 s.
- **Project & workspace (#12)**: three placement columns, written only by `setPlacements` (never by the upsert): `project_key` = the #8 register project id (`git:`/`stow:`/`path:` key from `loadRegistry`, never computed from a path here; no register match → null), `base_dir` = the run dir mapped back onto the main checkout (sub-path kept, e.g. `<repo>/.agent-office/worktrees/x/packages/a` → `<repo>/packages/a`), `workspace` = where it ran as `kind:name` — `agent-office` (`.agent-office/worktrees/<slug>`), `claude-worktree` (`.claude/worktrees/<name>`), `scratchpad` (`/private/tmp/claude-<uid>/<slug>/<uuid>/scratchpad`, slug *matched* against encoded register dirs, longest wins, a tie stays null), `git-worktree` (live dir only: `git rev-parse --git-common-dir` says linked worktree, memoized per process). `project_dir`/`cwd` keep meaning "where it ran" and are never rewritten. Rule order: path rules first (most worktrees are already deleted), git probe only for an existing dir no rule and no register location covers. Run dir = `project_dir` (Codex/Gemini's best guess; Claude's is its cwd), else `cwd`. `runIngest` loads the register and `assignPlacements` recomputes **all** rows after the source loops and before `linkChildren`, writing only changed rows — that is the backfill and it follows register changes within one cycle (~1.4k rows: register load ~70 ms, warm pass ~40 ms, 0 writes). A missing/malformed register only nulls `project_key` (workspace/base_dir still filled); a placement failure is returned as `placement_error` and never fails the ingest. Group/colour by project, analytics top projects and MCP `list_sessions` (`project_key`, `workspace`) key on `project_key || base_dir || project_dir`.
- Remaining nullable `sessions` columns (`machine`, `user`) are reserved for phase 3 (sync); design in `docs/superpowers/specs/2026-08-21-cc-observability-team-design.md` + `2026-08-21-cc-phase2-eval-context-design.md`.

#### Session calendar & batch summaries

- **Sources**: Claude transcripts, `cc-guard` audit, and Codex rollouts (`CC_CODEX_DIR`, default `~/.codex/sessions`, `codex-ingest.mjs`). Codex subagents link to the **root** thread (`session_meta.payload.session_id`, flat families, shown in the parent's rollup). New `sessions` columns `title`/`title_source`/`user_prompts`; `kind` may now be `scheduled`. `effectiveKind` (`session-link.mjs`) resolves to `work|agent-spawn|scheduled|trivial`. Display title priority: `custom` > `summary.title` > `ai` > first prompt.
- **Summary v2**: `{v:2, title, what, outcome: done|partial|abandoned|exploration, improvements (≤5), followups (≤4), kind_hint, model, ms}`; v1 rows stay readable. Titles are never overwritten by summaries.
- **Batch**: `POST /api/sessions/summarize-batch` (+ `estimate/`, range GET). Model `CC_SUMMARY_BATCH_MODEL` (default `claude-sonnet-5-5`), concurrency 3. Job state lives in SQLite `summary_jobs` (cross-process with the MCP server `summarize_sessions`, 60 s stale heartbeat). The runner never rejects and marks the job `stopped` on fatal errors; sessions whose last write is < 10 min old are skipped (10-min rule), and so are sessions whose transcript (`raw_ref`) is gone from disk. Concurrency is clamped to 1..8; a start with nothing to do inserts no job row and returns the latest job with `started: false`. `cc:eval` drives it with a live heartbeat clock. `openStore` sets `PRAGMA busy_timeout = 5000` for file DBs so the web app, CLI and MCP can share the DB. Estimate: `ceil(count/concurrency) x median(ms of last 50)`, fallback 30 s (Sonnet) / 10 s (haiku) per session.
- **Calendar** (`/sessions?view=calendar&span=week|month&date=YYYY-MM-DD`): Table|Calendar toggle, local time, Monday first, max span one month, default shows only `work` (chip reveals agent/scheduled/trivial muted; `scheduled` gets a neutral badge). Placement: `end = ended_at` if span <= 5 h else `start + max(active_s, 30 min)`, min height 15 min. Banner scope = visible events (current period, filters, chip) with no summary at all (v0; `--upgrade` is CLI/MCP only), counted only once the loaded data matches the displayed view/period/project (`loadKey`/`bannerIds`). The page ignores stale load responses (latest request wins). One-off PoC import: `npm run cc:import-summaries`.
- **Color by** (calendar header and above the table — one shared choice via `useColorMode` in `src/app/sessions/color-controls.js`; table rows get an inset colour bar on the first cell; per-viewer in localStorage `stow.calendar.colorBy`, default `outcome`): `COLOR_MODES` / `colorBy` / `colorLegend` in `session-calendar.mjs` — outcome (status colours `--status-*`, always paired with the outcome icon), project (hashed, 6 hues), harness and kind (categorical `--viz-*` in fixed order), cost and quality (one-hue ordinal ramp `--seq-1..4`, defined per theme in `globals.css`). A legend with per-bucket counts under the header says what the colours mean. Palettes were checked with the dataviz validator; outcome's red/green pair relies on the icon for CVD.

### Virtual Projects (register)

A virtual layer over the ledger — **Client → Project → Location** (checkout). Nothing on disk moves. #8 is the model, #9 the scanner wiring; UI, reorg and sessions are #10–#14 (label `virtual-projects`). Specs: `docs/superpowers/specs/2026-10-05-virtual-projects-register-design.md`, `…-checkout-merge-design.md`. The register is a **computed view** (`buildRegistry` over the ledger + `.stow` metas) — nothing about projects/locations is persisted besides the ledger rows and the `.stow` files.

- **Identity**: the first remote that normalises (`normalizeRemote`: credentials, port, `www.`, `.git` dropped, lowercased, proxy prefixes unwrapped; local paths → none) → `git:<host/path>`; else the `id` in `<checkout root>/.stow/project.json` → `stow:<id>`; else `path:<checkout root>` (unstable — only when the file can't be written or writes are opted out).
- **`.stow/project.json`**: `{version: 1, id, client?, role?}`, unknown keys kept, a malformed file is never overwritten. `writeStowMeta` adds an unanchored `.stow/` line to the repo's `info/exclude` (via `git rev-parse --git-path`, injectable exec) so it never shows up as an uncommitted change.
- **Client** chain: manual (`.stow` client) > `ai_analysis.client` > remote top-level owner/group *only if it matches a known client* > `_Bizz/<Client>` path segment. Names fold by `clientKey` (case, punctuation, diacritics, the AI's `new:` prefix). `data/registry.json` (`{clients: [{name, aliases}]}`, via `dataFile`) sets display names and aliases; a malformed file throws.
- **Locations are checkout roots** (#9): `locationOf(row)` = `row.checkout.root` (git toplevel; linked worktrees and submodules have their own; a linked worktree also records `checkout.main`, its main work tree) or the row's own directory. Rows inside one checkout are its *members* (`location.members` = count), not copies — btstack's 49 rows are one location; a weak-only root with no row of its own (eranet3-analyza) is still one location (`record_id: null`). `.stow` metas are read at the root, once. **Identity is decided once per checkout** (`checkoutIdentities`): the root row's remote, else the shallowest member's, else the `.stow` id at the *stow home* (`stowHomeOf` — the main work tree for a linked worktree, so all worktrees of a no-remote repo share one id), else `path:<root>` — members with stale or missing `git_info.remotes` can't split a checkout.
- **Scanner (#9)**: `ProjectScanner#assignProjects` runs after every full scan over **all** rows (cached ones too, so a pre-#9 ledger is backfilled on the first scan) and in every quick-refresh cycle (so `project_id` follows a remote added between full scans). Every row gets three top-level fields — kept out of `git_info` because the refresh cycle replaces `git_info` wholesale: `checkout: {root, subpath, git}` (resolved once; only rows without it cost a git spawn, 16 concurrent), `identity: {key, kind}` and `project_id` (= the register key, what #10/#12 join on). Both are recomputed every assign, so they track `git_info.remotes`.
- **`.stow/project.json` writes**: only at stow homes of checkouts with no normalisable remote, and only if the home still exists (a stale row's vanished folder is never recreated — it keeps its stored id); only when missing (an existing file — user-edited or malformed — is never rewritten); `.stow/` goes into the repo's `info/exclude` (no +1 in Uncommitted; the full scan re-asserts it for dirty no-remote repos, e.g. after a later `git init`), `.stow` is in `DEFAULT_IGNORE_PATTERNS` (no `last_modified` bump, so no re-extraction) and filtered from the AI distillate's top-level listing (no `input_hash` change, so no AI re-run). `STOW_WRITE_PROJECT_FILES=0` → read-only; failures (EACCES) become a `stow_file_error` event and a `path:` identity, never a failed scan.
- **Moves**: a moved/renamed folder keeps its key (the `.stow` id or remote travels with it), so its location, manual role and client follow without any register edit. Ledger rows are keyed by directory, so `carryForwardMoved` gives a row without analysis the `ai_analysis`/`ai_derived` of a vanished prior row (not scanned, or still listed but gone from disk — the quick refresh keeps stale rows) with the same identity + checkout subpath (each donor once; emits `moved`). A `cp -r` of a no-remote folder shares the id → two locations of one project.
- **Roles** `primary | deploy | experiment | stale`: manual wins; otherwise primary = most recently active (tie → shortest path); others `stale` by name token (`old|backup|bak|archive`) or > 180 days idle, `deploy` by token (`prod|production|deploy|live`), else `experiment`.
- **Agent Office export (#14)**: `npm run registry:export` writes `data/agent-office.json` (`{format: "stow-dashboard/agent-office", version: 1, generated_at, filter: {client, unassigned}, buildings, skipped, stats}`); `GET /api/registry/agent-office` serves the same document without writing. Building = register client (`id` = `clientKey`), floor = register project: `id` = `<slug(name)>-<6 hex of sha1(project_key)>` (`^[a-z0-9-]{1,40}$`, stable across moves), `dir` = the primary checkout, `repo` = `owner/name` for github.com remotes only (else `null`), `remote` = #8's normalised remote (never `git_info.remotes`), `last_activity` (ISO), `locations` `{dir, role}` primary first. Worktrees are never floors or locations: `.agent-office/worktrees/*`, `.claude/worktrees/*` and linked git worktrees (ledger `checkout.main` ≠ `checkout.root`) are dropped, as are directories gone from disk; a dropped primary falls back to its own main checkout (ledger `checkout.main`, or the path in front of the worktrees dir — the busy-worker case, where the main sits idle as `stale`), then to the most recently active remaining checkout, a project with none left goes to `skipped` (`no-location`). Floors sort by `last_activity` desc; no truncation (agent-office caps 16 floors per building). Unassigned projects only with `--unassigned` / `?unassigned=1`; `--client` matches by `clientKey`, a typo exits 1 / 404; the CLI's `--client` implies `--stdout`, so a one-client subset never replaces the full file. Refreshed only on demand — neither the scan nor the refresh cycle writes it.

### Quick Filters

The table includes 3-state toggle filters (any → yes → no → any):
- Running, Has Git, Has Remote, Uncommitted, Behind, Ahead, Own Commits, Has README

### MCP Server

The project includes an MCP server (`src/mcp/server.mjs`) that exposes project data to AI assistants:

```bash
npm run mcp  # Start MCP server on stdio
```

Tools (23):
- `search_projects` (supports AI facet params: `category`, `type`, `domain`, `tech`, `maturity`, `misplaced`), `get_project_details` (includes `ai` + `aiUsage`), `get_project_readme`, `open_project`
- `list_dirty_projects`, `get_project_stats`, `list_recent_projects`
- `list_running_projects`, `get_project_processes`, `stop_process`
- `get_status`, `set_status`, `list_scripts`, `run_script`
- `list_tasks`, `add_task`, `verify_task`, `completed_tasks`, `dispatch_task`, `generate_changelog`
- `find_reusable_assets` — search AI-discovered harvestable building blocks across all projects
- `list_sessions` (period + kind filter, rollup numbers, summary, `project_key` + `workspace`), `summarize_sessions` (background batch, cross-process job state; `status_only: true` only reports the latest job + missing count, and a call with nothing missing reports the latest job instead of starting one)

## Data Requirements

### State Dir (where data/ and .env.local actually live)

All writable state — `data/projects_metadata.jsonl`, `data/usage.json`, `data/usage-cache.json`, `data/run-logs/`, `.env.local` — lives in one *state dir*, resolved by `src/lib/state-dir.mjs`. **Never build these paths by hand** (`path.join(process.cwd(), 'data', …)` or module-relative): the desktop app can't write inside its own bundle, so it keeps state in `~/Library/Application Support/StowDashboardDeno`, and hand-rolled paths are how the web app, the CLIs and the MCP server ended up reading two different ledgers.

Resolution order (`resolveStateDir({ base })`):
1. `STOW_STATE_DIR` — explicit override; the Deno shell sets it, and `STOW_STATE_DIR=. npm run scan` forces repo-local state.
2. The desktop app-data dir, if it already holds a scanned ledger.
3. `base` — `process.cwd()` inside the Next server (the default), the repo root for CLIs and the MCP server (they run with an arbitrary cwd, so they must pass it).

Use `ledgerFile()`, `dataFile(name)`, `dataDir()`, `envFile()` — and call them at request/call time, not at module eval, since the compiled desktop app preloads route modules once at boot (same reason as `scan-roots.mjs`).

The app expects `data/projects_metadata.jsonl` to exist. Each line is a JSON object with project metadata including:
- `directory`, `project_name`, `description`
- `stack` (array of technologies)
- `git_info` (remotes, commits, branch, ahead, behind, is_clean, uncommitted_changes, etc.)
- `file_types`
- `content_size_bytes` (size of your code without libraries)
- `libs_size_bytes` (size of node_modules, venv, etc.)
- `total_size_bytes` (total directory size)
- `scc` (code stats: `total_code`, `total_comment`, `total_blank`, `total_lines`, `total_complexity`, `total_files`, `estimated_cost`, `estimated_schedule_months`, `estimated_people`, `languages[]`)
- `ai_analysis` / `ai_derived` (optional, added by `npm run analyze` — see AI Project Analysis)

The AI usage ledger lives alongside as `data/usage.json` (+ its `data/usage-cache.json`). Both are gitignored and written only by `npm run usage` / the refresh cycle — the scanner never touches them.

### Project Detection

The scanner identifies a directory as a project if it contains at least one of these indicator files:
- **Strong indicators**: `package.json`, `requirements.txt`, `pyproject.toml`, `composer.json`, `build.gradle`, `pom.xml`, `README.md`
- **Weak indicators**: `.git`

When a directory with sub-projects has only weak indicators (just `.git`), it's treated as a group and skipped — only sub-projects are indexed. Directories with strong indicators are always indexed, and their sub-projects are also indexed separately.

## Hydration Notes

TimeAgo components use `useEffect` to prevent SSR/client hydration mismatches - the server renders a placeholder and client updates with actual relative time.

## Command Center

This project participates in the Command Center. Maintain `STATUS.md` via the `status-keeper`
skill: read `NEXT:` at the start of a session to resume, and update it (one next step) when
pausing or ending. `skills.manifest.json` declares the shared skills wired into `.claude/skills/`
(mode: symlink). The plan set lives in `docs/superpowers/plans/`.
