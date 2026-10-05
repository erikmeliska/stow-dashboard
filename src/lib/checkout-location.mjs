/**
 * Where a ledger row's checkout lives (virtual projects #9). A "checkout" is
 * one git work tree (`git rev-parse --show-toplevel`: linked worktrees and
 * submodules each have their own) or, outside git, the row's own directory.
 * Sub-folders of one repo share a root — that is what stops btstack's 49 rows
 * from looking like 49 copies. The root need not be a ledger row itself
 * (weak-only groups such as eranet3-analyza).
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Semaphore } from './semaphore.mjs'

const execFileAsync = promisify(execFile)

// Same fan-out as the quick refresh's GIT_CONCURRENCY.
export const LOCATION_CONCURRENCY = 16

export async function resolveLocation(directory, { exec = execFileAsync } = {}) {
    let top = '', common = ''
    try {
        const { stdout } = await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel', '--git-common-dir'])
        ;[top = '', common = ''] = String(stdout).split('\n').map(s => s.trim())
    } catch {
        top = ''
    }
    if (!top) return { root: directory, subpath: '', git: false }
    let loc
    const subpath = path.relative(top, directory)
    // macOS reports the realpath: a scan root reached through a symlink would
    // give `../…`. Keep the row's own directory as the root then.
    if (subpath.startsWith('..') || path.isAbsolute(subpath)) loc = { root: directory, subpath: '', git: true }
    else loc = { root: top, subpath, git: true }
    // A linked worktree shares the main work tree's repo; `main` is where a
    // no-remote project's .stow id lives, so every worktree gets the same one.
    if (common) {
        const gitDir = path.resolve(directory, common)
        const main = path.dirname(gitDir)
        if (path.basename(gitDir) === '.git' && main !== loc.root) loc.main = main
    }
    return loc
}

/** Sets `row.checkout` on rows that lack one (all rows with `force`). */
export async function resolveLocations(rows, { exec, concurrency = LOCATION_CONCURRENCY, force = false } = {}) {
    const limiter = new Semaphore(concurrency)
    await Promise.all(rows
        .filter(r => force || !r.checkout)
        .map(row => limiter.run(async () => {
            row.checkout = await resolveLocation(row.directory, exec ? { exec } : {})
        })))
}
