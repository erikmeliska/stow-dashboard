import { promises as fs } from 'fs'
import path from 'path'
import { ProjectTable } from './project-table'
import { readProjectsData } from '@/lib/projects'
import { ScanControls } from '@/components/ScanControls'

export const dynamic = 'force-dynamic'

const BASE_DIR = '/Users/ericsko/Projekty'
const OWN_REPOS = ['boys-from-heaven', 'boysfromheaven', 'erikmeliska', 'intelimail']
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README', 'readme']
const SYNC_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

async function checkReadmeExists(directory) {
    for (const name of README_NAMES) {
        try {
            await fs.access(path.join(directory, name))
            return true
        } catch {
            // Continue to next variant
        }
    }
    return false
}

async function getLastSyncTime() {
    try {
        const stat = await fs.stat(SYNC_FILE)
        return stat.mtime.toISOString()
    } catch {
        return null
    }
}

export default async function DashboardPage() {
    const [projects, lastSyncTime] = await Promise.all([
        readProjectsData(),
        getLastSyncTime()
    ])

    const processedProjects = await Promise.all(projects.map(async project => {
        const relativePath = project.directory.replace(BASE_DIR, '')
        const parts = relativePath.split('/')
        const groupParts = parts.filter(Boolean).slice(0, -1)
        const projectDir = parts[parts.length - 1]
        const hasReadme = await checkReadmeExists(project.directory)

        return {
            ...project,
            groupParts,
            projectDir,
            hasReadme
        }
    }))
    
    return (
        <div className="container mx-auto py-10">
            <div className="flex items-start justify-between mb-5">
                <h1 className="text-3xl font-bold">Project Dashboard</h1>
                <ScanControls lastSyncTime={lastSyncTime} />
            </div>
            <ProjectTable
                projects={processedProjects}
                ownRepos={OWN_REPOS}
            />
        </div>
    )
}