/**
 * Project auto-discovery: resolve an unmatched process cwd to the project
 * directory it belongs to, using the scanner's indicator rules.
 * Pure logic — the /api/scan/quick route orchestrates scanning/persistence.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
    STRONG_PROJECT_INDICATORS,
    WEAK_PROJECT_INDICATORS,
    DEFAULT_IGNORE_PATTERNS,
} from '../scanner/index.mjs'

export async function dirHasProjectIndicator(dir) {
    let entries
    try {
        entries = await fs.readdir(dir)
    } catch {
        return false
    }
    const names = new Set(entries)
    for (const i of STRONG_PROJECT_INDICATORS) if (names.has(i)) return true
    for (const i of WEAK_PROJECT_INDICATORS) if (names.has(i)) return true
    return false
}

/** True if any path segment between root and cwd is hidden or ignored. */
export function isExcludedPath(cwd, root, ignorePatterns = DEFAULT_IGNORE_PATTERNS) {
    const rel = path.relative(root, cwd)
    if (!rel || rel.startsWith('..')) return false
    const ignoreSet = new Set([...ignorePatterns].map(p => String(p).toLowerCase()))
    return rel.split(path.sep).some(seg =>
        seg.startsWith('.') || ignoreSet.has(seg.toLowerCase())
    )
}

/**
 * Walk from cwd up to (not including) its scan root; return the nearest
 * directory with a project indicator, or null.
 */
export async function resolveCandidateRoot(cwd, scanRoots) {
    const root = scanRoots.find(r => cwd === r || cwd.startsWith(r + path.sep))
    if (!root || cwd === root) return null
    if (isExcludedPath(cwd, root)) return null

    let dir = cwd
    while (dir !== root && dir.length > root.length) {
        if (await dirHasProjectIndicator(dir)) return dir
        dir = path.dirname(dir)
    }
    return null
}

/** In-memory negative cache: "this cwd was checked recently, skip it". */
export class NegativeCache {
    constructor(ttlMs = 5 * 60 * 1000) {
        this.ttlMs = ttlMs
        this.map = new Map()
    }

    has(key) {
        const t = this.map.get(key)
        if (t === undefined) return false
        if (Date.now() - t > this.ttlMs) {
            this.map.delete(key)
            return false
        }
        return true
    }

    add(key) {
        this.map.set(key, Date.now())
    }
}
