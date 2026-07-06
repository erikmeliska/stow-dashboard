import fs from 'fs/promises'
import path from 'path'
import { collectProjectProcesses } from '@/lib/processes.mjs'

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
        const projectDirs = await getProjectDirectories()
        const { projects } = await collectProjectProcesses(projectDirs)

        if (directory) {
            return Response.json({
                directory,
                processes: projects[directory] || []
            })
        }

        return Response.json({
            projects,
            timestamp: new Date().toISOString()
        })
    } catch (error) {
        return Response.json({
            error: 'Failed to get process info',
            details: error.message
        }, { status: 500 })
    }
}
