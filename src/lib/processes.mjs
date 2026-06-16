import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const execAsync = promisify(exec)
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/projects_metadata.jsonl')

// Coarse, pure command-string classifier (claude | dev-server | terminal | process).
// Standalone utility for display/labeling surfaces; NOT part of the parent-process-tree
// host detection used in production (see detectHostApp / HOST_PATTERNS / resolveHost).
export function classifyHost(command) {
    const c = (command || '').toLowerCase()
    if (/\bclaude\b/.test(c)) return 'claude'
    if (/\bnext dev\b|\bvite\b|\bnodemon\b|\bng serve\b|\bwebpack\b.*\bserve\b/.test(c)) return 'dev-server'
    // tmux is also in HOST_PATTERNS (detectHostApp) for parent-tree detection; keep both in sync
    if (/(^|\/)-?(z?sh|bash|fish|tmux)\b/.test(c)) return 'terminal'
    return 'process'
}

async function getProjectDirectories() {
    try {
        const content = await fs.readFile(DATA_FILE, 'utf-8')
        return content
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line).directory)
    } catch {
        return []
    }
}

export async function getRunningProcesses(procTable) {
    const processes = new Map() // pid -> { command, ports, cwd }

    try {
        // Get all listening ports with PIDs - fast
        const { stdout: lsofOut } = await execAsync('lsof -i -P -n 2>/dev/null | grep LISTEN || true')

        for (const line of lsofOut.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const command = parts[0]
            const pid = parts[1]
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)

            // Skip system-level port forwarders (OrbStack handles Docker port forwarding)
            if (portMatch && pid && !command.startsWith('OrbStack')) {
                if (!processes.has(pid)) {
                    processes.set(pid, { pid, command, ports: [], cwd: null, type: 'process', host: null, hostLabel: null })
                }
                const port = portMatch[1]
                if (!processes.get(pid).ports.includes(port)) {
                    processes.get(pid).ports.push(port)
                }
            }
        }

        // Get cwd for all PIDs at once - fast
        if (processes.size > 0) {
            const pids = Array.from(processes.keys()).join(',')
            try {
                const { stdout: cwdOut } = await execAsync(
                    `lsof -a -p ${pids} -d cwd -F n 2>/dev/null || true`
                )

                let currentPid = null
                for (const line of cwdOut.split('\n')) {
                    if (line.startsWith('p')) {
                        currentPid = line.slice(1)
                    } else if (line.startsWith('n') && currentPid && processes.has(currentPid)) {
                        processes.get(currentPid).cwd = line.slice(1)
                    }
                }
            } catch {
                // Ignore cwd errors
            }
        }

        // Classify host (terminal/editor) via parent process tree
        if (procTable) {
            for (const proc of processes.values()) {
                const host = resolveHost(procTable, proc.pid)
                if (host) {
                    proc.host = host.id
                    proc.hostLabel = host.label
                }
            }
        }
    } catch {
        // lsof failed
    }

    return Array.from(processes.values())
}

