import path from 'path'
import fs from 'fs/promises'
import { simpleGit } from 'simple-git'
import { getLatestMtime, ProjectScanner } from '@/scanner/index.mjs'
import { collectProjectProcesses } from '@/lib/processes.mjs'
import { resolveCandidateRoot, NegativeCache, dirHasProjectIndicator, isWeakOnlyGroup } from '@/lib/discovery.mjs'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')
const SCAN_ROOTS = (process.env.SCAN_ROOTS || '/Users/ericsko/Projekty').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)

// Module-level: survives across requests within one server process.
const negativeCache = new NegativeCache()

async function getGitInfo(repoPath) {
    try {
        const git = simpleGit(repoPath)
        const isRepo = await git.checkIsRepo()
        if (!isRepo) return { git_detected: false }

        let currentUser = 'Unknown'
        let currentEmail = 'Unknown'
        try {
            currentUser = await git.getConfig('user.name').then(r => r.value || 'Unknown')
            currentEmail = await git.getConfig('user.email').then(r => r.value || 'Unknown')
        } catch {}

        const log = await git.log({ maxCount: 1000 })
        const allCommits = log.all || []
        const totalCommits = allCommits.length
        const userCommits = allCommits.filter(c =>
            c.author_name === currentUser || c.author_email === currentEmail
        ).length

        const firstCommit = allCommits[allCommits.length - 1]
        const lastCommit = allCommits[0]
        const userCommitsList = allCommits.filter(c =>
            c.author_name === currentUser || c.author_email === currentEmail
        )
        const lastUserCommit = userCommitsList[0]

        const remotes = await git.getRemotes(true)
        const remoteUrls = remotes.map(r => r.refs?.fetch || r.refs?.push || '').filter(Boolean)

        let currentBranch = 'unknown'
        let ahead = 0
        let behind = 0
        let hasRemoteTracking = false
        let uncommittedChanges = 0
        let isClean = true

        try {
            const branchResult = await git.branch()
            currentBranch = branchResult.current || 'unknown'
            const status = await git.status()
            ahead = status.ahead || 0
            behind = status.behind || 0
            hasRemoteTracking = status.tracking !== null
            uncommittedChanges = status.files?.length || 0
            isClean = status.isClean()
        } catch {}

        return {
            project_created: firstCommit?.date || null,
            current_user: currentUser,
            current_email: currentEmail,
            total_commits: totalCommits,
            user_commits: userCommits,
            last_total_commit_date: lastCommit?.date || null,
            last_user_commit_date: lastUserCommit?.date || null,
            remotes: remoteUrls,
            current_branch: currentBranch,
            ahead,
            behind,
            has_remote_tracking: hasRemoteTracking,
            uncommitted_changes: uncommittedChanges,
            is_clean: isClean,
            git_detected: true
        }
    } catch (error) {
        return { git_error: error.message, git_detected: false }
    }
}

export async function POST() {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        async start(controller) {
            const sendEvent = (data) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            }

            const startTime = Date.now()

            try {
                // Load existing projects
                const content = await fs.readFile(DATA_FILE, 'utf-8')
                const projects = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
                const projectMap = new Map(projects.map(p => [p.directory, p]))

                // One sweep: processes grouped by project + unmatched cwds
                sendEvent({ type: 'status', message: 'Detecting processes...' })
                const projectDirs = [...projectMap.keys()]
                const { projects: processMap, unmatchedCwds } = await collectProjectProcesses(projectDirs)

                // Auto-discovery: unmatched cwds under SCAN_ROOTS -> candidate project roots
                const discovered = []
                for (const cwd of unmatchedCwds) {
                    if (negativeCache.has(cwd)) {
                        // Cheap re-check: did an indicator appear since we cached this cwd
                        // (e.g. `git init`)? If not, stay skipped; if so, fall through to
                        // full resolution below so it can appear within this cycle.
                        if (!(await dirHasProjectIndicator(cwd))) continue
                    }
                    try {
                        const candidate = await resolveCandidateRoot(cwd, SCAN_ROOTS)
                        if (!candidate) {
                            negativeCache.add(cwd)
                            continue
                        }
                        if (projectMap.has(candidate)) continue // known via another path

                        if (await isWeakOnlyGroup(candidate)) {
                            // Same rule the full scan uses: a .git-only dir with
                            // sub-projects is a group, not an aggregate project.
                            negativeCache.add(cwd)
                            continue
                        }

                        sendEvent({ type: 'status', message: `Discovering: ${candidate}` })
                        const scanner = new ProjectScanner({ scanRoots: SCAN_ROOTS })
                        const meta = await scanner.processProject(candidate)
                        if (meta) {
                            projectMap.set(candidate, meta)
                            discovered.push(candidate)
                            sendEvent({ type: 'discovered', directory: candidate, project_name: meta.project_name })
                        } else {
                            negativeCache.add(cwd)
                        }
                    } catch (err) {
                        sendEvent({ type: 'discover_error', directory: cwd, message: err.message })
                        negativeCache.add(cwd)
                    }
                }

                // Git refresh for projects with a running process + freshly discovered ones
                const activeDirs = new Set([...Object.keys(processMap), ...discovered])
                const activeProjects = [...activeDirs].map(d => projectMap.get(d)).filter(Boolean)

                sendEvent({ type: 'status', message: `Refreshing ${activeProjects.length} active projects`, total: activeProjects.length })

                let current = 0
                for (const project of activeProjects) {
                    current++
                    sendEvent({ type: 'refreshing', directory: project.directory, current, total: activeProjects.length })
                    const [gitInfo, lastModified] = await Promise.all([
                        getGitInfo(project.directory),
                        getLatestMtime(project.directory)
                    ])
                    project.git_info = gitInfo
                    project.last_modified = lastModified
                    projectMap.set(project.directory, project)
                }

                // Single JSONL write
                sendEvent({ type: 'status', message: 'Saving...' })
                const lines = Array.from(projectMap.values()).map(p => JSON.stringify(p))
                await fs.writeFile(DATA_FILE, lines.join('\n') + '\n')

                // Regroup so newly discovered projects claim their processes in the payload
                const finalProcesses = discovered.length > 0
                    ? (await collectProjectProcesses([...projectMap.keys()])).projects
                    : processMap

                const duration = Math.round((Date.now() - startTime) / 1000)
                sendEvent({
                    type: 'complete',
                    success: true,
                    projectCount: activeProjects.length,
                    discovered,
                    processes: finalProcesses,
                    duration
                })

            } catch (error) {
                const duration = Math.round((Date.now() - startTime) / 1000)
                sendEvent({ type: 'error', message: error.message, duration })
            } finally {
                controller.close()
            }
        }
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    })
}

export async function GET() {
    return Response.json({
        message: 'Combined refresh: process detection, project auto-discovery, git refresh for active projects',
        method: 'POST'
    })
}
