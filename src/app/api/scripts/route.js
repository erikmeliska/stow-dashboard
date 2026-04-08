import { readFile, readdir } from 'fs/promises'
import path from 'path'

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    if (!directory) {
        return Response.json({ error: 'Directory is required' }, { status: 400 })
    }

    const scripts = {}

    // Read package.json scripts
    try {
        const packageJsonPath = path.join(directory, 'package.json')
        const content = await readFile(packageJsonPath, 'utf-8')
        const packageData = JSON.parse(content)
        Object.assign(scripts, packageData.scripts || {})
    } catch {
        // No package.json or invalid
    }

    // Find shell scripts in project root
    try {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.sh')) {
                scripts[entry.name] = `./${entry.name}`
            }
        }
    } catch {
        // Can't read directory
    }

    return Response.json({ scripts })
}
