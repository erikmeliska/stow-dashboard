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
import { getProjectProcesses } from '../lib/processes.mjs'
import { readStatus, writeStatus } from '../lib/status.mjs'
import { listScripts, runScript } from '../lib/scripts.mjs'
import { readTasks, addTask, taskPrefix } from '../lib/tasks.mjs'
import { verifyTask, auditTasks, generateChangelog } from '../lib/history.mjs'
import { writeBrief, openInClaudeDesktop } from '../lib/dispatch.mjs'
import { readOpenWithEnv } from '../lib/open-with.mjs'
import { defaultUsagePaths } from '../lib/usage.mjs'
import { ledgerFile, envFile } from '../lib/state-dir.mjs'
import { existsSync } from 'fs'

const execAsync = promisify(exec)

// Ensure /usr/sbin is in PATH for lsof
process.env.PATH = `${process.env.PATH}:/usr/sbin:/sbin`

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')

// The MCP server is spawned by an AI client with an arbitrary cwd, so state
// can't be resolved from cwd — pass the repo as the fallback base. The
// desktop app's app-data dir still wins when it holds the live ledger, which
// is what keeps the MCP tools and the Deno app on one dataset.
const STATE = { base: PROJECT_ROOT }
const DATA_FILE = ledgerFile(STATE)

// Load environment from .env.local
const envPath = envFile(STATE)
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

const ENV_PATH = envPath

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

// Load the AI usage ledger (data/usage.json); tolerate missing/broken file.
async function loadUsage() {
    try {
        const { outFile } = defaultUsagePaths(STATE)
        const raw = JSON.parse(await fs.readFile(outFile, 'utf-8'))
        return raw && typeof raw.projects === 'object' && raw.projects !== null ? raw : { projects: {} }
    } catch {
        return { projects: {} }
    }
}

// Shape a project's ai_analysis + ai_derived into the `ai` detail block.
function aiBlock(project) {
    const a = project.ai_analysis
    if (!a) return null
    if (a.error) return { error: a.error, errorDetail: a.error_detail }
    const d = project.ai_derived
    return {
        category: a.category,
        client: a.client,
        type: a.project_type,
        domain: a.domain,
        maturity: a.maturity,
        docScore: a.doc_score,
        docGaps: a.doc_gaps,
        description: a.generated_description,
        reusableAssets: a.reusable_assets,
        confidence: a.confidence,
        status: d?.status,
        tech: d?.tech,
        placementOk: d?.placement_ok,
        suggestedPath: d?.suggested_path,
    }
}

