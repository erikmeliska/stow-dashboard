/**
 * Cheap git working-tree status for the refresh cycle.
 *
 * The full `getGitInfo()` used by the scanner walks up to 1000 commits and
 * spawns half a dozen git processes per repo — fine for a scan, far too heavy
 * to run over every known project every 60 seconds. A single
 * `git status --porcelain=v2 --branch` gives everything the table's git
 * columns actually show (branch, ahead/behind, tracking, dirty count) plus the
 * HEAD sha, in one spawn. The sha is what lets the caller decide whether the
 * expensive walk is needed at all: if HEAD hasn't moved, commit counts and
 * remotes can't have changed either.
 *
 * `--no-optional-locks` keeps this read-only: git skips refreshing (and
 * relocking) the on-disk index, so polling hundreds of repos never writes to
 * them or collides with a git command the user is running by hand.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// `-u` (--untracked-files=all) matters for parity: without it git collapses an
// untracked directory into a single entry, while the full scan's simple-git
// call counts every file inside it. Mismatched counts would make the
// "Uncommitted" column jump depending on which pass last touched the project.
export const GIT_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-u']

/**
 * Parse `git status --porcelain=v2 --branch` output into the subset of
 * `git_info` fields a status-only refresh can know about.
 */
export function parseGitStatus(stdout) {
    let headSha = null
    let branch = 'unknown'
    let hasUpstream = false
    let ahead = 0
    let behind = 0
    let changes = 0

    for (const line of String(stdout).split('\n')) {
        if (!line) continue

        if (line.startsWith('# ')) {
            const space = line.indexOf(' ', 2)
            const key = space === -1 ? line.slice(2) : line.slice(2, space)
            const value = space === -1 ? '' : line.slice(space + 1)

            if (key === 'branch.oid') {
                // '(initial)' — a repo with no commits yet.
                headSha = value === '(initial)' ? null : value
            } else if (key === 'branch.head') {
                // 'HEAD' for a detached checkout is what simple-git reports, so
                // the full scan and this pass agree on the branch label.
                branch = value === '(detached)' ? 'HEAD' : value
            } else if (key === 'branch.upstream') {
                hasUpstream = true
            } else if (key === 'branch.ab') {
                const m = /^\+(\d+) -(\d+)$/.exec(value)
                if (m) {
                    ahead = Number(m[1])
                    behind = Number(m[2])
                }
            }
            continue
        }

        // Entry lines: '1' changed, '2' renamed/copied, 'u' unmerged,
        // '?' untracked. ('!' ignored only appears with --ignored.)
        const kind = line[0]
        if (kind === '1' || kind === '2' || kind === 'u' || kind === '?') changes++
    }

    return {
        head_sha: headSha,
        current_branch: branch,
        ahead,
        behind,
        has_remote_tracking: hasUpstream,
        uncommitted_changes: changes,
        is_clean: changes === 0,
    }
}

/**
 * Read the status of one repo. Returns null when the directory isn't a git
 * repo, git isn't installed, or the call fails — callers then leave whatever
 * git_info they already had untouched rather than blanking it.
 */
export async function readGitStatus(directory, { exec = execFileAsync } = {}) {
    try {
        const { stdout } = await exec('git', ['-C', directory, ...GIT_STATUS_ARGS], {
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20_000,
        })
        return parseGitStatus(stdout)
    } catch {
        return null
    }
}

/**
 * Refresh one project's `git_info` in place from a working-tree status alone,
 * escalating to `fullGitInfo` (the expensive commit walk) only when the status
 * says something more than the working tree changed. Returns whether git_info
 * was touched.
 *
 * HEAD's sha is the escalation trigger: commit counts, dates and remotes can't
 * change while HEAD sits still, so a moved HEAD — or a directory that has
 * become a repo since the last scan — is the only case worth paying for. When
 * there is no stored sha to compare against (a ledger written before this
 * field existed) that counts as "no news", so the first cycle after an upgrade
 * doesn't kick off a log walk over every repo at once.
 *
 * `fullGitInfo` is injected rather than imported: the full walk lives in the
 * scan routes, and this module must stay free of that dependency.
 */
export async function refreshProjectGit(project, { fullGitInfo, readStatus = readGitStatus } = {}) {
    const previous = project.git_info || {}
    const status = await readStatus(project.directory)

    // Not a repo, or git failed — leave whatever the last full scan recorded
    // rather than blanking the project's git columns.
    if (!status) return false

    const headMoved = Boolean(previous.head_sha) && previous.head_sha !== status.head_sha
    if (headMoved || !previous.git_detected) {
        project.git_info = await fullGitInfo(project.directory)
        return true
    }

    const merged = { ...previous, ...status, git_detected: true }
    // Drop any stale error: git just answered.
    delete merged.git_error
    project.git_info = merged
    return true
}
