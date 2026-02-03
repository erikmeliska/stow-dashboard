# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stow Dashboard is a Next.js 16 web application (React 19) that visualizes projects scanned by `stow-agent`. It displays project metadata, Git information, file statistics, and technology stack detection from a JSONL data file.

## Commands

```bash
npm run dev      # Start dev server with Turbopack (port 3000)
npm run build    # Build for production
npm run start    # Start production server
npm run lint     # Run ESLint
```

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
node scripts/scan.mjs --cleanup                  # Delete all .project_meta.json files
```

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
app/dashboard/page.js [Server Component - async data loading]
    ↓
app/dashboard/project-table.js [Client Component - interactive table]
    ↓
TanStack React Table (sorting, filtering, pagination)
```

### Server vs Client Components

- **Server Components**: `app/dashboard/page.js` reads JSONL at request time, `app/layout.js`
- **Client Components**: `project-table.js` (marked with `'use client'`), `app/dashboard/layout.js`

### Key Patterns

- **UI Components**: shadcn/ui components in `src/components/ui/` (copy-paste model, not npm-installed)
- **State Management**: React Context API defined in `app/context/ProjectContext.js`
- **Styling**: Tailwind CSS with CSS variables for theming, dark mode via `dark:` classes
- **Path Alias**: `@/*` maps to `./src/*`

### Important Files

- `src/app/dashboard/project-table.js` - Main interactive table with all filtering/sorting logic
- `src/lib/projects.js` - JSONL parsing and data loading
- `src/lib/utils.js` - Utility functions (cn, formatTimeAgo, getGitProvider)
- `src/scanner/index.mjs` - Project scanner (Node.js port of stow-agent)
- `scripts/scan.mjs` - CLI for running the scanner
- `tailwind.config.js` - Custom color scheme with CSS variables

## Data Requirements

The app expects `data/projects_metadata.jsonl` to exist. Each line is a JSON object with project metadata including:
- `directory`, `project_name`, `description`
- `stack` (array of technologies)
- `git_info` (remotes, commits, branch, etc.)
- `file_types`
- `content_size_bytes` (size of your code without libraries)
- `libs_size_bytes` (size of node_modules, venv, etc.)
- `total_size_bytes` (total directory size)

## Hydration Notes

TimeAgo components use `useEffect` to prevent SSR/client hydration mismatches - the server renders a placeholder and client updates with actual relative time.