async function getProjectByIdOrName(name) {
    const projects = await loadProjects()
    // Try exact ID match first
    const byId = projects.find(p => p.id === name)
    if (byId) return byId
    // Then name/path match
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
        version: '1.1.0',
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
        const project = await getProjectByIdOrName(name)

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
                description: 'Search projects by name, stack, or group. Also filters on AI-analysis facets (category, project type, domain, tech, maturity, misplaced). Returns matching projects with basic info including unique project IDs, AI category, and AI cost.',
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
                        category: {
                            type: 'string',
                            description: 'AI facet: filter by categorized folder taxonomy (e.g., "_Bizz", "_Learning")'
                        },
                        type: {
                            type: 'string',
                            description: 'AI facet: filter by project_type (e.g., "web-app", "script-collection")'
                        },
                        domain: {
                            type: 'string',
                            description: 'AI facet: filter by domain (e.g., "education", "ecommerce")'
                        },
                        tech: {
                            type: 'string',
                            description: 'AI facet: filter by derived tech tag (exact, lowercase, e.g. "react")'
                        },
                        maturity: {
                            type: 'string',
                            description: 'AI facet: filter by maturity (e.g., "idea", "prototype", "production")'
                        },
                        misplaced: {
                            type: 'boolean',
                            description: 'AI facet: when true, only projects the AI flagged as placed in the wrong folder (placement_ok === false)'
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
                            description: 'Project ID, name, or partial path'
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
                            description: 'Project ID, name, or partial path'
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
                            description: 'Project ID, name, or partial path'
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
                            description: 'Project ID, name, or partial path'
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
            },
            {
                name: 'get_status',
                description: 'Read a project STATUS.md: current NEXT step, status (active/paused/blocked/done), updated date, and working links.',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Project ID, name, or partial path' } },
                    required: ['name'],
                },
            },
            {
                name: 'set_status',
                description: 'Update a project STATUS.md. Provide any of: next, status, links. Stamps today as updated. Use this to record the single next step when ending work.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        next: { type: 'string', description: 'The single next action' },
                        status: { type: 'string', enum: ['active', 'paused', 'blocked', 'done'] },
                        links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] } },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'list_scripts',
                description: 'List runnable scripts for a project (package.json scripts + root .sh files).',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Project ID, name, or partial path' } },
                    required: ['name'],
                },
            },
            {
                name: 'run_script',
                description: 'Start a project script (e.g. dev server) detached in the background. Returns pid and log file. Stop it later with stop_process.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        script: { type: 'string', description: 'Script name from list_scripts (e.g. "dev" or "deploy.sh")' },
                    },
                    required: ['name', 'script'],
                },
            },
            {
                name: 'list_tasks',
                description: 'List open tasks across all projects (the cross-project backlog). Optionally filter by client (group name), priority (P1..P9), or status (open|done|all, default open).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        client: { type: 'string', description: 'Filter to a client/group, e.g. "Innovis"' },
                        priority: { type: 'string', description: 'Filter to a priority, e.g. "P1"' },
                        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Default open' },
                    },
                },
            },
            {
                name: 'add_task',
                description: 'Add a task to a project TASKS.md. Allocates a task ID (CLIENT-PROJECT-NNNN). Use when triaging an intake item or capturing work for a project.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        text: { type: 'string', description: 'The task description' },
                        priority: { type: 'string', description: 'P1..P9 (default P2)' },
                        source: { type: 'string', description: 'Where it came from, e.g. a meeting note path' },
                    },
                    required: ['name', 'text'],
                },
            },
            {
                name: 'verify_task',
                description: 'Check whether a task is backed by a git commit referencing its ID (evidence-gated "done"). Returns hasEvidence + the commits.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        taskId: { type: 'string', description: 'Task ID, e.g. INV-CLM-0042' },
                    },
                    required: ['name', 'taskId'],
                },
            },
            {
                name: 'completed_tasks',
                description: 'List DONE tasks across all projects with their evidence status. Tasks marked done but with NO referencing commit are flagged hasEvidence:false (suspicious). Optional client filter.',
                inputSchema: {
                    type: 'object',
                    properties: { client: { type: 'string', description: 'Filter to a client/group' } },
                },
            },
            {
                name: 'dispatch_task',
                description: 'Dispatch work to a project: write BRIEF.md and point STATUS.md NEXT at it, then open the repo in Claude Desktop. A fresh session reads BRIEF.md to start.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        text: { type: 'string', description: 'The work brief' },
                        taskId: { type: 'string', description: 'Optional task ID this brief implements' },
                        open: { type: 'boolean', description: 'Open in Claude Desktop (default true)' },
                    },
                    required: ['name', 'text'],
                },
            },
            {
                name: 'generate_changelog',
                description: 'Generate/refresh a project CHANGELOG.md from its task-id commits (human/client-readable history).',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Project ID, name, or partial path' } },
                    required: ['name'],
                },
            },
            {
                name: 'find_reusable_assets',
                description: 'Search harvestable building blocks (auth flows, scrapers, integrations) that the AI analysis found across all projects.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Case-insensitive substring to match against asset text (omit for all)' },
                        limit: { type: 'number', description: 'Maximum number of results (default: 20)' },
                    },
                },
            },
        ]
    }
})

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
        case 'search_projects': {
            const projects = await loadProjects()
            const usage = await loadUsage()
            const query = (args.query || '').toLowerCase()
            const stackFilter = (args.stack || '').toLowerCase()
            const groupFilter = (args.group || '').toLowerCase()
            const categoryFilter = (args.category || '').toLowerCase()
            const typeFilter = (args.type || '').toLowerCase()
            const domainFilter = (args.domain || '').toLowerCase()
            const techFilter = (args.tech || '').toLowerCase()
            const maturityFilter = (args.maturity || '').toLowerCase()
            const misplacedFilter = args.misplaced === true
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
                // AI facets — a record without a successful ai_analysis never matches an AI filter.
                const ai = p.ai_analysis && !p.ai_analysis.error ? p.ai_analysis : null
                if (categoryFilter && ai?.category?.toLowerCase() !== categoryFilter) return false
                if (typeFilter && ai?.project_type?.toLowerCase() !== typeFilter) return false
                if (domainFilter && ai?.domain?.toLowerCase() !== domainFilter) return false
                if (maturityFilter && ai?.maturity?.toLowerCase() !== maturityFilter) return false
                if (techFilter && !p.ai_derived?.tech?.some(t => t.toLowerCase() === techFilter)) return false
                if (misplacedFilter && p.ai_derived?.placement_ok !== false) return false
                return true
            })

            results = results.slice(0, limit).map(p => {
                const cost = usage.projects?.[p.directory]?.costUsd
                return {
                    id: p.id,
                    name: p.project_name,
                    directory: p.directory,
                    stack: p.stack?.slice(0, 5),
                    groups: p.groupParts,
                    size: formatBytes(p.content_size_bytes),
                    hasGit: p.git_info?.git_detected || false,
                    uncommitted: p.git_info?.uncommitted_changes || 0,
                    aiCategory: p.ai_analysis?.category ?? null,
                    aiCostUsd: typeof cost === 'number' ? Math.round(cost) : null,
                }
            })

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
            const project = await getProjectByIdOrName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            const [liveGit, projectProcesses, usage] = await Promise.all([
                getLiveGitStatus(project.directory),
                getProjectProcesses(),
                loadUsage(),
            ])

            const runningInfo = projectProcesses[project.directory]
            const u = usage.projects?.[project.directory]
            const aiUsage = u ? {
                sessions: u.sessions,
                activeHours: +((u.activeMinutes || 0) / 60).toFixed(1),
                costUsd: u.costUsd,
                unpricedModels: u.unpricedModels || [],
                note: 'list-price value, not an invoice',
            } : null

            const details = {
                id: project.id,
                name: project.project_name,
                directory: project.directory,
                description: project.description,
                stack: project.stack,
                scc: project.scc ?? null,
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
                ai: aiBlock(project),
                aiUsage,
                hasReadme: project.hasReadme,
                lastModified: project.last_modified
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(details, null, 2) }]
            }
        }

        case 'get_project_readme': {
            const project = await getProjectByIdOrName(args.name)
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
            const project = await getProjectByIdOrName(args.name)
            if (!project) {
                return {
                    content: [{ type: 'text', text: `Project not found: ${args.name}` }]
                }
            }

            try {
                const config = await readOpenWithEnv(ENV_PATH)
                switch (args.app) {
                    case 'ide':
                        await execAsync(`${config.ide[0]} -n "${project.directory}"`)
                        break
                    case 'terminal':
                        await execAsync(`open -a "${config.terminal[0]}" "${project.directory}"`)
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
                        id: p.id,
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
                    id: project?.id,
                    name: project?.project_name || path.basename(directory),
                    directory,
                    ports: info.ports,
                    processes: info.processes.map(p => ({
                        pid: p.pid,
                        command: p.command,
                        ports: p.ports
                    })),
                    docker: info.docker.map(c => ({
                        id: c.id,
                        name: c.name,
                        image: c.image,
                        ports: c.ports,
                        status: c.status
                    }))
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
            const project = await getProjectByIdOrName(args.name)
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
                        id: project.id,
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
                    id: p.id,
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

        case 'get_status': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const status = await readStatus(project.directory)
            return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
        }
        case 'set_status': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const fields = {}
            if (args.next !== undefined) fields.next = args.next
            if (args.status !== undefined) fields.status = args.status
            if (args.links !== undefined) fields.links = args.links
            const merged = await writeStatus(project.directory, fields)
            return { content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }] }
        }
        case 'list_scripts': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const scripts = await listScripts(project.directory)
            return { content: [{ type: 'text', text: JSON.stringify(scripts, null, 2) }] }
        }
        case 'run_script': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const result = await runScript(project.directory, args.script)
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
        case 'list_tasks': {
            const projects = await loadProjects()
            const status = args.status || 'open'
            const out = []
            for (const p of projects) {
                let tasks = []
                try { tasks = await readTasks(p.directory) } catch { /* no TASKS.md */ }
                for (const t of tasks) {
                    if (status === 'open' && t.done) continue
                    if (status === 'done' && !t.done) continue
                    if (args.priority && t.priority !== args.priority) continue
                    if (args.client && !(p.groupParts || []).some(g => String(g).toLowerCase() === String(args.client).toLowerCase())) continue
                    out.push({ ...t, project: p.project_name, directory: p.directory, group: p.groupParts })
                }
            }
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
        }
        case 'add_task': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const prefix = taskPrefix(project.groupParts, project.project_name)
            const task = await addTask(project.directory, { text: args.text, priority: args.priority || 'P2', source: args.source || null, prefix })
            return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
        }
        case 'verify_task': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const result = await verifyTask(project.directory, args.taskId)
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
        case 'completed_tasks': {
            const projects = await loadProjects()
            const out = []
            for (const p of projects) {
                if (!existsSync(path.join(p.directory, 'TASKS.md'))) continue   // skip the ~1000 projects without tasks (avoids a git call each)
                if (args.client && !(p.groupParts || []).some(g => String(g).toLowerCase() === String(args.client).toLowerCase())) continue
                let audit = []
                try { audit = await auditTasks(p.directory) } catch { /* not git / no tasks */ }
                for (const t of audit) out.push({ ...t, project: p.project_name, directory: p.directory })
            }
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
        }
        case 'dispatch_task': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const briefPath = await writeBrief(project.directory, { taskId: args.taskId || null, text: args.text })
            const opened = args.open === false ? false : await openInClaudeDesktop(project.directory)
            return { content: [{ type: 'text', text: JSON.stringify({ briefPath, opened }, null, 2) }] }
        }
        case 'generate_changelog': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const cl = await generateChangelog(project.directory)
            await fs.writeFile(path.join(project.directory, 'CHANGELOG.md'), cl, 'utf-8')
            return { content: [{ type: 'text', text: JSON.stringify({ written: 'CHANGELOG.md', preview: cl.slice(0, 500) }, null, 2) }] }
        }
        case 'find_reusable_assets': {
            const projects = await loadProjects()
            const q = (args.query || '').toLowerCase()
            const limit = args.limit || 20
            const out = []
            for (const p of projects) {
                const a = p.ai_analysis
                if (!a || a.error || !Array.isArray(a.reusable_assets)) continue
                for (const asset of a.reusable_assets) {
                    if (q && !String(asset).toLowerCase().includes(q)) continue
                    out.push({ asset, project: p.project_name, directory: p.directory })
                    if (out.length >= limit) break
                }
                if (out.length >= limit) break
            }
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
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
