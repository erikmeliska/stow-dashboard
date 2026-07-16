import { promises as fs } from 'fs'
import { NextResponse } from 'next/server'
import { envFile } from '@/lib/state-dir.mjs'

const SETTINGS_KEYS = ['SCAN_ROOTS', 'BASE_DIR', 'TERMINAL_APP', 'IDE_COMMAND', 'TERMINAL_APPS', 'IDE_COMMANDS']

function parseEnvFile(content) {
    const settings = {}
    for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIndex = trimmed.indexOf('=')
        if (eqIndex === -1) continue
        const key = trimmed.slice(0, eqIndex).trim()
        const value = trimmed.slice(eqIndex + 1).trim()
        if (SETTINGS_KEYS.includes(key)) {
            settings[key] = value
        }
    }
    return settings
}

export async function GET() {
    try {
        const content = await fs.readFile(envFile(), 'utf-8')
        return NextResponse.json(parseEnvFile(content))
    } catch {
        return NextResponse.json({})
    }
}

export async function POST(request) {
    const newSettings = await request.json()
    const envPath = envFile()

    // Read existing file to preserve comments and unknown keys
    let lines = []
    try {
        const content = await fs.readFile(envPath, 'utf-8')
        lines = content.split('\n')
    } catch {
        // File doesn't exist, start fresh
    }

    // Update or add each setting
    const updated = new Set()
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIndex = trimmed.indexOf('=')
        if (eqIndex === -1) continue
        const key = trimmed.slice(0, eqIndex).trim()
        if (key in newSettings) {
            lines[i] = `${key}=${newSettings[key]}`
            updated.add(key)
        }
    }

    // Add new keys that weren't in the file
    for (const [key, value] of Object.entries(newSettings)) {
        if (!updated.has(key) && SETTINGS_KEYS.includes(key)) {
            lines.push(`${key}=${value}`)
        }
    }

    await fs.writeFile(envPath, lines.join('\n'))

    // Update process.env so changes take effect immediately
    for (const [key, value] of Object.entries(newSettings)) {
        if (SETTINGS_KEYS.includes(key)) {
            process.env[key] = value
        }
    }

    return NextResponse.json({ success: true })
}
