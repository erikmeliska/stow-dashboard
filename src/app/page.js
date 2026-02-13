import { promises as fs } from 'fs'
import path from 'path'
import { ProjectTable } from './project-table'
import { readProjectsData } from '@/lib/projects'
import { ScanControls } from '@/components/ScanControls'
import { ThemeToggle } from '@/components/ThemeToggle'
import { WelcomeScreen } from '@/components/WelcomeScreen'

export const dynamic = 'force-dynamic'

const BASE_DIR = process.env.BASE_DIR || '/Users/ericsko/Projekty'
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
    
    if (processedProjects.length === 0) {
        const scanRoots = process.env.SCAN_ROOTS || ''
        const baseDir = process.env.BASE_DIR || ''
        const terminalApp = process.env.TERMINAL_APP || 'Terminal'
        const ideCommand = process.env.IDE_COMMAND || 'code'

        return (
            <div className="h-screen flex flex-col overflow-hidden">
                <div className="flex-none px-4 py-2 border-b">
                    <div className="flex items-start justify-between">
                        <h1 className="text-xl font-bold pt-1">Project Dashboard</h1>
                        <ThemeToggle />
                    </div>
                </div>
                <WelcomeScreen
                    initialConfig={{
                        SCAN_ROOTS: scanRoots,
                        BASE_DIR: baseDir,
                        TERMINAL_APP: terminalApp,
                        IDE_COMMAND: ideCommand
                    }}
                />
            </div>
        )
    }

    return (
        <div className="h-screen flex flex-col overflow-hidden">
            <div className="flex-none px-4 py-2 border-b">
                <div className="flex items-start justify-between">
                    <h1 className="text-xl font-bold pt-1">Project Dashboard</h1>
                    <div className="flex items-start gap-3">
                        <ScanControls lastSyncTime={lastSyncTime} />
                        <ThemeToggle />
                    </div>
                </div>
            </div>
            <div className="flex-1 overflow-hidden px-4 relative">
                <div id="scan-logs-portal" className="absolute top-2 right-4 z-10" />
                <ProjectTable
                    projects={processedProjects}
                    ownRepos={OWN_REPOS}
                />
            </div>
        </div>
    )
}