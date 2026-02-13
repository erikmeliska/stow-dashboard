#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import { simpleGit } from 'simple-git'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'projects_metadata.jsonl')

// Load environment from .env.local
const envPath = path.join(PROJECT_ROOT, '.env.local')
try {
    const envContent = await fs.readFile(envPath, 'utf-8')
    for (const line of envContent.split('\n')) {
        const [key, ...valueParts] = line.split('=')
        if (key && !key.startsWith('#')) {
            process.env[key.trim()] = valueParts.join('=').trim()
        }
    }
} catch {
    // .env.local not found, use defaults
}

const TERMINAL_APP = process.env.TERMINAL_APP || 'Terminal'
const IDE_COMMAND = process.env.IDE_COMMAND || 'code'

// Helper functions
async function loadProjects() {
    try {
        const content = await fs.readFile(DATA_FILE, 'utf-8')
        return content
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
    } catch {
        return []
    }
}

async function getProjectByName(name) {
    const projects = await loadProjects()
    return projects.find(p =>
        p.project_name.toLowerCase() === name.toLowerCase() ||
        p.directory.toLowerCase().includes(name.toLowerCase())
    )
}

async function getLiveGitStatus(directory) {
    try {
        const git = simpleGit(directory)
        const isRepo = await git.checkIsRepo()
        if (!isRepo) return { isGitRepo: false }

        const status = await git.status()
        return {
            isGitRepo: true,
            isClean: status.isClean(),
            uncommittedChanges: status.files.length,
            staged: status.staged.length,
            modified: status.modified.length,
            untracked: status.not_added.length,
            ahead: status.ahead || 0,
            behind: status.behind || 0,
            branch: status.current,
            tracking: status.tracking
        }
    } catch (error) {
        return { isGitRepo: false, error: error.message }
    }
}

function formatBytes(bytes) {
    if (!bytes) return '-'
    const mb = bytes / 1024 / 1024
    if (mb >= 1) return `${mb.toFixed(2)} MB`
    const kb = bytes / 1024
    return `${kb.toFixed(1)} KB`
}

async function getRunningProcesses() {
    const processes = new Map()

    try {
        const { stdout: lsofOut } = await execAsync('lsof -i -P -n 2>/dev/null | grep LISTEN || true')

        for (const line of lsofOut.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const command = parts[0]
            const pid = parts[1]
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)

            if (portMatch && pid) {
                if (!processes.has(pid)) {
                    processes.set(pid, { pid, command, ports: [], cwd: null, type: 'process' })
                }
                const port = portMatch[1]
                if (!processes.get(pid).ports.includes(port)) {
                    processes.get(pid).ports.push(port)
                }
            }
        }

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
    } catch {
        // lsof failed
    }

    return Array.from(processes.values())
}

