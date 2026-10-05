/**
 * The scanner's side of `.stow/project.json` (virtual projects #9): a checkout
 * root without a remote identity gets a stable id, so the project survives a
 * move or rename. Schema, reader and writer are #8's (registry/stow-meta.mjs);
 * this only decides *when* to create the file. It never rewrites an existing
 * one — client/role in it are the user's — and a malformed file stays as is.
 * The writer adds `.stow/` to the repo's info/exclude so the Uncommitted
 * column doesn't jump by one for every no-remote repo.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readStowMeta, writeStowMeta, excludeFromGit } from './registry/stow-meta.mjs'

const execFileAsync = promisify(execFile)

/** Opt-out: STOW_WRITE_PROJECT_FILES=0 → read existing ids, create none. */
export function stowWritesEnabled(env = process.env) {
    return env.STOW_WRITE_PROJECT_FILES !== '0'
}

/**
 * → { id, created, error }. `error` is a reason string (malformed file,
 * EACCES, …); the caller falls back to a `path:` identity and keeps going.
 * `exec` follows the scanner's convention (resolves `{ stdout }`).
 */
export async function ensureStowFile(root, {
    git = false, exec = execFileAsync, enabled = stowWritesEnabled(), recheckExclude = false,
} = {}) {
    // A non-git root has no info/exclude to update; don't spawn git for it.
    const stowExec = git
        ? async (cmd, args) => (await exec(cmd, args)).stdout
        : async () => { throw new Error('not a git work tree') }
    const { meta, warnings } = await readStowMeta(root)
    if (meta) {
        // The exclude line is added when the file is created; a root that
        // became a repo later (git init) or whose exclude write failed gets
        // it here. The caller asks only for dirty work trees, to stay cheap.
        if (git && recheckExclude) await excludeFromGit(root, { exec: stowExec }).catch(() => {})
        return { id: meta.id, created: false, error: null }
    }
    if (warnings.length) return { id: null, created: false, error: warnings[0] }
    if (!enabled) return { id: null, created: false, error: null }
    try {
        const written = await writeStowMeta(root, {}, { exec: stowExec })
        return { id: written.id, created: true, error: null }
    } catch (err) {
        // The writer renames the file into place before updating info/exclude:
        // if only that last step failed, the id on disk is still good.
        const again = await readStowMeta(root)
        if (again.meta) return { id: again.meta.id, created: true, error: err.code || err.message }
        return { id: null, created: false, error: err.code || err.message }
    }
}