const HOST_PATTERNS = [
    { test: c => c.split('/').pop() === 'claude', id: 'claude-agent', label: 'Claude' },
    { test: c => c.includes('/cmux.app/') || /\bcmux$/.test(c), id: 'cmux', label: 'cmux' },
    { test: c => c.includes('/Zed.app/') || c.endsWith('/zed') || c === 'zed', id: 'zed', label: 'Zed' },
    { test: c => c.includes('/Cursor.app/') || /Cursor Helper/.test(c), id: 'cursor', label: 'Cursor' },
    { test: c => /Code Helper|\/Visual Studio Code\.app\//.test(c) || c.endsWith('/Code') || c === 'Code', id: 'vscode', label: 'VS Code' },
    { test: c => c.includes('/Claude.app/Contents/MacOS/Claude') && !/Claude Helper/.test(c), id: 'claude-app', label: 'Claude Desktop' },
    { test: c => /iTerm2?(\.app)?/.test(c), id: 'iterm', label: 'iTerm' },
    { test: c => /\/Warp\.app\//.test(c) || c.endsWith('/stable') && /Warp/.test(c), id: 'warp', label: 'Warp' },
    { test: c => /\/Ghostty\.app\//.test(c) || c.endsWith('/ghostty'), id: 'ghostty', label: 'Ghostty' },
    { test: c => /\/Alacritty\.app\//.test(c) || c.endsWith('/alacritty'), id: 'alacritty', label: 'Alacritty' },
    { test: c => /\/kitty\.app\//.test(c) || c.endsWith('/kitty'), id: 'kitty', label: 'kitty' },
    { test: c => /\/WezTerm\.app\//.test(c) || /wezterm(-gui)?$/.test(c), id: 'wezterm', label: 'WezTerm' },
    { test: c => /\/Hyper\.app\//.test(c), id: 'hyper', label: 'Hyper' },
    { test: c => c.includes('/Terminal.app/'), id: 'terminal', label: 'Terminal' },
    { test: c => /\btmux(: server)?$/.test(c) || c === 'tmux', id: 'tmux', label: 'tmux' },
    { test: c => /\/JetBrains Toolbox\.app\//.test(c) || /\/(IntelliJ IDEA|PyCharm|WebStorm|PhpStorm|RubyMine|GoLand|CLion|Rider|DataGrip|RustRover|Android Studio)\.app\//.test(c), id: 'jetbrains', label: 'JetBrains' },
]

function detectHostApp(comm) {
    for (const p of HOST_PATTERNS) {
        if (p.test(comm)) return { id: p.id, label: p.label }
    }
    return null
}

const SHELL_RE = /^-?(zsh|bash|fish|sh)$/

export async function getProcTable() {
    const procTable = new Map() // pid -> { ppid, comm, tty }
    const childCount = new Map() // pid -> child count

    try {
        const { stdout } = await execAsync('ps -axo pid=,ppid=,tt=,comm= 2>/dev/null || true')

        for (const line of stdout.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
            if (!match) continue
            const [, pid, ppid, tty, comm] = match
            procTable.set(pid, { ppid, comm, tty })
            childCount.set(ppid, (childCount.get(ppid) || 0) + 1)
        }
    } catch {
        // ps failed
    }

    return { procTable, childCount }
}

function resolveHost(procTable, startPid) {
    let cur = procTable.get(startPid)?.ppid
    for (let depth = 0; depth < 12 && cur && cur !== '0' && cur !== '1'; depth++) {
        const parent = procTable.get(cur)
        if (!parent) break
        const matched = detectHostApp(parent.comm)
        if (matched) return matched
        cur = parent.ppid
    }
    return null
}

async function batchLsofCwd(pids) {
    const cwds = new Map()
    if (pids.length === 0) return cwds
    try {
        const { stdout } = await execAsync(
            `lsof -a -p ${pids.join(',')} -d cwd -F n 2>/dev/null || true`
        )
        let currentPid = null
        for (const line of stdout.split('\n')) {
            if (line.startsWith('p')) {
                currentPid = line.slice(1)
            } else if (line.startsWith('n') && currentPid) {
                cwds.set(currentPid, line.slice(1))
            }
        }
    } catch {
        // ignore
    }
    return cwds
}

export async function getClaudeAndTerminalSessions(procTable, childCount) {
    const claudePids = []
    const terminalPids = []

    for (const [pid, info] of procTable.entries()) {
        const basename = info.comm.split('/').pop()
        if (basename === 'claude') {
            claudePids.push(pid)
        } else if (SHELL_RE.test(basename) && info.tty !== '??' && !childCount.has(pid)) {
            // Leaf shell on a tty (no children) = idle open terminal
            terminalPids.push(pid)
        }
    }

    const cwds = await batchLsofCwd([...claudePids, ...terminalPids])

    const claudeSessions = claudePids
        .map(pid => {
            const cwd = cwds.get(pid)
            if (!cwd) return null
            const host = resolveHost(procTable, pid)
            return {
                pid,
                command: 'claude',
                cwd,
                ports: [],
                type: 'claude',
                host: host?.id || null,
                hostLabel: host?.label || null
            }
        })
        .filter(Boolean)

    const openTerminals = terminalPids
        .map(pid => {
            const cwd = cwds.get(pid)
            if (!cwd) return null
            const proc = procTable.get(pid)
            const host = resolveHost(procTable, pid)
            return {
                pid,
                command: proc.comm.replace(/^-/, '').split('/').pop(),
                cwd,
                tty: proc.tty,
                ports: [],
                type: 'terminal',
                host: host?.id || null,
                hostLabel: host?.label || null
            }
        })
        .filter(Boolean)

    return { claudeSessions, openTerminals }
}

export async function getDockerContainers() {
    const containers = []

    try {
        // Check if docker is available and running
        const { stdout } = await execAsync(
            `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Status}}' 2>/dev/null || true`,
            { timeout: 5000 }
        )

        for (const line of stdout.split('\n').filter(Boolean)) {
            const [id, name, image, portsStr, workingDir, status] = line.split('\t')

            if (!id) continue

            // Parse ports (format: "0.0.0.0:3000->3000/tcp, :::3000->3000/tcp")
            const ports = []
            const portMatches = portsStr.matchAll(/(?:[\d.]+)?:(\d+)->/g)
            for (const match of portMatches) {
                if (!ports.includes(match[1])) {
                    ports.push(match[1])
                }
            }

            containers.push({
                id,
                name,
                image,
                ports,
                cwd: workingDir || null,
                status,
                type: 'docker'
            })
        }
    } catch {
        // Docker not available or not running
    }

    return containers
}

export function matchProcessToProject(processCwd, projectDirs) {
    if (!processCwd) return null

    // Find the most specific (longest) matching project directory
    let bestMatch = null
    for (const dir of projectDirs) {
        if (processCwd === dir || processCwd.startsWith(dir + '/')) {
            if (!bestMatch || dir.length > bestMatch.length) {
                bestMatch = dir
            }
        }
    }
    return bestMatch
}

/**
 * Group running processes, Claude/terminal sessions, and Docker containers by
 * project directory.
 *
 * Returns: { [directory]: { processes, docker, ports } }
 *
 * This is the grouped shape the MCP tools (list_running_projects,
 * get_project_processes, get_project_details) consume. It is built on top of
 * the canonical (richer) detection so the MCP gains idle-terminal detection
 * and Claude-CLI host classification.
 *
 * @param {string[]} [projectDirs] - optional list of project directories;
 *   loaded from the metadata file when omitted.
 */
export async function getProjectProcesses(projectDirs) {
    const { procTable, childCount } = await getProcTable()

    const [runningProcesses, dockerContainers, terminalsAndClaude, loadedDirs] = await Promise.all([
        getRunningProcesses(procTable),
        getDockerContainers(),
        getClaudeAndTerminalSessions(procTable, childCount),
        projectDirs ? Promise.resolve(projectDirs) : getProjectDirectories()
    ])
    const dirs = projectDirs || loadedDirs
    const { claudeSessions, openTerminals } = terminalsAndClaude

    const projectProcesses = {}

    const ensure = (dir) => {
        if (!projectProcesses[dir]) {
            projectProcesses[dir] = { processes: [], docker: [], ports: [] }
        }
        return projectProcesses[dir]
    }

    // Regular listening processes
    for (const proc of runningProcesses) {
        const matchedDir = matchProcessToProject(proc.cwd, dirs)
        if (matchedDir) {
            const entry = ensure(matchedDir)
            entry.processes.push({
                pid: parseInt(proc.pid),
                command: proc.command,
                ports: proc.ports,
                type: 'process',
                host: proc.host,
                hostLabel: proc.hostLabel
            })
            entry.ports.push(...proc.ports)
        }
    }

    // Claude CLI sessions
    for (const session of claudeSessions) {
        const matchedDir = matchProcessToProject(session.cwd, dirs)
        if (matchedDir) {
            const entry = ensure(matchedDir)
            entry.processes.push({
                pid: parseInt(session.pid),
                command: 'claude',
                cwd: session.cwd,
                ports: [],
                type: 'claude',
                host: session.host,
                hostLabel: session.hostLabel
            })
        }
    }

    // Idle open terminals
    for (const term of openTerminals) {
        const matchedDir = matchProcessToProject(term.cwd, dirs)
        if (matchedDir) {
            const entry = ensure(matchedDir)
            entry.processes.push({
                pid: parseInt(term.pid),
                command: term.command,
                cwd: term.cwd,
                tty: term.tty,
                ports: [],
                type: 'terminal',
                host: term.host,
                hostLabel: term.hostLabel
            })
        }
    }

    // Docker containers
    for (const container of dockerContainers) {
        const matchedDir = matchProcessToProject(container.cwd, dirs)
        if (matchedDir) {
            const entry = ensure(matchedDir)
            entry.docker.push({
                id: container.id,
                name: container.name,
                image: container.image,
                ports: container.ports,
                status: container.status
            })
            entry.ports.push(...container.ports)
        }
    }

    // Dedupe ports
    for (const dir of Object.keys(projectProcesses)) {
        projectProcesses[dir].ports = [...new Set(projectProcesses[dir].ports)]
    }

    return projectProcesses
}
