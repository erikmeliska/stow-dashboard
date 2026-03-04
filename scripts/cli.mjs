#!/usr/bin/env node

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { config } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_FILE = path.join(__dirname, '..', 'data', 'projects_metadata.jsonl')

config({ path: path.join(__dirname, '..', '.env.local'), debug: false })
const BASE_DIR = process.env.BASE_DIR || ''

// ANSI colors
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    bgGreen: '\x1b[42m',
    bgBlue: '\x1b[44m',
}

// Terminal hyperlink (OSC 8)
function link(text, url) {
    return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

function formatSize(bytes) {
    if (!bytes) return c.dim + '—' + c.reset
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return c.dim + '—' + c.reset
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo ago`
    return `${Math.floor(months / 12)}y ago`
}

function shortDir(dir) {
    if (BASE_DIR && dir.startsWith(BASE_DIR + '/')) {
        return dir.slice(BASE_DIR.length + 1)
    }
    return dir.replace(/^\/Users\/[^/]+\//, '~/')
}

// Detect running processes (same logic as API, using execFileSync for safety)
function getRunningProcesses() {
    const processes = new Map()
    try {
        const lsofOut = execFileSync('sh', ['-c', 'lsof -i -P -n 2>/dev/null | grep LISTEN || true'], { encoding: 'utf-8', timeout: 10000 })
        for (const line of lsofOut.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const command = parts[0]
            const pid = parts[1]
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)
            if (portMatch && pid && !command.startsWith('OrbStack')) {
                if (!processes.has(pid)) {
                    processes.set(pid, { pid, command, ports: [], cwd: null })
                }
                const port = portMatch[1]
                if (!processes.get(pid).ports.includes(port)) {
                    processes.get(pid).ports.push(port)
                }
            }
        }
        if (processes.size > 0) {
            const pids = Array.from(processes.keys())
            const cwdOut = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] })
            let currentPid = null
            for (const line of cwdOut.split('\n')) {
                if (line.startsWith('p')) currentPid = line.slice(1)
                else if (line.startsWith('n') && currentPid && processes.has(currentPid)) {
                    processes.get(currentPid).cwd = line.slice(1)
                }
            }
        }
    } catch { /* ignore */ }
    return Array.from(processes.values())
}

function getDockerContainers() {
    try {
        const out = execFileSync('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Status}}'], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] })
        return out.split('\n').filter(Boolean).map(line => {
            const [id, name, portsStr, workingDir, status] = line.split('\t')
            if (!id) return null
            const ports = []
            for (const match of portsStr.matchAll(/(?:[\d.]+)?:(\d+)->/g)) {
                if (!ports.includes(match[1])) ports.push(match[1])
            }
            return { id, name, ports, cwd: workingDir || null, type: 'docker' }
        }).filter(Boolean)
    } catch { return [] }
}

function matchProcessToProject(processCwd, projectDirs) {
    if (!processCwd) return null
    let bestMatch = null
    for (const dir of projectDirs) {
        if (processCwd === dir || processCwd.startsWith(dir + '/')) {
            if (!bestMatch || dir.length > bestMatch.length) bestMatch = dir
        }
    }
    return bestMatch
}

function getProjectProcessMap(projects) {
    const projectDirs = projects.map(p => p.directory)
    const allProcesses = getRunningProcesses()
    const containers = getDockerContainers()
    const map = {}

    for (const proc of allProcesses) {
        const dir = matchProcessToProject(proc.cwd, projectDirs)
        if (dir) {
            if (!map[dir]) map[dir] = { processes: [], containers: [] }
            map[dir].processes.push(proc)
        }
    }
    for (const cont of containers) {
        const dir = matchProcessToProject(cont.cwd, projectDirs)
        if (dir) {
            if (!map[dir]) map[dir] = { processes: [], containers: [] }
            map[dir].containers.push(cont)
        }
    }
    return map
}

// Table rendering
function stripAnsi(s) {
    return String(s).replace(/\x1b\[[^m]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')
}

function padRight(str, len) {
    return str + ' '.repeat(Math.max(0, len - stripAnsi(str).length))
}

function padLeft(str, len) {
    return ' '.repeat(Math.max(0, len - stripAnsi(str).length)) + str
}

function printTable(headers, rows, aligns) {
    const widths = headers.map((h, i) =>
        Math.max(stripAnsi(h).length, ...rows.map(r => stripAnsi(r[i] || '').length))
    )

    const headerLine = headers.map((h, i) => {
        const pad = aligns[i] === 'right' ? padLeft : padRight
        return pad(c.bold + c.cyan + h + c.reset, widths[i])
    }).join('  ')
    console.log(headerLine)
    console.log(c.dim + widths.map(w => '─'.repeat(w)).join('──') + c.reset)

    for (const row of rows) {
        const line = row.map((cell, i) => {
            const pad = aligns[i] === 'right' ? padLeft : padRight
            return pad(cell || '', widths[i])
        }).join('  ')
        console.log(line)
    }
}

// Commands
async function loadProjects() {
    const content = await fs.readFile(DATA_FILE, 'utf-8')
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function filterProjects(projects, args) {
    let filtered = projects

    if (args.dirty) {
        filtered = filtered.filter(p => p.git_info?.git_detected && !p.git_info?.is_clean)
    }
    if (args.behind) {
        filtered = filtered.filter(p => p.git_info?.behind > 0)
    }
    if (args.ahead) {
        filtered = filtered.filter(p => p.git_info?.ahead > 0)
    }
    if (args.noGit) {
        filtered = filtered.filter(p => !p.git_info?.git_detected)
    }
    if (args.search) {
        const q = args.search.toLowerCase()
        filtered = filtered.filter(p =>
            p.project_name?.toLowerCase().includes(q) ||
            p.directory?.toLowerCase().includes(q) ||
            p.stack?.some(s => s.toLowerCase().includes(q))
        )
    }
    return filtered
}

function commandList(projects, args) {
    const processMap = args.running ? getProjectProcessMap(projects) : {}

    if (args.running) {
        projects = projects.filter(p => processMap[p.directory])
    }

    if (projects.length === 0) {
        console.log(c.dim + 'No projects found.' + c.reset)
        return
    }

    projects.sort((a, b) => new Date(b.last_modified || 0) - new Date(a.last_modified || 0))

    const totalCount = projects.length
    const hasLimit = !args.all && !args.running && args.limit < totalCount
    if (hasLimit) {
        projects = projects.slice(0, args.limit)
    }

    const headers = ['Project', 'Directory', 'Modified', 'Size', 'Total']
    const aligns = ['left', 'left', 'right', 'right', 'right']

    if (args.running) {
        headers.push('Ports')
        aligns.push('left')
    }

    const rows = projects.map(p => {
        const info = processMap[p.directory]
        const allPorts = info
            ? [...new Set([...info.processes.flatMap(x => x.ports), ...info.containers.flatMap(x => x.ports)])]
            : []

        const dirStr = link(
            c.dim + shortDir(p.directory) + c.reset,
            `file://${p.directory}`
        )

        const row = [
            c.bold + (p.project_name?.length > 25 ? p.project_name.slice(0, 24) + '…' : (p.project_name || '?')) + c.reset,
            dirStr,
            formatTimeAgo(p.last_modified),
            formatSize(p.content_size_bytes),
            formatSize(p.total_size_bytes),
        ]

        if (args.running) {
            const portsStr = allPorts.length
                ? c.green + allPorts.join(', ') + c.reset
                : c.dim + '—' + c.reset
            row.push(portsStr)
        }

        return row
    })

    console.log()
    if (args.running) {
        console.log(`${c.bgGreen}${c.bold} RUNNING ${c.reset} ${c.green}${projects.length} projects${c.reset}`)
    } else if (hasLimit) {
        console.log(`${c.bold}${projects.length}${c.reset}${c.dim} of ${totalCount} projects ${c.reset}${c.dim}(recently modified)${c.reset}`)
    } else {
        console.log(`${c.bold}${projects.length} projects${c.reset}`)
    }
    console.log()
    printTable(headers, rows, aligns)
    if (hasLimit) {
        console.log()
        console.log(`${c.dim}  … ${totalCount - projects.length} more — use ${c.reset}--all${c.dim} to show all, or ${c.reset}--limit N${c.dim} to change${c.reset}`)
    }
    console.log()
}

