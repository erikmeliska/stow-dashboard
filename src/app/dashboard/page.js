import { ProjectTable } from './project-table'
import { readProjectsData } from '@/lib/projects'

const BASE_DIR = '/Users/ericsko/Projekty'
const OWN_REPOS = ['boys-from-heaven', 'boysfromheaven', 'erikmeliska', 'intelimail']

export default async function DashboardPage() {
    const projects = await readProjectsData()
    
    const processedProjects = projects.map(project => {
        const relativePath = project.directory.replace(BASE_DIR, '')
        const parts = relativePath.split('/')
        const groupParts = parts.filter(Boolean).slice(0, -1)
        const projectDir = parts[parts.length - 1]

        return {
            ...project,
            groupParts,
            projectDir
        }
    })
    
    return (
        <div className="container mx-auto py-10">
            <h1 className="text-3xl font-bold mb-5">Project Dashboard</h1>
            <ProjectTable 
                projects={processedProjects} 
                ownRepos={OWN_REPOS}
            />
        </div>
    )
}