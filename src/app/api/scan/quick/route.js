import path from 'path'
import fs from 'fs/promises'
import { simpleGit } from 'simple-git'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

async function getRunningProjectDirs() {
    // Import the process detection logic
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    const runningDirs = new Set()

    try {
        // Get processes with listening ports
        const { stdout: lsofOut } = await execAsync('lsof -i -P -n 2>/dev/null | grep LISTEN || true')
        const pids = new Set()

        for (const line of lsofOut.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const pid = parts[1]
            if (pid) pids.add(pid)
        }

        // Get cwd for these PIDs
        if (pids.size > 0) {
            const pidList = Array.from(pids).join(',')
            const { stdout: cwdOut } = await execAsync(`lsof -a -p ${pidList} -d cwd -F n 2>/dev/null || true`)

            for (const line of cwdOut.split('\n')) {
                if (line.startsWith('n')) {
                    runningDirs.add(line.slice(1))
                }
            }
        }

        // Get Docker containers with compose working dirs
        try {
            const { stdout: dockerOut } = await execAsync(
                `docker ps --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true`,
                { timeout: 5000 }
            )
            for (const dir of dockerOut.split('\n').filter(Boolean)) {
                runningDirs.add(dir)
            }
        } catch {
            // Docker not available
        }
    } catch {
        // Ignore errors
    }

    return runningDirs
}

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

                // Get running project directories
                sendEvent({ type: 'status', message: 'Finding active projects...' })
                const runningDirs = await getRunningProjectDirs()

                // Find which projects have running processes
                const activeProjects = []
                for (const project of projects) {
                    for (const runningDir of runningDirs) {
                        if (runningDir === project.directory || runningDir.startsWith(project.directory + '/')) {
                            activeProjects.push(project)
                            break
                        }
                    }
                }

                sendEvent({ type: 'status', message: `Found ${activeProjects.length} active projects`, total: activeProjects.length })

                // Update git info for active projects
                let current = 0
                for (const project of activeProjects) {
                    current++
                    sendEvent({ type: 'refreshing', directory: project.directory, current, total: activeProjects.length })

                    const gitInfo = await getGitInfo(project.directory)
                    project.git_info = gitInfo
                    project.last_modified = new Date().toISOString()

                    projectMap.set(project.directory, project)
                }

                // Write back to JSONL
                sendEvent({ type: 'status', message: 'Saving...' })
                const lines = Array.from(projectMap.values()).map(p => JSON.stringify(p))
                await fs.writeFile(DATA_FILE, lines.join('\n') + '\n')

                const duration = Math.round((Date.now() - startTime) / 1000)
                sendEvent({ type: 'complete', success: true, projectCount: activeProjects.length, duration })

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
        message: 'Quick refresh - updates git info only for projects with running processes',
        method: 'POST'
    })
}
