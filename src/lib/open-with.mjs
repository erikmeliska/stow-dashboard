/**
 * Open-with configuration: which IDE commands and terminal apps the
 * dashboard may launch. Read from .env.local PER REQUEST (merged over
 * process.env) so the settings dialog applies without a server restart.
 * The lists double as the security allowlist for /api/open-with.
 */

import fs from 'node:fs/promises'

const HARD_DEFAULTS = { ide: 'code', terminal: 'Terminal' }

export function parseAppList(listValue, legacyValue, hardDefault) {
    const raw = (listValue ?? '').trim()
    if (raw) {
        const items = raw.split(',').map(s => s.trim()).filter(Boolean)
        if (items.length) return items
    }
    const legacy = (legacyValue ?? '').trim()
    if (legacy) return [legacy]
    return [hardDefault]
}

export function isAllowedApp(app, list) {
    return list.includes(app)
}

function parseEnvContent(content) {
    const vars = {}
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const pos = line.indexOf('=')
        if (pos === -1) continue
        const value = line.slice(pos + 1).trim()
        vars[line.slice(0, pos).trim()] = value.replace(/^(['"])(.*)\1$/, '$2')
    }
    return vars
}

export async function readOpenWithEnv(envPath) {
    let fileVars = {}
    try {
        fileVars = parseEnvContent(await fs.readFile(envPath, 'utf-8'))
    } catch {
        // No .env.local — process.env / defaults apply
    }
    const get = (key) => fileVars[key] ?? process.env[key]
    return {
        ide: parseAppList(get('IDE_COMMANDS'), get('IDE_COMMAND'), HARD_DEFAULTS.ide),
        terminal: parseAppList(get('TERMINAL_APPS'), get('TERMINAL_APP'), HARD_DEFAULTS.terminal),
    }
}
