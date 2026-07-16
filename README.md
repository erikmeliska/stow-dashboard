# Stow Dashboard

A modern web dashboard for visualizing and managing your local development projects. Automatically scans directories, extracts metadata, and provides an interactive overview of all your projects.

Available as a **web app** or **native desktop app** (macOS).

## Features

- **Interactive Project Table** - Sortable, filterable, paginated table powered by TanStack Table
- **Group Filter** - Multi-select filter by folder groups with dynamic counts
- **Quick Filters** - 3-state toggle filters (any/yes/no) for Running, Git, Uncommitted, Behind, etc.
- **Process Monitoring** - Detect running processes and Docker containers for each project
- **Docker Integration** - See running containers from `docker compose`, with stop/restart controls
- **Git Sync Status** - See uncommitted changes, ahead/behind indicators at a glance
- **Project Details Panel** - Side sheet with comprehensive project info, live git status, and process info
- **Quick Actions** - Open projects in IDE, Terminal, or Finder with one click
- **Built-in Scanner** - Node.js project scanner with real-time progress (no external dependencies)
- **Git Integration** - Automatic detection of repositories (GitHub, GitLab, Bitbucket), commit counts, and contribution stats
- **Smart Search** - Global filter across project names, paths, stack, and Git remotes
- **Stack Detection** - Extracts technologies from package.json, requirements.txt, etc.
- **Size Metrics** - Shows code size vs total size (including node_modules, venv, etc.)
- **README Viewer** - View project README files directly in the dashboard
- **MCP Server** - Expose project data to AI assistants (Claude Desktop, Claude Code)
- **Persistent Settings** - Remembers your sort order, visible columns, and page size
- **Dark Mode** - Full dark mode support
- **Desktop App** - Native macOS app with system tray (Deno; Tauri kept as fallback)

## Tech Stack

