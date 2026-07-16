import fs from 'fs/promises'
import { ledgerFile } from './state-dir.mjs'

export async function readProjectsData() {
    try {
        const fileContent = await fs.readFile(ledgerFile(), 'utf-8')
        
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