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

            const liveGit = await getLiveGitStatus(project.directory)

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