- **Framework:** [Next.js 16](https://nextjs.org/) with App Router
- **UI:** [shadcn/ui](https://ui.shadcn.com/) + [Tailwind CSS](https://tailwindcss.com/)
- **Table:** [@tanstack/react-table](https://tanstack.com/table)
- **Icons:** [Lucide React](https://lucide.dev/)
- **Desktop:** [`deno desktop`](https://docs.deno.com/runtime/desktop/) (Deno 2.9+, shipped shell) — [Tauri 2](https://tauri.app/) kept as fallback

## Getting Started

### Prerequisites

- **Node.js 20.9+** — web app, scanner, CLI, MCP server
- **Deno 2.9+** — only for the desktop app ([install](https://docs.deno.com/runtime/getting_started/installation/)); `deno desktop` needs 2.9 or newer
- **Rust** — only if you build the Tauri fallback shell ([install](https://rustup.rs/))

### First run

1. Clone and install:
   ```bash
   git clone https://github.com/erikmeliska/stow-dashboard.git
   cd stow-dashboard
   npm install
   ```

2. Configure `.env.local` — at minimum tell it where your projects live:
   ```bash
   cp .env.example .env.local
   ```

   ```env
   SCAN_ROOTS=/Users/you/projects,/Users/you/work   # comma-separated, what gets scanned
   BASE_DIR=/Users/you/projects                     # trims this prefix in the UI
   IDE_COMMANDS=code,cursor,zed                     # first = default
   TERMINAL_APPS=Terminal,Warp                      # first = default
   ```

3. Scan your projects — this builds the ledger everything else reads:
   ```bash
   npm run scan          # ~1000 projects takes a few minutes; repeat runs are ~8x faster
   ```

4. Start it:
   ```bash
   npm run dev           # http://localhost:3089
   ```

That's a working dashboard. For the desktop app, keep going below.

### Running the dashboard

| | Command | URL |
|---|---|---|
| **Dev** (hot reload) | `npm run dev` | http://localhost:3089 |
| **Web production** | `npm run build && npm run start` | http://localhost:3088 |
| **Desktop app** | see below | its own window |

Dev and production use different ports on purpose, so you can run both at once.

### Desktop app (macOS)

The shipped desktop shell is built with `deno desktop` — a real macOS `.app`
with a system tray, running the Next.js server in-process under Deno's Node
compatibility layer. You need **Deno 2.9+** to *build* it; the finished app
bundles its own server, so it doesn't need Node installed to run. Tauri is kept
as a fallback shell; see [ADR 0002](docs/adr/0002-switch-desktop-shell-to-deno.md).

**Build and install:**

```bash
npm run deno:build     # Next build + assemble bundle + compile the .app
ditto "dist/Stow Dashboard Deno.app" "/Applications/Stow Dashboard Deno.app"
open "/Applications/Stow Dashboard Deno.app"
```

Use `ditto`, not `cp` — it preserves the bundle's structure and signature.
Re-run the same commands to update an existing install; your scanned data and
settings live outside the bundle and survive (see below).

**Iterating on it:**

```bash
npm run deno:prepare   # rebuild only the bundled server (after code changes)
npm run deno:run       # compile + open the app, skipping the prepare step
```

`deno:run` does *not* rebuild the bundle, so on a fresh clone it fails —
`src-deno/standalone/` is gitignored and only `deno:prepare` (or `deno:build`,
which includes it) creates it. Use `deno:build` the first time.

**What to expect:**
- Tray icon: click to show/hide the window, right-click for Show/Hide/Rescan/Quit
- On first launch it copies `data/` and `.env.local` out of the bundle into
  `~/Library/Application Support/StowDashboardDeno` and works there from then on
  — which is why step 3 above (`npm run scan`) is worth doing before you build.
  Later rebuilds never overwrite that state; the app owns it.
- It picks its own port at runtime rather than the requested 3087 — a
  `deno desktop` behaviour, not a bug. The window finds it automatically.

## Scripts

```bash
# Development
npm run dev           # Start dev server on port 3089

# Web Production
npm run build         # Build Next.js for production
npm run start         # Start production server on port 3088
npm run start:bg      # Start production server in background

# Desktop App (Deno — the shipped shell, needs Deno 2.9+)
npm run deno:build    # Build dist/Stow Dashboard Deno.app (includes deno:prepare)
npm run deno:prepare  # Rebuild the bundled Next.js server only
npm run deno:run      # Compile + open the app (skips prepare)

# Desktop App (Tauri — fallback shell, needs Rust)
npm run tauri:build   # Build native macOS app + DMG
npm run tauri:dev     # Run desktop app in dev mode

# Scanner
npm run scan          # Scan projects and generate metadata
npm run scan:force    # Force rescan all projects

# AI analysis & usage
npm run analyze       # AI project analysis batch (incremental)
npm run usage         # Rebuild the AI usage/cost ledger from CLI transcripts

# Other
npm run mcp           # Start MCP server for AI assistants
npm test              # Run tests (node --test)
npm run lint          # Run ESLint
```

**Ports:** Dev uses `3089`, web production and Tauri use `3088`. The Deno app
requests `3087` but binds a runtime-assigned port instead (see Desktop app above).

## Scanner

The built-in scanner detects projects by looking for:
- `package.json` (Node.js)
- `requirements.txt` / `pyproject.toml` (Python)
- `composer.json` (PHP)
- `build.gradle` / `pom.xml` (Java)
- `.git` directory
- `README.md` file

**Multi-project support:** Directories with only `.git` (weak indicator) and sub-projects are treated as groups — only their sub-projects are indexed. Directories with strong indicators (`package.json`, `README.md`, etc.) are always indexed, and their sub-projects are also indexed separately.

For each project, it extracts:
- Project name and description
- Technology stack (dependencies)
- File type distribution
- Size breakdown (code vs libraries)
- Git information (commits, branches, remotes)
- Last modified timestamps

### CLI Usage

```bash
# Scan using SCAN_ROOTS from .env.local
node scripts/scan.mjs -s

# Override scan roots
node scripts/scan.mjs -r ~/projects ~/work -s

# Force update all metadata
node scripts/scan.mjs -f -s

# Clean up .project_meta.json files
node scripts/scan.mjs --cleanup
```

`-s` writes to the active state dir's ledger — the desktop app's app-data dir
when it holds one, else this repo's `data/`. Pass `STOW_STATE_DIR=.` to force
repo-local state, or `-s <path>` for an explicit file.

### API

```bash
# Trigger scan via API
curl -X POST http://localhost:3088/api/scan

# Force scan
curl -X POST http://localhost:3088/api/scan -H "Content-Type: application/json" -d '{"force": true}'
```

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── open-with/        # Open in IDE/Terminal/Finder API
│   │   ├── processes/        # Process & Docker monitoring API
│   │   │   ├── route.js      # GET running processes/containers
│   │   │   ├── docker/       # Docker container operations
│   │   │   └── kill/         # Kill process by PID
│   │   ├── project-details/  # Live git status API
│   │   ├── readme/           # README fetcher API
│   │   └── scan/             # Scanner API with SSE progress
│   ├── page.js               # Main dashboard page
│   └── project-table.js      # Interactive project table
├── components/
│   ├── ui/                   # shadcn/ui components
│   ├── ProjectDetailsSheet.js # Project details side panel
│   ├── ReadmeDialog.js       # README viewer
│   └── ScanControls.js       # Scan buttons with progress
├── hooks/
│   └── useProcesses.js       # Process monitoring hook
├── mcp/
│   └── server.mjs            # MCP server for AI assistants
├── scanner/                  # Project scanner module
└── lib/                      # Utilities
src-deno/                     # Deno desktop app (shipped shell)
├── main.ts                   # Entrypoint (server start, window, tray)
├── server.ts                 # Runs Next.js standalone in-process
├── tray.ts                   # Tray menu
└── standalone/               # Assembled bundle (gitignored, built by deno:prepare)
src-tauri/                    # Tauri desktop app (Rust, fallback shell)
├── src/lib.rs                # Main app logic
├── tauri.conf.json           # Tauri configuration
└── icons/                    # App icons
scripts/
├── cli.mjs                   # CLI tool (stow command)
├── scan.mjs                  # CLI scanner script
├── prepare-deno.mjs          # Prepare standalone for Deno
└── prepare-tauri.mjs         # Prepare standalone for Tauri
data/
└── projects_metadata.jsonl   # Generated metadata (gitignored)
```

Writable state (`data/`, `.env.local`) lives in a *state dir* resolved by
`src/lib/state-dir.mjs` — this repo when you run it from here, or
`~/Library/Application Support/StowDashboardDeno` once the desktop app has
scanned. `STOW_STATE_DIR` overrides it. Resolve paths through that module
rather than building them from `process.cwd()`, so the web app, desktop app,
CLIs and MCP server all share one ledger.

## CLI

Stow includes a terminal CLI for quick access to project data without opening the dashboard.

### Install globally

```bash
npm link    # makes `stow` available from any terminal
```

### Usage

```bash
# List projects (default: 20 most recently modified)
stow                 # Top 20 projects
stow --all           # All projects
stow --limit 50      # Top 50

# Filters
stow --running       # Show projects with running processes/containers
stow --dirty         # Show projects with uncommitted changes
stow --behind        # Show projects behind remote
stow --ahead         # Show projects ahead of remote
stow --no-git        # Show projects without Git
stow --search next   # Search by name, path, or stack
stow --stats         # Show summary statistics

# Scanning
stow scan            # Full scan of all project directories
stow scan -f         # Force rescan all projects
stow quickscan       # Refresh git info for running projects only
```

Directories are clickable (OSC 8 terminal hyperlinks) — click to open in Finder.

No server needed — reads the state dir's `data/projects_metadata.jsonl` directly (see Project Structure) and detects processes via `lsof`.

## MCP Server

Stow Dashboard includes an MCP (Model Context Protocol) server that allows AI assistants like Claude to access your project data.

### Available Tools

| Tool | Description |
|------|-------------|
| `search_projects` | Search projects by name, stack, or group |
| `get_project_details` | Get detailed info including live git status and running processes |
| `get_project_readme` | Read project README file |
| `open_project` | Open project in IDE, Terminal, or Finder |
| `list_dirty_projects` | List projects with uncommitted changes or behind remote |
| `get_project_stats` | Get aggregate statistics about all projects |
| `list_recent_projects` | List most recently modified projects (default: 10) |
| `list_running_projects` | List all projects with running processes or Docker containers |
| `get_project_processes` | Get running processes and Docker containers for a project |
| `stop_process` | Stop a process by PID or Docker container by ID |

### Setup for Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stow-dashboard": {
      "command": "node",
      "args": ["/path/to/stow-dashboard/src/mcp/server.mjs"]
    }
  }
}
```

### Setup for Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "stow-dashboard": {
      "command": "node",
      "args": ["/path/to/stow-dashboard/src/mcp/server.mjs"]
    }
  }
}
```

### Test MCP Server

```bash
npm run mcp
```

## Configuration

### Environment Variables

Set these in `.env.local` (the desktop app edits its own copy — see below):

| Variable | Description | Default |
|----------|-------------|---------|
| `SCAN_ROOTS` | Comma-separated directories to scan | `~/Projekty` |
| `BASE_DIR` | Base path for relative directory display | `~/Projekty` |
| `IDE_COMMANDS` | Comma-separated IDE commands, first = default (legacy `IDE_COMMAND` still honored) | `code` |
| `TERMINAL_APPS` | Comma-separated terminal apps, first = default (legacy `TERMINAL_APP` still honored) | `Terminal` |
| `OLLAMA_URL` | Ollama endpoint for the AI-analysis fallback | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama model for the fallback | `llama3` |

`STOW_STATE_DIR` is set in the *process env*, not `.env.local` — it decides
which `.env.local` gets read in the first place. It overrides where `data/` and
`.env.local` live (see Project Structure); e.g. `STOW_STATE_DIR=. npm run scan`
forces repo-local state instead of the desktop app's.

## Roadmap

- [ ] Windows support for process monitoring (currently macOS/Linux only)
- [ ] Windows/Linux Tauri builds
- [ ] Start/restart projects from dashboard
- [ ] Project notes and tags
- [ ] Notifications for git changes

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