function commandDirty(projects) {
    const dirty = projects.filter(p => p.git_info?.git_detected && !p.git_info?.is_clean)
    if (dirty.length === 0) {
        console.log(c.green + 'All projects are clean!' + c.reset)
        return
    }

    dirty.sort((a, b) => (b.git_info?.uncommitted_changes || 0) - (a.git_info?.uncommitted_changes || 0))

    console.log()
    console.log(`${c.yellow}${c.bold} UNCOMMITTED ${c.reset} ${c.yellow}${dirty.length} projects${c.reset}`)
    console.log()

    printTable(
        ['Project', 'Directory', 'Changes', 'Branch'],
        dirty.map(p => [
            c.bold + (p.project_name?.length > 25 ? p.project_name.slice(0, 24) + '…' : (p.project_name || '?')) + c.reset,
            c.dim + shortDir(p.directory) + c.reset,
            c.yellow + (p.git_info?.uncommitted_changes || '?') + c.reset,
            c.dim + (p.git_info?.current_branch || '') + c.reset,
        ]),
        ['left', 'left', 'right', 'left']
    )
    console.log()
}

function commandStats(projects) {
    const total = projects.length
    const withGit = projects.filter(p => p.git_info?.git_detected).length
    const dirty = projects.filter(p => p.git_info?.git_detected && !p.git_info?.is_clean).length
    const behind = projects.filter(p => p.git_info?.behind > 0).length
    const ahead = projects.filter(p => p.git_info?.ahead > 0).length
    const totalSize = projects.reduce((sum, p) => sum + (p.total_size_bytes || 0), 0)
    const codeSize = projects.reduce((sum, p) => sum + (p.content_size_bytes || 0), 0)

    const processMap = getProjectProcessMap(projects)
    const running = Object.keys(processMap).length

    console.log()
    console.log(c.bold + '  Stow Dashboard Stats' + c.reset)
    console.log(c.dim + '  ─────────────────────' + c.reset)
    console.log(`  Projects:      ${c.bold}${total}${c.reset}`)
    console.log(`  With Git:      ${c.bold}${withGit}${c.reset}`)
    console.log(`  Running:       ${c.green}${c.bold}${running}${c.reset}`)
    console.log(`  Uncommitted:   ${dirty > 0 ? c.yellow : ''}${c.bold}${dirty}${c.reset}`)
    console.log(`  Behind:        ${behind > 0 ? c.red : ''}${c.bold}${behind}${c.reset}`)
    console.log(`  Ahead:         ${ahead > 0 ? c.blue : ''}${c.bold}${ahead}${c.reset}`)
    console.log(`  Code size:     ${c.bold}${formatSize(codeSize)}${c.reset}`)
    console.log(`  Total size:    ${c.bold}${formatSize(totalSize)}${c.reset}`)
    console.log()
}

