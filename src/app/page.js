import { promises as fs } from 'fs'
import Link from 'next/link'
import { ProjectTable } from './project-table'
import { readProjectsData } from '@/lib/projects'
import { readTasks } from '@/lib/tasks.mjs'
import { ScanControls } from '@/components/ScanControls'
import { SettingsDialog } from '@/components/SettingsDialog'
import { ThemeToggle } from '@/components/ThemeToggle'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { getBaseDir } from '@/lib/scan-roots.mjs'
import { ledgerFile, dataFile } from '@/lib/state-dir.mjs'

export const dynamic = 'force-dynamic'

const OWN_REPOS = ['boys-from-heaven', 'boysfromheaven', 'erikmeliska', 'intelimail']
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README', 'readme']

async function readUsageData() {
    try {
        return JSON.parse(await fs.readFile(dataFile('usage.json'), 'utf8'))
    } catch {
        return { projects: {} }
    }
}

async function checkReadmeExists(directory) {
    for (const name of README_NAMES) {
        try {
            await fs.access(`${directory}/${name}`)
            return true
        } catch {
            // Continue to next variant
        }
    }
    return false
}

async function getLastSyncTime() {
    try {
        const stat = await fs.stat(ledgerFile())
        return stat.mtime.toISOString()
    } catch {
        return null
    }
}

export default async function DashboardPage() {
    const [projects, lastSyncTime, usageData] = await Promise.all([
        readProjectsData(),
        getLastSyncTime(),
        readUsageData()
    ])

    // Build a directory → open-task-count map once. Resilient: any failure → 0.
    const openTaskCounts = new Map()
    await Promise.all(projects.map(async project => {
        try {
            const tasks = await readTasks(project.directory)
            openTaskCounts.set(project.directory, tasks.filter(t => !t.done).length)
        } catch {
            openTaskCounts.set(project.directory, 0)
        }
    }))

    const baseDir = getBaseDir()
    const processedProjects = await Promise.all(projects.map(async project => {
        const relativePath = project.directory.replace(baseDir, '')
        const parts = relativePath.split('/')
        const groupParts = parts.filter(Boolean).slice(0, -1)
        const projectDir = parts[parts.length - 1]
        const hasReadme = await checkReadmeExists(project.directory)

        return {
            ...project,
            groupParts,
            projectDir,
            hasReadme,
            openTaskCount: openTaskCounts.get(project.directory) || 0,
            usage: usageData.projects?.[project.directory]
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
                    <div className="flex items-center gap-4">
                        <h1 className="text-xl font-bold pt-1">Project Dashboard</h1>
                        <Link href="/tasks" className="text-sm text-muted-foreground hover:text-foreground transition-colors pt-1">
                            Tasks
                        </Link>
                        <Link href="/completed" className="text-sm text-muted-foreground hover:text-foreground transition-colors pt-1">
                            Completed
                        </Link>
                    </div>
                    <div className="flex items-start gap-3">
                        <ScanControls lastSyncTime={lastSyncTime} />
                        <SettingsDialog />
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