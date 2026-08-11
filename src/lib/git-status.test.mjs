import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseGitStatus, readGitStatus, refreshProjectGit, GIT_STATUS_ARGS } from './git-status.mjs'

// A project as it sits in the ledger after a full scan: expensive fields
// (commit counts, remotes) alongside the cheap working-tree ones.
const scannedProject = (overrides = {}) => ({
    directory: '/repo',
    git_info: {
        git_detected: true,
        head_sha: 'old-sha',
        total_commits: 42,
        user_commits: 7,
        remotes: ['git@github.com:me/repo.git'],
        current_branch: 'main',
        ahead: 0,
        behind: 0,
        has_remote_tracking: true,
        uncommitted_changes: 0,
        is_clean: true,
        ...overrides,
    },
})

const statusOf = (fields) => async () => ({
    head_sha: 'old-sha',
    current_branch: 'main',
    ahead: 0,
    behind: 0,
    has_remote_tracking: true,
    uncommitted_changes: 0,
    is_clean: true,
    ...fields,
})

const failIfCalled = () => {
    throw new Error('full git walk should not have run')
}

test('parses a clean tracked branch', () => {
    const out = [
        '# branch.oid 1111111111111111111111111111111111111111',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +0 -0',
        '',
    ].join('\n')

    assert.deepEqual(parseGitStatus(out), {
        head_sha: '1111111111111111111111111111111111111111',
        current_branch: 'main',
        ahead: 0,
        behind: 0,
        has_remote_tracking: true,
        uncommitted_changes: 0,
        is_clean: true,
    })
})

test('counts changed, renamed, unmerged and untracked entries as uncommitted', () => {
    const out = [
        '# branch.oid 2222222222222222222222222222222222222222',
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +3 -7',
        '1 .M N... 100644 100644 100644 aaa bbb src/app.js',
        '2 R. N... 100644 100644 100644 ccc ddd R100 new.js\told.js',
        'u UU N... 100644 100644 100644 100644 eee fff ggg conflict.js',
        '? scratch.log',
        '',
    ].join('\n')

    const status = parseGitStatus(out)
    assert.equal(status.uncommitted_changes, 4)
    assert.equal(status.is_clean, false)
    assert.equal(status.current_branch, 'feature/x')
    assert.equal(status.ahead, 3)
    assert.equal(status.behind, 7)
})

test('reports no tracking branch when there is no upstream header', () => {
    const out = [
        '# branch.oid 3333333333333333333333333333333333333333',
        '# branch.head main',
        '',
    ].join('\n')

    const status = parseGitStatus(out)
    assert.equal(status.has_remote_tracking, false)
    assert.equal(status.ahead, 0)
    assert.equal(status.behind, 0)
})

test('handles a repo with no commits yet', () => {
    const out = ['# branch.oid (initial)', '# branch.head main', '? README.md', ''].join('\n')

    const status = parseGitStatus(out)
    assert.equal(status.head_sha, null)
    assert.equal(status.current_branch, 'main')
    assert.equal(status.uncommitted_changes, 1)
})

test('labels a detached HEAD the way the full scan does', () => {
    const out = ['# branch.oid 4444444444444444444444444444444444444444', '# branch.head (detached)', ''].join('\n')

    assert.equal(parseGitStatus(out).current_branch, 'HEAD')
})

test('asks for every untracked file so counts match the full scan', () => {
    assert.ok(GIT_STATUS_ARGS.includes('-u'))
})

test('readGitStatus scopes git to the directory and asks for a lock-free porcelain v2 status', async () => {
    const calls = []
    const exec = async (cmd, args) => {
        calls.push([cmd, args])
        return { stdout: '# branch.oid abc\n# branch.head main\n' }
    }

    const status = await readGitStatus('/tmp/some project', { exec })

    assert.deepEqual(calls, [['git', ['-C', '/tmp/some project', ...GIT_STATUS_ARGS]]])
    assert.equal(status.head_sha, 'abc')
})

test('readGitStatus returns null when git fails so callers keep the old git_info', async () => {
    const exec = async () => {
        throw new Error('not a git repository')
    }

    assert.equal(await readGitStatus('/tmp/nope', { exec }), null)
})

test('refreshProjectGit updates working-tree fields without walking the log', async () => {
    const project = scannedProject()

    const changed = await refreshProjectGit(project, {
        readStatus: statusOf({ uncommitted_changes: 3, is_clean: false, behind: 2 }),
        fullGitInfo: failIfCalled,
    })

    assert.equal(changed, true)
    assert.equal(project.git_info.uncommitted_changes, 3)
    assert.equal(project.git_info.is_clean, false)
    assert.equal(project.git_info.behind, 2)
    // Scan-only fields survive the cheap refresh.
    assert.equal(project.git_info.total_commits, 42)
    assert.deepEqual(project.git_info.remotes, ['git@github.com:me/repo.git'])
})

test('refreshProjectGit falls back to the full walk when HEAD moved', async () => {
    const project = scannedProject()

    const changed = await refreshProjectGit(project, {
        readStatus: statusOf({ head_sha: 'new-sha' }),
        fullGitInfo: async (dir) => ({ git_detected: true, head_sha: 'new-sha', total_commits: 43, walked: dir }),
    })

    assert.equal(changed, true)
    assert.equal(project.git_info.total_commits, 43)
    assert.equal(project.git_info.walked, '/repo')
})

test('refreshProjectGit does not walk a ledger written before head_sha existed', async () => {
    const project = scannedProject()
    delete project.git_info.head_sha

    await refreshProjectGit(project, {
        readStatus: statusOf({ head_sha: 'whatever' }),
        fullGitInfo: failIfCalled,
    })

    // The sha is recorded now, so the *next* cycle can detect a real move.
    assert.equal(project.git_info.head_sha, 'whatever')
    assert.equal(project.git_info.total_commits, 42)
})

test('refreshProjectGit runs the full walk for a directory that has become a repo', async () => {
    const project = { directory: '/repo', git_info: { git_detected: false } }

    await refreshProjectGit(project, {
        readStatus: statusOf({ head_sha: 'first' }),
        fullGitInfo: async () => ({ git_detected: true, head_sha: 'first', total_commits: 1 }),
    })

    assert.equal(project.git_info.git_detected, true)
    assert.equal(project.git_info.total_commits, 1)
})

test('refreshProjectGit leaves git_info alone when git cannot answer', async () => {
    const project = scannedProject()
    const before = project.git_info

    const changed = await refreshProjectGit(project, {
        readStatus: async () => null,
        fullGitInfo: failIfCalled,
    })

    assert.equal(changed, false)
    assert.equal(project.git_info, before)
})

test('refreshProjectGit clears a stale git_error once git answers again', async () => {
    const project = scannedProject({ git_error: 'EMFILE' })

    await refreshProjectGit(project, { readStatus: statusOf({}), fullGitInfo: failIfCalled })

    assert.ok(!('git_error' in project.git_info))
    assert.equal(project.git_info.git_detected, true)
})
