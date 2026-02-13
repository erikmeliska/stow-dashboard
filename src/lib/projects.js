import fs from 'fs/promises'
import path from 'path'

export async function readProjectsData() {
    try {
        const dataPath = path.join(process.cwd(), 'data/projects_metadata.jsonl')
        const fileContent = await fs.readFile(dataPath, 'utf-8')
        
        // Parse JSONL file
        const projects = fileContent
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
        
        return projects
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error reading projects data:', error)
        }
        return []
    }
} 