// Scan commands
async function commandScan(force) {
    const { ProjectScanner } = await import('../src/scanner/index.mjs')

    const scanRoots = (process.env.SCAN_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean)
    if (scanRoots.length === 0) {
        console.error(c.red + 'Error: SCAN_ROOTS not configured in .env.local' + c.reset)
        process.exit(1)
    }

    console.log()
    console.log(`${c.bold}Scanning${c.reset} ${c.dim}${scanRoots.join(', ')}${c.reset}${force ? c.yellow + ' (force)' + c.reset : ''}`)
    console.log()

    let count = 0
    const startTime = Date.now()
    const scanner = new ProjectScanner({
        scanRoots,
        syncFile: DATA_FILE,
        forceUpdate: force,
        onProgress: (event) => {
            if (event.type === 'updated') {
                count++
                process.stdout.write(`\r  ${c.green}Updated:${c.reset} ${event.directory.replace(BASE_DIR + '/', '')} ${c.dim}(${event.processingTime}s)${c.reset}\x1b[K`)
            } else if (event.type === 'existing') {
                count++
                if (count % 50 === 0) {
                    process.stdout.write(`\r  ${c.dim}Scanned ${count} projects...${c.reset}\x1b[K`)
                }
            }
        }
    })

    const projects = await scanner.scanProjects()
    await scanner.syncMetadata(projects)

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    process.stdout.write('\r\x1b[K')
    console.log(`${c.green}Done.${c.reset} ${c.bold}${projects.length}${c.reset} projects in ${duration}s`)
    console.log()
}

async function commandQuickScan() {
    const { getLatestMtime } = await import('../src/scanner/index.mjs')
    const { simpleGit } = await import('simple-git')

    const projects = await loadProjects()
    const projectMap = new Map(projects.map(p => [p.directory, p]))

    // Find running projects
    process.stdout.write(`${c.dim}  Finding active projects...${c.reset}`)
    const processMap = getProjectProcessMap(projects)
    const activeProjects = projects.filter(p => processMap[p.directory])
    process.stdout.write(`\r\x1b[K`)

    if (activeProjects.length === 0) {
        console.log(`${c.dim}No running projects to refresh.${c.reset}`)
        return
    }

    console.log()
    console.log(`${c.bold}Quick refresh${c.reset} ${c.dim}${activeProjects.length} running projects${c.reset}`)
    console.log()

    const startTime = Date.now()
    for (const project of activeProjects) {
        process.stdout.write(`\r  ${c.cyan}Refreshing:${c.reset} ${project.project_name}\x1b[K`)

        try {
            const git = simpleGit(project.directory)
            const isRepo = await git.checkIsRepo()

            if (isRepo) {
                let currentUser = 'Unknown'
                let currentEmail = 'Unknown'
                try {
                    currentUser = await git.getConfig('user.name').then(r => r.value || 'Unknown')
                    currentEmail = await git.getConfig('user.email').then(r => r.value || 'Unknown')
                } catch {}

                const log = await git.log({ maxCount: 1000 })
                const allCommits = log.all || []
                const userCommits = allCommits.filter(c =>
                    c.author_name === currentUser || c.author_email === currentEmail
                )

                const remotes = await git.getRemotes(true)
                const status = await git.status()
                const branchResult = await git.branch()

                project.git_info = {
                    project_created: allCommits[allCommits.length - 1]?.date || null,
                    current_user: currentUser,
                    current_email: currentEmail,
                    total_commits: allCommits.length,
                    user_commits: userCommits.length,
                    last_total_commit_date: allCommits[0]?.date || null,
                    last_user_commit_date: userCommits[0]?.date || null,
                    remotes: remotes.map(r => r.refs?.fetch || r.refs?.push || '').filter(Boolean),
                    current_branch: branchResult.current || 'unknown',
                    ahead: status.ahead || 0,
                    behind: status.behind || 0,
                    has_remote_tracking: status.tracking !== null,
                    uncommitted_changes: status.files?.length || 0,
                    is_clean: status.isClean(),
                    git_detected: true
                }
            }

            project.last_modified = await getLatestMtime(project.directory)
        } catch {
            // Skip on error
        }

        projectMap.set(project.directory, project)
    }

    // Write back
    const lines = Array.from(projectMap.values()).map(p => JSON.stringify(p))
    await fs.writeFile(DATA_FILE, lines.join('\n') + '\n')

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    process.stdout.write('\r\x1b[K')
    console.log(`${c.green}Done.${c.reset} Refreshed ${c.bold}${activeProjects.length}${c.reset} projects in ${duration}s`)
    console.log()
}

