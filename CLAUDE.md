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
npm run deno:run      # Compile + launch dist/Stow Dashboard Deno.app
npm run deno:build    # Build dist/Stow Dashboard Deno.app
# Install/update: ditto "dist/Stow Dashboard Deno.app" "/Applications/Stow Dashboard Deno.app"

# Desktop App (Tauri — fallback shell, requires Rust)
npm run tauri:build  # Build native macOS app + DMG
npm run tauri:dev    # Run desktop app in dev mode

# AI Analysis & Usage
npm run analyze      # AI project analysis batch (incremental; --force, --retry-errors, --pilot, --data <file>)
npm run usage        # Rebuild the AI usage/cost ledger from CLI transcripts (--rebuild re-parses from zero)
npm run pricing:sync # Refresh src/lib/pricing-data.json (the vendored LiteLLM snapshot) from LiteLLM upstream
node scripts/calibrate-usage.mjs  # Cross-check usage.json's cost against ccusage (hand-run, not npm test — needs ccusage installed)

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
- `scripts/scan.mjs` - CLI for running the scanner
- `scripts/analyze.mjs` - CLI for the AI analysis batch
- `scripts/usage.mjs` - CLI for rebuilding the usage ledger
- `scripts/calibrate-usage.mjs` - Hand-run cross-check of `data/usage.json` cost against `ccusage` (read-only, not part of `npm test`)
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
- Refresh cycle (opt-in): the toolbar's Auto toggle runs a combined 60s cycle — process detection, project auto-discovery, git refresh of active projects (`POST /api/scan/quick`); a manual Refresh button runs the same once. With Auto off, the Running column updates only on manual refresh.
- Auto-discovery: unmatched process cwds under `SCAN_ROOTS` are walked up to the nearest directory with a project indicator and added to the JSONL automatically (bare directories are skipped; 5-min negative cache); weak-only group directories (just `.git` with sub-projects) are skipped, same as the full scan. Full scan remains the only path that removes deleted projects and refreshes scc/size metrics.
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

### Quick Filters

The table includes 3-state toggle filters (any → yes → no → any):
- Running, Has Git, Has Remote, Uncommitted, Behind, Ahead, Own Commits, Has README

### MCP Server

The project includes an MCP server (`src/mcp/server.mjs`) that exposes project data to AI assistants:

```bash
npm run mcp  # Start MCP server on stdio
```

Tools (21):
- `search_projects` (supports AI facet params: `category`, `type`, `domain`, `tech`, `maturity`, `misplaced`), `get_project_details` (includes `ai` + `aiUsage`), `get_project_readme`, `open_project`
- `list_dirty_projects`, `get_project_stats`, `list_recent_projects`
- `list_running_projects`, `get_project_processes`, `stop_process`
- `get_status`, `set_status`, `list_scripts`, `run_script`
- `list_tasks`, `add_task`, `verify_task`, `completed_tasks`, `dispatch_task`, `generate_changelog`
- `find_reusable_assets` — search AI-discovered harvestable building blocks across all projects

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
