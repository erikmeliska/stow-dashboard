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
                    processes.set(pid, { pid, command, ports: [], cwd: null, type: 'process' })
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

async function getDockerContainers() {
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
        const [runningProcesses, dockerContainers, projectDirs] = await Promise.all([
            getRunningProcesses(),
            getDockerContainers(),
            getProjectDirectories()
        ])

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
                    type: 'process'
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
