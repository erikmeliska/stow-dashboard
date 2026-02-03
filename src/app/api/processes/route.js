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

async function getListeningPorts() {
    try {
        // Get all listening ports with their PIDs
        const { stdout } = await execAsync('lsof -i -P -n | grep LISTEN', { maxBuffer: 10 * 1024 * 1024 })
        const ports = {}

        for (const line of stdout.split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/)
            const command = parts[0]
            const pid = parts[1]
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)

            if (portMatch) {
                const port = portMatch[1]
                if (!ports[pid]) {
                    ports[pid] = { command, ports: [] }
                }
                if (!ports[pid].ports.includes(port)) {
                    ports[pid].ports.push(port)
                }
            }
        }

        return ports
    } catch {
        return {}
    }
}

async function getProcessInfo(pid) {
    try {
        // Get process details: cwd, start time, full command
        const { stdout } = await execAsync(`ps -p ${pid} -o lstart=,args=`)
        const line = stdout.trim()

        // Parse start time (first 24 chars typically)
        const startMatch = line.match(/^(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)/)
        const startTime = startMatch ? new Date(startMatch[1]) : null
        const args = startMatch ? line.slice(startMatch[0].length).trim() : line

        // Try to get cwd
        let cwd = null
        try {
            const { stdout: cwdOut } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`)
            cwd = cwdOut.trim() || null
        } catch {
            // cwd not available
        }

        return { startTime, args, cwd }
    } catch {
        return { startTime: null, args: null, cwd: null }
    }
}

async function findProcessesForDirectory(directory, listeningPorts) {
    const processes = []

    try {
        // Find processes that have files open in this directory
        const { stdout } = await execAsync(
            `lsof +D "${directory}" 2>/dev/null | grep -v "^COMMAND" | awk '{print $1, $2}' | sort -u`,
            { maxBuffer: 10 * 1024 * 1024, timeout: 5000 }
        )

        const seenPids = new Set()

        for (const line of stdout.split('\n').filter(Boolean)) {
            const [command, pid] = line.split(/\s+/)

            if (seenPids.has(pid)) continue
            seenPids.add(pid)

            // Skip common system processes
            if (['Finder', 'mds', 'mds_stores', 'mdworker', 'fseventsd', 'fseventsexchange'].includes(command)) {
                continue
            }

            const portInfo = listeningPorts[pid]
            const processInfo = await getProcessInfo(pid)

            processes.push({
                pid: parseInt(pid),
                command,
                ports: portInfo?.ports || [],
                startTime: processInfo.startTime?.toISOString() || null,
                args: processInfo.args,
                cwd: processInfo.cwd
            })
        }
    } catch {
        // lsof failed for this directory, likely no processes
    }

    return processes
}

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    try {
        const listeningPorts = await getListeningPorts()

        if (directory) {
            // Get processes for a specific directory
            const processes = await findProcessesForDirectory(directory, listeningPorts)
            return Response.json({ directory, processes })
        }

        // Get processes for all project directories
        const projectDirs = await getProjectDirectories()
        const results = {}

        // Process in batches to avoid overwhelming the system
        const batchSize = 10
        for (let i = 0; i < projectDirs.length; i += batchSize) {
            const batch = projectDirs.slice(i, i + batchSize)
            const batchResults = await Promise.all(
                batch.map(async (dir) => {
                    const processes = await findProcessesForDirectory(dir, listeningPorts)
                    return { dir, processes }
                })
            )

            for (const { dir, processes } of batchResults) {
                if (processes.length > 0) {
                    results[dir] = processes
                }
            }
        }

        return Response.json({
            projects: results,
            timestamp: new Date().toISOString()
        })
    } catch (error) {
        return Response.json({
            error: 'Failed to get process info',
            details: error.message
        }, { status: 500 })
    }
}