async function getDockerContainers() {
    const containers = []

    try {
        const { stdout } = await execAsync(
            `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Status}}' 2>/dev/null || true`,
            { timeout: 5000 }
        )

        for (const line of stdout.split('\n').filter(Boolean)) {
            const [id, name, image, portsStr, workingDir, status] = line.split('\t')

            if (!id) continue

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
        // Docker not available
    }

    return containers
}

function matchProcessToProject(processCwd, projectDirs) {
    if (!processCwd) return null

    for (const dir of projectDirs) {
        if (processCwd === dir || processCwd.startsWith(dir + '/')) {
            return dir
        }
    }
    return null
}

async function getProjectProcesses() {
    const [runningProcesses, dockerContainers, projects] = await Promise.all([
        getRunningProcesses(),
        getDockerContainers(),
        loadProjects()
    ])

    const projectDirs = projects.map(p => p.directory)
    const projectProcesses = {}

    for (const proc of runningProcesses) {
        const matchedDir = matchProcessToProject(proc.cwd, projectDirs)
        if (matchedDir) {
            if (!projectProcesses[matchedDir]) {
                projectProcesses[matchedDir] = { processes: [], docker: [], ports: [] }
            }
            projectProcesses[matchedDir].processes.push({
                pid: parseInt(proc.pid),
                command: proc.command,
                ports: proc.ports
            })
            projectProcesses[matchedDir].ports.push(...proc.ports)
        }
    }

    for (const container of dockerContainers) {
        const matchedDir = matchProcessToProject(container.cwd, projectDirs)
        if (matchedDir) {
            if (!projectProcesses[matchedDir]) {
                projectProcesses[matchedDir] = { processes: [], docker: [], ports: [] }
            }
            projectProcesses[matchedDir].docker.push({
                id: container.id,
                name: container.name,
                image: container.image,
                ports: container.ports,
                status: container.status
            })
            projectProcesses[matchedDir].ports.push(...container.ports)
        }
    }

    // Dedupe ports
    for (const dir of Object.keys(projectProcesses)) {
        projectProcesses[dir].ports = [...new Set(projectProcesses[dir].ports)]
    }

    return projectProcesses
}

// Create server
const server = new Server(
    {
        name: 'stow-dashboard',
        version: '1.0.0',
    },
    {
        capabilities: {
            resources: {},
            tools: {},
        },
    }
)

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const projects = await loadProjects()

    return {
        resources: [
            {
                uri: 'stow://projects',
                mimeType: 'application/json',
                name: 'All Projects',
                description: `List of all ${projects.length} scanned projects`
            },
            ...projects.map(p => ({
                uri: `stow://project/${encodeURIComponent(p.project_name)}`,
                mimeType: 'application/json',
                name: p.project_name,
                description: `${p.description || 'No description'} | ${p.stack?.join(', ') || 'Unknown stack'}`
            }))
        ]
    }
})

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params

    if (uri === 'stow://projects') {
        const projects = await loadProjects()
        const summary = projects.map(p => ({
            name: p.project_name,
            directory: p.directory,
            stack: p.stack,
            git: p.git_info?.git_detected ? {
                branch: p.git_info.current_branch,
                uncommitted: p.git_info.uncommitted_changes || 0,
                ahead: p.git_info.ahead || 0,
                behind: p.git_info.behind || 0
            } : null
        }))
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(summary, null, 2)
            }]
        }
    }

    if (uri.startsWith('stow://project/')) {
        const name = decodeURIComponent(uri.replace('stow://project/', ''))
        const project = await getProjectByName(name)

        if (!project) {
            throw new Error(`Project not found: ${name}`)
        }

        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(project, null, 2)
            }]
        }
    }

    throw new Error(`Unknown resource: ${uri}`)
})

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'search_projects',
                description: 'Search projects by name, stack, or group. Returns matching projects with basic info.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query (matches project name, stack, group, or path)'
                        },
                        stack: {
                            type: 'string',
                            description: 'Filter by technology (e.g., "react", "python", "nextjs")'
                        },
                        group: {
                            type: 'string',
                            description: 'Filter by group/folder (e.g., "_Bizz", "TriSoft")'
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of results (default: 10)'
                        }
                    }
                }
            },
            {
                name: 'get_project_details',
                description: 'Get detailed information about a specific project including live git status',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Project name or partial path'
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'get_project_readme',
                description: 'Get the README content of a project',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Project name or partial path'
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'open_project',
                description: 'Open a project in IDE, Terminal, or Finder',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Project name or partial path'
                        },
                        app: {
                            type: 'string',
                            enum: ['ide', 'terminal', 'finder'],
                            description: 'Application to open the project in'
                        }
                    },
                    required: ['name', 'app']
                }
            },
            {
                name: 'list_dirty_projects',
                description: 'List all projects with uncommitted changes or that are behind remote',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['uncommitted', 'behind', 'ahead', 'all'],
                            description: 'Type of dirty state to filter (default: all)'
                        }
                    }
                }
            },
            {
                name: 'get_project_stats',
                description: 'Get aggregate statistics about all projects',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'list_running_projects',
                description: 'List all projects that have running processes or Docker containers',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'get_project_processes',
                description: 'Get running processes and Docker containers for a specific project',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Project name or partial path'
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'list_recent_projects',
                description: 'List most recently modified projects, sorted by last modification date (newest first)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: 'Maximum number of results (default: 10)'
                        }
                    }
                }
            },
            {
                name: 'stop_process',
                description: 'Stop a running process by PID or Docker container by ID',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['process', 'docker'],
                            description: 'Type of target to stop'
                        },
                        id: {
                            type: 'string',
                            description: 'PID for process or container ID for Docker'
                        },
                        signal: {
                            type: 'string',
                            enum: ['SIGTERM', 'SIGKILL'],
                            description: 'Signal to send (default: SIGTERM for process, stop for Docker)'
                        }
                    },
                    required: ['type', 'id']
                }
            }
        ]
    }
})

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
        case 'search_projects': {
            const projects = await loadProjects()
            const query = (args.query || '').toLowerCase()
            const stackFilter = (args.stack || '').toLowerCase()
            const groupFilter = (args.group || '').toLowerCase()
            const limit = args.limit || 10

            let results = projects.filter(p => {
                if (query) {
                    const matches =
                        p.project_name.toLowerCase().includes(query) ||
                        p.directory.toLowerCase().includes(query) ||
                        p.description?.toLowerCase().includes(query) ||
                        p.stack?.some(s => s.toLowerCase().includes(query)) ||
                        p.groupParts?.some(g => g.toLowerCase().includes(query))
                    if (!matches) return false
                }
                if (stackFilter && !p.stack?.some(s => s.toLowerCase().includes(stackFilter))) {
                    return false
                }
                if (groupFilter && !p.groupParts?.some(g => g.toLowerCase().includes(groupFilter))) {
                    return false
                }
                return true
            })

            results = results.slice(0, limit).map(p => ({
                name: p.project_name,
                directory: p.directory,
                stack: p.stack?.slice(0, 5),
                groups: p.groupParts,
                size: formatBytes(p.content_size_bytes),
                hasGit: p.git_info?.git_detected || false,
                uncommitted: p.git_info?.uncommitted_changes || 0
            }))

            return {
                content: [{
                    type: 'text',
                    text: results.length > 0
                        ? JSON.stringify(results, null, 2)
                        : 'No projects found matching your criteria'
                }]
            }
        }

        case 'get_project_details': {
            const project = await getProjectByName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            const [liveGit, projectProcesses] = await Promise.all([
                getLiveGitStatus(project.directory),
                getProjectProcesses()
            ])

            const runningInfo = projectProcesses[project.directory]

            const details = {
                name: project.project_name,
                directory: project.directory,
                description: project.description,
                stack: project.stack,
                groups: project.groupParts,
                size: {
                    code: formatBytes(project.content_size_bytes),
                    libs: formatBytes(project.libs_size_bytes),
                    total: formatBytes(project.total_size_bytes)
                },
                git: project.git_info?.git_detected ? {
                    branch: liveGit.branch || project.git_info.current_branch,
                    remotes: project.git_info.remotes,
                    totalCommits: project.git_info.total_commits,
                    yourCommits: project.git_info.user_commits,
                    live: liveGit
                } : null,
                running: runningInfo ? {
                    processes: runningInfo.processes,
                    docker: runningInfo.docker,
                    ports: runningInfo.ports
                } : null,
                hasReadme: project.hasReadme,
                lastModified: project.last_modified
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(details, null, 2) }]
            }
        }

        case 'get_project_readme': {
            const project = await getProjectByName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            const readmeNames = ['README.md', 'readme.md', 'README', 'readme.txt']
            for (const readmeName of readmeNames) {
                try {
                    const readmePath = path.join(project.directory, readmeName)
                    const content = await fs.readFile(readmePath, 'utf-8')
                    return {
                        content: [{ type: 'text', text: content }]
                    }
                } catch {
                    continue
                }
            }

            return {
                content: [{ type: 'text', text: `No README found for project: ${project.project_name}` }]
            }
        }

        case 'open_project': {
            const project = await getProjectByName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            try {
                switch (args.app) {
                    case 'ide':
                        await execAsync(`${IDE_COMMAND} -n "${project.directory}"`)
                        break
                    case 'terminal':
                        await execAsync(`open -a "${TERMINAL_APP}" "${project.directory}"`)
                        break
                    case 'finder':
                        await execAsync(`open "${project.directory}"`)
                        break
                }
                return {
                    content: [{ type: 'text', text: `Opened ${project.project_name} in ${args.app}` }]
                }
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to open: ${error.message}` }]
                }
            }
        }

        case 'list_dirty_projects': {
            const projects = await loadProjects()
            const filterType = args.type || 'all'

            const dirty = []
            for (const p of projects) {
                if (!p.git_info?.git_detected) continue

                const uncommitted = p.git_info.uncommitted_changes || 0
                const behind = p.git_info.behind || 0
                const ahead = p.git_info.ahead || 0

                const isDirty =
                    (filterType === 'all' && (uncommitted > 0 || behind > 0 || ahead > 0)) ||
                    (filterType === 'uncommitted' && uncommitted > 0) ||
                    (filterType === 'behind' && behind > 0) ||
                    (filterType === 'ahead' && ahead > 0)

                if (isDirty) {
                    dirty.push({
                        name: p.project_name,
                        directory: p.directory,
                        uncommitted,
                        ahead,
                        behind
                    })
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: dirty.length > 0
                        ? JSON.stringify(dirty, null, 2)
                        : 'All projects are clean and up to date!'
                }]
            }
        }

        case 'get_project_stats': {
            const projects = await loadProjects()

            const stats = {
                totalProjects: projects.length,
                withGit: projects.filter(p => p.git_info?.git_detected).length,
                withUncommitted: projects.filter(p => p.git_info?.uncommitted_changes > 0).length,
                behindRemote: projects.filter(p => p.git_info?.behind > 0).length,
                totalCodeSize: formatBytes(projects.reduce((sum, p) => sum + (p.content_size_bytes || 0), 0)),
                totalSize: formatBytes(projects.reduce((sum, p) => sum + (p.total_size_bytes || 0), 0)),
                stackBreakdown: {},
                groupBreakdown: {}
            }

            // Count stacks
            for (const p of projects) {
                for (const tech of (p.stack || [])) {
                    stats.stackBreakdown[tech] = (stats.stackBreakdown[tech] || 0) + 1
                }
                for (const group of (p.groupParts || [])) {
                    stats.groupBreakdown[group] = (stats.groupBreakdown[group] || 0) + 1
                }
            }

            // Sort and limit
            stats.stackBreakdown = Object.fromEntries(
                Object.entries(stats.stackBreakdown)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 15)
            )
            stats.groupBreakdown = Object.fromEntries(
                Object.entries(stats.groupBreakdown)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
            )

            return {
                content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }]
            }
        }

        case 'list_running_projects': {
            const projectProcesses = await getProjectProcesses()
            const projects = await loadProjects()

            const running = []
            for (const [directory, info] of Object.entries(projectProcesses)) {
                const project = projects.find(p => p.directory === directory)
                running.push({
                    name: project?.project_name || path.basename(directory),
                    directory,
                    processes: info.processes.length,
                    containers: info.docker.length,
                    ports: info.ports
                })
            }

            return {
                content: [{
                    type: 'text',
                    text: running.length > 0
                        ? JSON.stringify(running, null, 2)
                        : 'No projects are currently running'
                }]
            }
        }

        case 'get_project_processes': {
            const project = await getProjectByName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            const projectProcesses = await getProjectProcesses()
            const info = projectProcesses[project.directory]

            if (!info) {
                return {
                    content: [{ type: 'text', text: `No running processes or containers for: ${project.project_name}` }]
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        name: project.project_name,
                        directory: project.directory,
                        processes: info.processes,
                        docker: info.docker,
                        ports: info.ports
                    }, null, 2)
                }]
            }
        }

        case 'list_recent_projects': {
            const projects = await loadProjects()
            const limit = args.limit || 10

            const recent = projects
                .filter(p => p.last_modified)
                .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified))
                .slice(0, limit)
                .map(p => ({
                    name: p.project_name,
                    directory: p.directory,
                    lastModified: p.last_modified,
                    stack: p.stack?.slice(0, 5),
                    size: formatBytes(p.content_size_bytes),
                    hasGit: p.git_info?.git_detected || false,
                    uncommitted: p.git_info?.uncommitted_changes || 0
                }))

            return {
                content: [{
                    type: 'text',
                    text: recent.length > 0
                        ? JSON.stringify(recent, null, 2)
                        : 'No projects found'
                }]
            }
        }

        case 'stop_process': {
            try {
                if (args.type === 'process') {
                    const signal = args.signal === 'SIGKILL' ? '-9' : '-15'
                    await execAsync(`kill ${signal} ${args.id}`)
                    return {
                        content: [{ type: 'text', text: `Process ${args.id} stopped` }]
                    }
                } else if (args.type === 'docker') {
                    const action = args.signal === 'SIGKILL' ? 'kill' : 'stop'
                    await execAsync(`docker ${action} ${args.id}`, { timeout: 30000 })
                    return {
                        content: [{ type: 'text', text: `Container ${args.id} stopped` }]
                    }
                }
                return {
                    content: [{ type: 'text', text: `Unknown type: ${args.type}` }]
                }
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to stop: ${error.message}` }]
                }
            }
        }

        default:
            throw new Error(`Unknown tool: ${name}`)
    }
})

// Start server
async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('Stow Dashboard MCP server running on stdio')
}

main().catch(console.error)
