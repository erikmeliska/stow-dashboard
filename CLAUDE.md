# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stow Dashboard is a Next.js 16 web application (React 19) that visualizes projects scanned by `stow-agent`. It displays project metadata, Git information, file statistics, and technology stack detection from a JSONL data file.

Available as a web app or native desktop app (Tauri).

## Commands

```bash
# Development
npm run dev          # Start dev server with Turbopack (port 3089)

# Web Production
npm run build        # Build for production
npm run start        # Start production server (port 3088)

# Desktop App (requires Rust)
npm run tauri:build  # Build native macOS app + DMG
npm run tauri:dev    # Run desktop app in dev mode

# Other
npm run lint         # Run ESLint
```

**Ports:** Dev uses `3089`, Production/Tauri uses `3088` (so they don't conflict).

Next.js 16 uses Turbopack by default and separates dev/build outputs (`.next/dev` vs `.next/build`), so `npm run build` won't interfere with a running dev server.

No test framework is currently configured.

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

API endpoint: `POST /api/scan` with optional `{ force: true }` or `{ cleanup: true }`

### Environment Variables

Configure in `.env.local`:
```bash
SCAN_ROOTS=/Users/ericsko/Projekty,/Users/ericsko/Work  # Comma-separated
BASE_DIR=/Users/ericsko/Projekty                         # For relative paths in UI
TERMINAL_APP=Terminal                                    # Terminal app (Terminal, Warp, iTerm, etc.)
IDE_COMMAND=code                                         # IDE command (code, cursor, zed, etc.)
```

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
- `src/app/api/open-with/route.js` - API for opening projects in IDE/Terminal/Finder
- `src/app/api/project-details/route.js` - API for live git status
- `src/app/api/processes/route.js` - API for detecting running processes and Docker containers
- `src/app/api/processes/docker/route.js` - API for Docker container operations (stop, restart, kill)
- `src/app/api/processes/kill/route.js` - API for killing processes
- `src/hooks/useProcesses.js` - Hook for process monitoring with polling
- `src/mcp/server.mjs` - Standalone MCP server for AI assistants
- `src/lib/projects.js` - JSONL parsing and data loading
- `src/lib/utils.js` - Utility functions (cn, formatTimeAgo, getGitProvider)
- `src/scanner/index.mjs` - Project scanner (Node.js port of stow-agent)
- `scripts/scan.mjs` - CLI for running the scanner
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

### Process Monitoring

The dashboard detects running processes and Docker containers for each project:

- Uses `lsof` to find processes with listening ports and their working directories
- Uses `docker ps` with compose labels to detect containers from `docker compose`
- Matches processes/containers to projects by comparing cwd with project directories
- Polls every 30 seconds for updates
- Displays process count (green) and container count (blue) in Running column
- Project details sheet shows full process/container info with Kill/Stop buttons

### Quick Filters

The table includes 3-state toggle filters (any → yes → no → any):
- Running, Has Git, Has Remote, Uncommitted, Behind, Ahead, Own Commits, Has README

### MCP Server

The project includes an MCP server (`src/mcp/server.mjs`) that exposes project data to AI assistants:

```bash
npm run mcp  # Start MCP server on stdio
```

Tools:
- `search_projects`, `get_project_details`, `get_project_readme`, `open_project`
- `list_dirty_projects`, `get_project_stats`, `list_recent_projects`
- `list_running_projects`, `get_project_processes`, `stop_process`

## Data Requirements

The app expects `data/projects_metadata.jsonl` to exist. Each line is a JSON object with project metadata including:
- `directory`, `project_name`, `description`
- `stack` (array of technologies)
- `git_info` (remotes, commits, branch, ahead, behind, is_clean, uncommitted_changes, etc.)
- `file_types`
- `content_size_bytes` (size of your code without libraries)
- `libs_size_bytes` (size of node_modules, venv, etc.)
- `total_size_bytes` (total directory size)

### Project Detection

The scanner identifies a directory as a project if it contains at least one of these indicator files:
- **Strong indicators**: `package.json`, `requirements.txt`, `pyproject.toml`, `composer.json`, `build.gradle`, `pom.xml`, `README.md`
- **Weak indicators**: `.git`

When a directory with sub-projects has only weak indicators (just `.git`), it's treated as a group and skipped — only sub-projects are indexed. Directories with strong indicators are always indexed, and their sub-projects are also indexed separately.

## Hydration Notes

TimeAgo components use `useEffect` to prevent SSR/client hydration mismatches - the server renders a placeholder and client updates with actual relative time.