// Argument parsing
function parseArgs() {
    const args = process.argv.slice(2)
    const opts = {
        command: null,
        running: false,
        dirty: false,
        behind: false,
        ahead: false,
        noGit: false,
        stats: false,
        search: null,
        limit: 20,
        all: false,
        force: false,
        help: false,
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case 'scan': opts.command = 'scan'; break
            case 'quickscan': opts.command = 'quickscan'; break
            case '--running': case '-r': opts.running = true; break
            case '--dirty': case '-d': opts.dirty = true; break
            case '--behind': opts.behind = true; break
            case '--ahead': opts.ahead = true; break
            case '--no-git': opts.noGit = true; break
            case '--stats': case '-s': opts.stats = true; break
            case '--search': case '-q': opts.search = args[++i]; break
            case '--limit': case '-n': opts.limit = parseInt(args[++i]) || 20; break
            case '--all': case '-a': opts.all = true; break
            case '--force': case '-f': opts.force = true; break
            case '--help': case '-h': opts.help = true; break
        }
    }
    return opts
}

function showHelp() {
    console.log(`
${c.bold}stow${c.reset} — CLI for Stow Dashboard

${c.bold}Usage:${c.reset}
  stow [options]
  stow scan [-f]
  stow quickscan

${c.bold}Commands:${c.reset}
  ${c.cyan}scan${c.reset}             Full scan of all project directories
  ${c.cyan}quickscan${c.reset}        Refresh git info for running projects only

${c.bold}Filters:${c.reset}
  ${c.cyan}--running, -r${c.reset}    Show only projects with running processes
  ${c.cyan}--dirty, -d${c.reset}      Show projects with uncommitted changes
  ${c.cyan}--behind${c.reset}         Show projects behind remote
  ${c.cyan}--ahead${c.reset}          Show projects ahead of remote
  ${c.cyan}--no-git${c.reset}         Show projects without Git
  ${c.cyan}--search, -q${c.reset}     Search by name, path, or stack

${c.bold}Output:${c.reset}
  ${c.cyan}--limit, -n${c.reset}  N   Show first N results (default: 20)
  ${c.cyan}--all, -a${c.reset}        Show all results
  ${c.cyan}--force, -f${c.reset}      Force rescan (with scan command)

${c.bold}Other:${c.reset}
  ${c.cyan}--stats, -s${c.reset}      Show summary statistics
  ${c.cyan}--help, -h${c.reset}       Show this help
`)
}

// Main
async function main() {
    const args = parseArgs()

    if (args.help) {
        showHelp()
        return
    }

    if (args.command === 'scan') {
        await commandScan(args.force)
        return
    }

    if (args.command === 'quickscan') {
        await commandQuickScan()
        return
    }

    let projects
    try {
        projects = await loadProjects()
    } catch {
        console.error(c.red + `Error: Cannot read ${DATA_FILE}` + c.reset)
        console.error(c.dim + 'Run "stow scan" first to generate project data.' + c.reset)
        process.exit(1)
    }

    if (args.stats) {
        commandStats(projects)
        return
    }

    if (args.dirty && !args.running) {
        commandDirty(filterProjects(projects, args))
        return
    }

    commandList(filterProjects(projects, args), args)
}

main().catch(e => {
    console.error(c.red + e.message + c.reset)
    process.exit(1)
})
