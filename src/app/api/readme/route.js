import { promises as fs } from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    if (!directory) {
        return NextResponse.json({ error: 'Directory parameter required' }, { status: 400 })
    }

    // Hľadáme README v rôznych variantoch
    const readmeNames = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README', 'readme']

    for (const name of readmeNames) {
        const readmePath = path.join(directory, name)
        try {
            const content = await fs.readFile(readmePath, 'utf-8')
            return NextResponse.json({ content, filename: name })
        } catch {
            // Pokračujeme na ďalší variant
        }
    }

    return NextResponse.json({ error: 'README not found', content: null }, { status: 404 })
}
