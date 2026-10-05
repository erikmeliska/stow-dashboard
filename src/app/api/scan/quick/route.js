import fs from 'fs/promises'
import path from 'path'
import { simpleGit } from 'simple-git'
import { getLatestMtime, ProjectScanner, Semaphore } from '@/scanner/index.mjs'
import { collectProjectProcesses } from '@/lib/processes.mjs'
import { resolveCandidateRoot, NegativeCache, dirHasProjectIndicator, isWeakOnlyGroup } from '@/lib/discovery.mjs'
import { getScanRoots } from '@/lib/scan-roots.mjs'
import { updateUsage, defaultUsagePaths } from '@/lib/usage.mjs'
import { runIngest } from '@/lib/cc/ingest-run.mjs'
import { refreshProjectGit } from '@/lib/git-status.mjs'
import { ledgerFile } from '@/lib/state-dir.mjs'

// How many `git status` calls the working-tree pass keeps in flight. Each is
// one short-lived process, so this is about not stampeding the disk, not fds.
const GIT_CONCURRENCY = 16

// Read per-request so a SCAN_ROOTS change from the Settings dialog applies
// without a server restart; strip trailing slashes for path-prefix matching.
const scanRoots = () => getScanRoots().map(s => s.replace(/\/+$/, ''))

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
        } catch { /* best effort */ }

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
        } catch { /* best effort */ }

        return {
            project_created: firstCommit?.date || null,
            head_sha: lastCommit?.hash || null,
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

// A `.git` entry in the project root — a directory for a normal clone, a file
// for a worktree or submodule, so a plain access() check covers both.
async function hasGitDir(directory) {
    try {
        await fs.access(path.join(directory, '.git'))
        return true
    } catch {
        return false
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
                const SCAN_ROOTS = scanRoots()
                // Resolve once per cycle so the read and the write below can't
                // straddle two different state dirs.
                const dataFile = ledgerFile()
                // Load existing projects
                const content = await fs.readFile(dataFile, 'utf-8')
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

                // Git refresh. Projects with a running process (plus the ones just
                // discovered) are "active": they get the full treatment — commit walk
                // and a tree-mtime pass. Every *other* project that still has a .git on
                // disk gets a working-tree status refresh, so a Refresh brings the
                // branch/ahead/behind/dirty columns up to date for the whole table, not
                // just for whatever happens to be running.
                const activeDirs = new Set([...Object.keys(processMap), ...discovered])
                const activeProjects = [...activeDirs].map(d => projectMap.get(d)).filter(Boolean)

                const gitProjects = []
                for (const project of projectMap.values()) {
                    if (activeDirs.has(project.directory)) continue
                    if (await hasGitDir(project.directory)) gitProjects.push(project)
                }

                const total = activeProjects.length + gitProjects.length
                sendEvent({
                    type: 'status',
                    message: `Refreshing ${activeProjects.length} active + ${gitProjects.length} git projects`,
                    total
                })

                let current = 0
                const progress = (directory) => {
                    current++
                    sendEvent({ type: 'refreshing', directory, current, total })
                }

                for (const project of activeProjects) {
                    progress(project.directory)
                    const [gitInfo, lastModified] = await Promise.all([
                        getGitInfo(project.directory),
                        getLatestMtime(project.directory)
                    ])
                    project.git_info = gitInfo
                    project.last_modified = lastModified
                    projectMap.set(project.directory, project)
                }

                const gitLimiter = new Semaphore(GIT_CONCURRENCY)
                await Promise.all(gitProjects.map(project => gitLimiter.run(async () => {
                    try {
                        await refreshProjectGit(project, { fullGitInfo: getGitInfo })
                        projectMap.set(project.directory, project)
                    } catch {
                        // One unreadable repo must not abort the cycle.
                    }
                    progress(project.directory)
                })))

                // Single JSONL write
                sendEvent({ type: 'status', message: 'Saving...' })
                const lines = Array.from(projectMap.values()).map(p => JSON.stringify(p))
                await fs.writeFile(dataFile, lines.join('\n') + '\n')

                // Regroup so newly discovered projects claim their processes in the payload
                const finalProcesses = discovered.length > 0
                    ? (await collectProjectProcesses([...projectMap.keys()])).projects
                    : processMap

                // AI-usage ledger update (never fatal to the refresh cycle)
                try {
                    const usage = await updateUsage({ ...defaultUsagePaths(), projectDirs: [...projectMap.keys()] })
                    sendEvent({ type: 'usage_updated', ...usage })
                } catch (usageErr) {
                    sendEvent({ type: 'usage_error', message: usageErr.message })
                }

                // Claude Code session store (incremental; never fatal to the refresh cycle)
                try {
                    const cc = await runIngest()
                    sendEvent({ type: 'cc_ingested', ...cc })
                } catch (ccErr) {
                    sendEvent({ type: 'cc_ingest_error', message: ccErr.message })
                }

                const duration = Math.round((Date.now() - startTime) / 1000)
                sendEvent({
                    type: 'complete',
                    success: true,
                    projectCount: total,
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
        message: 'Combined refresh: process detection, project auto-discovery, git status for every project with a .git (full git walk for active ones)',
        method: 'POST'
    })
}
