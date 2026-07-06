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

/**
 * True if `dir` is a "weak-only group" the way the full scanner sees it:
 * it has no strong indicator, only the weak `.git` indicator, AND at least
 * one immediate subdirectory itself has a project indicator. The scanner
 * (discoverProjects in scanner/index.mjs) skips indexing such dirs as an
 * aggregate project and recurses into the sub-projects instead — this
 * mirrors that rule (immediate subdirs only, matching classifySubDirs'
 * one-level check in the scanner).
 */
export async function isWeakOnlyGroup(dir) {
    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return false
    }
    const names = entries.map(e => e.name)
    const nameSet = new Set(names)
    const hasStrong = [...STRONG_PROJECT_INDICATORS].some(i => nameSet.has(i))
    if (hasStrong) return false
    const hasWeak = [...WEAK_PROJECT_INDICATORS].some(i => nameSet.has(i))
    if (!hasWeak) return false

    const ignoreSet = new Set([...DEFAULT_IGNORE_PATTERNS].map(p => p.toLowerCase()))
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        if (ignoreSet.has(entry.name.toLowerCase())) continue
        const subPath = path.join(dir, entry.name)
        if (await dirHasProjectIndicator(subPath)) return true
    }
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
