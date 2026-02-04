# Stow Dashboard

A modern web dashboard for visualizing and managing your local development projects. Automatically scans directories, extracts metadata, and provides an interactive overview of all your projects.

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

## Tech Stack

- **Framework:** [Next.js 16](https://nextjs.org/) with App Router
- **UI:** [shadcn/ui](https://ui.shadcn.com/) + [Tailwind CSS](https://tailwindcss.com/)
- **Table:** [@tanstack/react-table](https://tanstack.com/table)
- **Icons:** [Lucide React](https://lucide.dev/)

## Getting Started

### Prerequisites

- Node.js 20.9 or higher
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/stow-dashboard.git
   cd stow-dashboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure scan directories in `.env.local`:
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your directories
   ```

   ```env
   SCAN_ROOTS=/Users/you/projects,/Users/you/work
   BASE_DIR=/Users/you/projects
   ```

4. Run the initial scan:
   ```bash
   npm run scan
   ```

5. Start the dashboard:
   ```bash
   npm run tray   # Production mode, opens browser automatically
   # or
   npm run dev    # Development mode with hot reload
   ```

6. Open [http://localhost:3088/dashboard](http://localhost:3088/dashboard)

## Scripts

```bash
npm run tray       # Start production server on port 3088, opens browser
npm run dev        # Start development server on port 3088
npm run build      # Build for production
npm run start      # Start production server on port 3088
npm run scan       # Scan projects and generate metadata
npm run scan:force # Force rescan all projects
npm run mcp        # Start MCP server for AI assistants
npm run lint       # Run ESLint
```

The default port is `3088` to avoid conflicts with other projects. Customize via `STOW_PORT` env variable.

## Scanner

The built-in scanner detects projects by looking for:
- `package.json` (Node.js)
- `requirements.txt` / `pyproject.toml` (Python)
- `composer.json` (PHP)
- `build.gradle` / `pom.xml` (Java)
- `.git` directory

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
node scripts/scan.mjs -s data/projects_metadata.jsonl

# Override scan roots
node scripts/scan.mjs -r ~/projects ~/work -s data/projects_metadata.jsonl

# Force update all metadata
node scripts/scan.mjs -f -s data/projects_metadata.jsonl

# Clean up .project_meta.json files
node scripts/scan.mjs --cleanup
```

### API

```bash
# Trigger scan via API
curl -X POST http://localhost:3000/api/scan

# Force scan
curl -X POST http://localhost:3000/api/scan -H "Content-Type: application/json" -d '{"force": true}'
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
│   └── dashboard/            # Main dashboard page
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
scripts/
└── scan.mjs                  # CLI scanner script
data/
└── projects_metadata.jsonl   # Generated metadata (gitignored)
```

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

| Variable | Description | Default |
|----------|-------------|---------|
| `SCAN_ROOTS` | Comma-separated directories to scan | - |
| `BASE_DIR` | Base path for relative directory display | - |
| `TERMINAL_APP` | Terminal app for "Open in Terminal" | `Terminal` |
| `IDE_COMMAND` | IDE command for "Open in IDE" | `code` |
| `STOW_PORT` | Server port | `3088` |

## Roadmap

- [ ] Windows support for process monitoring (currently macOS/Linux only)
- [ ] Start/restart projects from dashboard
- [ ] Project notes and tags
- [ ] Notifications for git changes

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
