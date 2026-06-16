import fs from 'fs/promises'
import path from 'path'
import {
    getRunningProcesses,
    getProcTable,
    getClaudeAndTerminalSessions,
    getDockerContainers,
    matchProcessToProject
} from '@/lib/processes.mjs'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

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

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    try {
        const { procTable, childCount } = await getProcTable()

        const [runningProcesses, dockerContainers, terminalsAndClaude, projectDirs] = await Promise.all([
            getRunningProcesses(procTable),
            getDockerContainers(),
            getClaudeAndTerminalSessions(procTable, childCount),
            getProjectDirectories()
        ])
        const { claudeSessions, openTerminals } = terminalsAndClaude

        // Group processes by project directory
        const projectProcesses = {}

        // Add regular processes
        for (const proc of runningProcesses) {
            const matchedDir = matchProcessToProject(proc.cwd, projectDirs)

            if (matchedDir) {
                if (!projectProcesses[matchedDir]) {
                    projectProcesses[matchedDir] = []
                }
                projectProcesses[matchedDir].push({
                    pid: parseInt(proc.pid),
                    command: proc.command,
                    ports: proc.ports,
                    type: 'process',
                    host: proc.host,
                    hostLabel: proc.hostLabel
                })
            }
        }

        // Add Claude CLI sessions
        for (const session of claudeSessions) {
            const matchedDir = matchProcessToProject(session.cwd, projectDirs)

            if (matchedDir) {
                if (!projectProcesses[matchedDir]) {
                    projectProcesses[matchedDir] = []
                }
                projectProcesses[matchedDir].push({
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

        // Add idle open terminals
        for (const term of openTerminals) {
            const matchedDir = matchProcessToProject(term.cwd, projectDirs)

            if (matchedDir) {
                if (!projectProcesses[matchedDir]) {
                    projectProcesses[matchedDir] = []
                }
                projectProcesses[matchedDir].push({
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

        // Add Docker containers
        for (const container of dockerContainers) {
            const matchedDir = matchProcessToProject(container.cwd, projectDirs)

            if (matchedDir) {
                if (!projectProcesses[matchedDir]) {
                    projectProcesses[matchedDir] = []
                }
                projectProcesses[matchedDir].push({
                    id: container.id,
                    name: container.name,
                    image: container.image,
                    ports: container.ports,
                    status: container.status,
                    type: 'docker'
                })
            }
        }

        if (directory) {
            return Response.json({
                directory,
                processes: projectProcesses[directory] || []
            })
        }

        return Response.json({
            projects: projectProcesses,
            timestamp: new Date().toISOString()
        })
    } catch (error) {
        return Response.json({
            error: 'Failed to get process info',
            details: error.message
        }, { status: 500 })
    }
}
