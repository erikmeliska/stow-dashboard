# Stow Dashboard

A modern web dashboard for visualizing and managing your local development projects. Automatically scans directories, extracts metadata, and provides an interactive overview of all your projects.

## Features

- **Interactive Project Table** - Sortable, filterable, paginated table powered by TanStack Table
- **Built-in Scanner** - Node.js project scanner (no external dependencies required)
- **Git Integration** - Automatic detection of repositories (GitHub, GitLab, Bitbucket), commit counts, and contribution stats
- **Smart Search** - Global filter across project names, paths, and Git remotes
- **Stack Detection** - Extracts technologies from package.json, requirements.txt, etc.
- **Size Metrics** - Shows code size vs total size (including node_modules, venv, etc.)
- **README Viewer** - View project README files directly in the dashboard
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

5. Start the development server:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

## Scripts

```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run start      # Start production server
npm run scan       # Scan projects and generate metadata
npm run scan:force # Force rescan all projects
npm run lint       # Run ESLint
```

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
│   │   ├── readme/      # README fetcher API
│   │   └── scan/        # Scanner API
│   └── dashboard/       # Main dashboard page
├── components/
│   ├── ui/              # shadcn/ui components
│   ├── ReadmeDialog.js  # README viewer
│   └── ScanControls.js  # Scan buttons
├── scanner/             # Project scanner module
└── lib/                 # Utilities
scripts/
└── scan.mjs             # CLI scanner script
data/
└── projects_metadata.jsonl  # Generated metadata (gitignored)
```

## Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SCAN_ROOTS` | Comma-separated directories to scan | `/home/user/projects,/home/user/work` |
| `BASE_DIR` | Base path for relative directory display | `/home/user/projects` |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
