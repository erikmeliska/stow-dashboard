import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)
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

async function getRunningProcesses() {
    const processes = new Map() // pid -> { command, ports, cwd }

    try {
        // Get all listening ports with PIDs - fast
        const { stdout: lsofOut } = await execAsync('lsof -i -P -n 2>/dev/null | grep LISTEN || true')

        for (const line of lsofOut.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const command = parts[0]
            const pid = parts[1]
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)

            if (portMatch && pid) {
                if (!processes.has(pid)) {
                    processes.set(pid, { pid, command, ports: [], cwd: null })
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
    } catch {
        // lsof failed
    }

    return Array.from(processes.values())
}

function matchProcessToProject(processCwd, projectDirs) {
    if (!processCwd) return null

    // Exact match or process cwd is inside project
    for (const dir of projectDirs) {
        if (processCwd === dir || processCwd.startsWith(dir + '/')) {
            return dir
        }
    }
    return null
}

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    try {
        const [runningProcesses, projectDirs] = await Promise.all([
            getRunningProcesses(),
            getProjectDirectories()
        ])

        // Group processes by project directory
        const projectProcesses = {}

        for (const proc of runningProcesses) {
            const matchedDir = matchProcessToProject(proc.cwd, projectDirs)

            if (matchedDir) {
                if (!projectProcesses[matchedDir]) {
                    projectProcesses[matchedDir] = []
                }
                projectProcesses[matchedDir].push({
                    pid: parseInt(proc.pid),
                    command: proc.command,
                    ports: proc.ports
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
