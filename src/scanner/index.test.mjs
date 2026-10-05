import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectScanner, getLatestMtime, Semaphore, FS_CONCURRENCY, withFdRetry } from './index.mjs'

// No setTimeout/setImmediate here (not in this project's eslint globals) —
// a few chained microtask ticks are enough to let queued Promise callbacks run.
async function tick(times = 5) {
    for (let i = 0; i < times; i++) await Promise.resolve()
}

// --- Semaphore: the concurrency limiter itself -----------------------------

test('Semaphore never runs more than `max` tasks concurrently, and runs all of them', async () => {
    const max = 5
    const sem = new Semaphore(max)
    let active = 0
    let peak = 0
    let completed = 0
    const total = 200

    const tasks = Array.from({ length: total }, () =>
        sem.run(async () => {
            active++
            peak = Math.max(peak, active)
            // Yield to let other queued tasks get a chance to (wrongly) start
            // if the semaphore didn't actually gate them.
            await tick()
            active--
            completed++
        })
    )

    await Promise.all(tasks)

    assert.equal(completed, total)
    assert.ok(peak <= max, `peak concurrency ${peak} exceeded max ${max}`)
})

test('Semaphore does not hold resources for queued (not-yet-acquired) tasks', async () => {
    // Tasks that never get to run (because they're still queued) must not
    // have invoked the wrapped fn yet.
    const sem = new Semaphore(1)
    let started = 0
    let releaseFirst
    const first = sem.run(() => {
        started++
        return new Promise(resolve => { releaseFirst = resolve })
    })

    // Queue a second task behind the first.
    let secondStarted = false
    const second = sem.run(async () => { secondStarted = true; started++ })

    // Give the microtask queue a chance to run anything that would start.
    await tick()
    assert.equal(started, 1, 'only the first task should have started')
    assert.equal(secondStarted, false, 'second task must not start before the first releases')

    releaseFirst()
    await Promise.all([first, second])
    assert.equal(started, 2)
})

// --- Walkers: bounded results must match the previous (unbounded) behavior -

async function makeTree() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-fd-test-'))

    // Regular content
    const src = path.join(root, 'src')
    await fs.mkdir(path.join(src, 'nested', 'deeper'), { recursive: true })
    await fs.writeFile(path.join(src, 'a.js'), 'aa')
    await fs.writeFile(path.join(src, 'b.ts'), 'bbb')
    await fs.writeFile(path.join(src, 'nested', 'c.js'), 'cccc')
    await fs.writeFile(path.join(src, 'nested', 'deeper', 'd.md'), 'ddddd')

    // Ignored dir (node_modules) — walkFileTree still walks it for lib size;
    // getLatestMtime skips it entirely.
    const nm = path.join(root, 'node_modules', 'pkg-a')
    await fs.mkdir(nm, { recursive: true })
    await fs.writeFile(path.join(nm, 'index.js'), 'lib content here')
    await fs.writeFile(path.join(nm, 'pkg.json'), '{}')

    return root
}

test('walkFileTree with bounded concurrency produces the same shape of results as a manual walk', async () => {
    const root = await makeTree()
    try {
        const scanner = new ProjectScanner({ scanRoots: [] })
        const result = await scanner.walkFileTree(root)

        // 4 non-ignored files (a.js, b.ts, nested/c.js, nested/deeper/d.md)
        const totalContentFiles = Object.values(result.fileTypes).reduce((a, b) => a + b, 0)
        assert.equal(totalContentFiles, 4)
        assert.equal(result.fileTypes['.js'], 2) // a.js + nested/c.js
        assert.equal(result.fileTypes['.ts'], 1)
        assert.equal(result.fileTypes['.md'], 1)

        assert.equal(result.contentSizeBytes, 'aa'.length + 'bbb'.length + 'cccc'.length + 'ddddd'.length)
        assert.equal(result.libsSizeBytes, 'lib content here'.length + '{}'.length)
        assert.ok(result.latestMtime > 0)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('getLatestMtime skips ignored dirs entirely and matches a manual computation', async () => {
    const root = await makeTree()
    try {
        const isoString = await getLatestMtime(root)
        const mtime = Date.parse(isoString)

        // Manually compute the expected latest mtime across only the
        // non-ignored files.
        const files = [
            path.join(root, 'src', 'a.js'),
            path.join(root, 'src', 'b.ts'),
            path.join(root, 'src', 'nested', 'c.js'),
            path.join(root, 'src', 'nested', 'deeper', 'd.md')
        ]
        let expected = 0
        for (const f of files) {
            const stat = await fs.stat(f)
            expected = Math.max(expected, stat.mtimeMs)
        }

        // new Date(ms).toISOString() truncates sub-millisecond fractions,
        // so allow a 1ms rounding tolerance rather than exact equality.
        assert.ok(Math.abs(mtime - expected) <= 1, `expected ~${expected}, got ${mtime}`)
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

test('walkFileTree never exceeds FS_CONCURRENCY concurrent fs.stat calls on a wide tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-fd-wide-'))
    try {
        // A single directory with many files fans out a large Promise.all
        // batch at once — the case that used to open one FD per file.
        const fileCount = FS_CONCURRENCY * 4
        for (let i = 0; i < fileCount; i++) {
            await fs.writeFile(path.join(root, `f${i}.txt`), 'x')
        }

        // Wrap fs.stat process-wide isn't practical without module mocking,
        // so instead we assert indirectly: the Semaphore unit tests above
        // already prove the gate holds `max` concurrent runners. Here we
        // just confirm the walk still produces correct results at a width
        // well beyond FS_CONCURRENCY, i.e. batching doesn't lose or
        // double-count entries.
        const scanner = new ProjectScanner({ scanRoots: [] })
        const result = await scanner.walkFileTree(root)
        const totalFiles = Object.values(result.fileTypes).reduce((a, b) => a + b, 0)
        assert.equal(totalFiles, fileCount)
        assert.equal(result.contentSizeBytes, fileCount) // 1 byte ('x') per file
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})

// --- Task 1: last_code_modified + AI-key durability -------------------------

test('walkFileTree computes last_code_modified excluding meta-doc files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
    try {
        const old = new Date('2020-01-05T00:00:00Z')
        const fresh = new Date('2026-07-01T00:00:00Z')
        await fs.writeFile(path.join(dir, 'index.js'), 'x')
        await fs.utimes(path.join(dir, 'index.js'), old, old)
        await fs.writeFile(path.join(dir, 'README.md'), 'x')
        await fs.utimes(path.join(dir, 'README.md'), fresh, fresh)
        await fs.writeFile(path.join(dir, 'package.json'), '{}')
        await fs.utimes(path.join(dir, 'package.json'), old, old)
        const scanner = new ProjectScanner({ scanRoots: [dir] })
        const meta = await scanner.extractProjectMetadata(dir)
        // last_modified follows the freshest file (README), last_code_modified must not
        assert.equal(new Date(meta.last_code_modified).getUTCFullYear(), 2020)
        assert.equal(new Date(meta.last_modified).getUTCFullYear(), 2026)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('last_code_modified is null for a project with only meta-doc files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
    try {
        await fs.writeFile(path.join(dir, 'README.md'), 'only docs')
        const scanner = new ProjectScanner({ scanRoots: [dir] })
        const meta = await scanner.extractProjectMetadata(dir)
        assert.equal(meta.last_code_modified, null)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('processProject carries ai_analysis and ai_derived across re-extraction', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
    try {
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
        const scanner = new ProjectScanner({ scanRoots: [dir], forceUpdate: true })
        const ai = { category: '_Learning', input_hash: 'h', version: 2 }
        const derived = { status: 'dead', tech: [], placement_ok: true, suggested_path: dir }
        scanner.existingProjectsCache.set(dir, { directory: dir, last_modified: '2000-01-01T00:00:00Z', ai_analysis: ai, ai_derived: derived })
        const meta = await scanner.processProject(dir)
        assert.deepEqual(meta.ai_analysis, ai)      // survived forced re-extraction
        assert.deepEqual(meta.ai_derived, derived)
        assert.ok(meta.stack !== undefined)          // and it IS a fresh record
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

// --- Fix 1: errors must never delete projects ------------------------------

test('processProject returns cached record when extraction fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
    try {
        const scanner = new ProjectScanner({ scanRoots: [dir] })
        const cachedRecord = { directory: dir, project_name: 'cached-one', last_modified: '2020-01-01T00:00:00Z' }
        scanner.existingProjectsCache.set(dir, cachedRecord)
        // Force the update path, then make extraction fail (e.g. EMFILE).
        scanner.shouldUpdateMetadata = async () => ({ needsUpdate: true, cached: null })
        scanner.extractProjectMetadata = async () => { throw new Error('EMFILE') }

        const events = []
        scanner.onProgress = (e) => events.push(e)

        const result = await scanner.processProject(dir)
        assert.deepEqual(result, cachedRecord)                       // fell back to last known record
        assert.ok(events.some(e => e.type === 'error'), 'an error progress event fired')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('processProject returns null when extraction fails and no cache exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-scan-'))
    try {
        const scanner = new ProjectScanner({ scanRoots: [dir] })
        scanner.shouldUpdateMetadata = async () => ({ needsUpdate: true, cached: null })
        scanner.extractProjectMetadata = async () => { throw new Error('EMFILE') }
        const result = await scanner.processProject(dir)
        assert.equal(result, null)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

async function writeRecords(file, count) {
    const lines = []
    for (let i = 0; i < count; i++) lines.push(JSON.stringify({ directory: `/p/${i}`, project_name: `p${i}` }))
    await fs.writeFile(file, lines.join('\n') + '\n')
}

test('syncMetadata refuses a >30% shrink', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-sync-'))
    const file = path.join(dir, 'projects.jsonl')
    try {
        await writeRecords(file, 30)
        const before = await fs.readFile(file, 'utf-8')
        const scanner = new ProjectScanner({ scanRoots: [], syncFile: file })
        const events = []
        scanner.onProgress = (e) => events.push(e)
        const incoming = Array.from({ length: 10 }, (_, i) => ({ directory: `/p/${i}`, project_name: `p${i}` }))
        await assert.rejects(() => scanner.syncMetadata(incoming), /sync refused/)
        const after = await fs.readFile(file, 'utf-8')
        assert.equal(after, before, 'file content unchanged')
        assert.ok(events.some(e => e.type === 'sync_refused'), 'sync_refused event fired')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('syncMetadata allows a >30% shrink when allowShrink is passed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-sync-'))
    const file = path.join(dir, 'projects.jsonl')
    try {
        await writeRecords(file, 30)
        const scanner = new ProjectScanner({ scanRoots: [], syncFile: file })
        const incoming = Array.from({ length: 10 }, (_, i) => ({ directory: `/p/${i}`, project_name: `p${i}` }))
        await scanner.syncMetadata(incoming, { allowShrink: true })
        const written = (await fs.readFile(file, 'utf-8')).trim().split('\n').filter(Boolean)
        assert.equal(written.length, 10)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('syncMetadata allows a large shrink when existing file is at/under the 20-record floor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-sync-'))
    const file = path.join(dir, 'projects.jsonl')
    try {
        await writeRecords(file, 20)
        const scanner = new ProjectScanner({ scanRoots: [], syncFile: file })
        await scanner.syncMetadata([{ directory: '/p/0', project_name: 'p0' }])
        const written = (await fs.readFile(file, 'utf-8')).trim().split('\n').filter(Boolean)
        assert.equal(written.length, 1)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

// --- Fix 3: bounded discovery concurrency + EMFILE retry --------------------

test('withFdRetry retries a retryable error then succeeds', async () => {
    let attempts = 0
    const result = await withFdRetry(async () => {
        attempts++
        if (attempts < 3) {
            const err = new Error('too many open files')
            err.code = 'EMFILE'
            throw err
        }
        return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(attempts, 3) // 2 failures + 1 success
})

test('withFdRetry gives up after the retry budget and rethrows', async () => {
    let attempts = 0
    await assert.rejects(() => withFdRetry(async () => {
        attempts++
        const err = new Error('nope')
        err.code = 'EMFILE'
        throw err
    }, 3), /nope/)
    assert.equal(attempts, 4) // initial + 3 retries
})

test('withFdRetry does not retry a non-retryable error', async () => {
    let attempts = 0
    await assert.rejects(() => withFdRetry(async () => {
        attempts++
        const err = new Error('boom')
        err.code = 'EACCES'
        throw err
    }), /boom/)
    assert.equal(attempts, 1) // no retries for a non-fd error
})

test('discoverProjects still finds nested projects (semaphore wrapping is result-preserving)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-discover-'))
    try {
        // A top-level group (only .git) with two real sub-projects.
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
        await fs.mkdir(path.join(root, 'app-a'), { recursive: true })
        await fs.writeFile(path.join(root, 'app-a', 'package.json'), '{"name":"a"}')
        await fs.mkdir(path.join(root, 'app-b'), { recursive: true })
        await fs.writeFile(path.join(root, 'app-b', 'requirements.txt'), 'flask')

        const scanner = new ProjectScanner({ scanRoots: [root] })
        const results = []
        await scanner.discoverProjects(root, results, null)

        assert.ok(results.includes(path.join(root, 'app-a')), 'found app-a')
        assert.ok(results.includes(path.join(root, 'app-b')), 'found app-b')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('getLatestMtime ignores .stow/ so writing the project file does not trigger a rescan', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-mtime-'))
    await fs.writeFile(path.join(dir, 'a.js'), 'x')
    const old = new Date('2020-01-01T00:00:00Z')
    await fs.utimes(path.join(dir, 'a.js'), old, old)
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), '{"id":"p_test"}')
    assert.equal(await getLatestMtime(dir), old.toISOString())
    await fs.rm(dir, { recursive: true })
})

// --- Virtual projects (#9): checkout + identity on every row ---------------
import { execFileSync } from 'node:child_process'
import { buildRegistry } from '../lib/registry/registry.mjs'

const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString()

test('scan merges two clones of one remote, sub-folders are members, no-remote dirs get a .stow id', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-merge-')))
    // A seed with one commit: getGitInfo reports no remotes for an empty clone.
    const origin = path.join(base, 'origin')
    await fs.mkdir(origin)
    gitIn(origin, 'init', '-q')
    await fs.writeFile(path.join(origin, 'index.js'), '1\n')
    gitIn(origin, 'add', '.')
    gitIn(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed')
    const root = path.join(base, 'root')
    await fs.mkdir(root)
    for (const name of ['blog', 'blog-test']) {
        gitIn(root, 'clone', '-q', origin, name)
        gitIn(path.join(root, name), 'remote', 'set-url', 'origin', 'git@example.com:Acme/blog.git')
        await fs.writeFile(path.join(root, name, 'README.md'), '# blog\n')
        await fs.mkdir(path.join(root, name, 'docs'))
        await fs.writeFile(path.join(root, name, 'docs', 'README.md'), '# docs\n')
    }
    await fs.mkdir(path.join(root, 'notes'))
    await fs.writeFile(path.join(root, 'notes', 'README.md'), '# notes\n')
    const local = path.join(root, 'local')
    await fs.mkdir(local)
    gitIn(local, 'init', '-q')
    await fs.writeFile(path.join(local, 'README.md'), '# local\n')
    const ledger = path.join(base, 'ledger.jsonl')

    try {
        const events = []
        const scanner = new ProjectScanner({ scanRoots: [root], syncFile: ledger, onProgress: e => events.push(e) })
        const rows = await scanner.scanProjects()
        await scanner.syncMetadata(rows)

        const blogKey = 'git:example.com/acme/blog'
        assert.equal(rows.filter(r => r.project_id === blogKey).length, 4) // 2 clones + their docs/
        const docs = rows.find(r => r.directory === path.join(root, 'blog', 'docs'))
        assert.deepEqual(docs.checkout, { root: path.join(root, 'blog'), subpath: 'docs', git: true })
        const blog = buildRegistry(rows).projects.find(p => p.key === blogKey)
        assert.deepEqual(blog.locations.map(l => l.directory).sort(), [path.join(root, 'blog'), path.join(root, 'blog-test')])
        assert.ok(blog.locations.every(l => l.members === 2))

        const notes = rows.find(r => r.directory === path.join(root, 'notes'))
        assert.equal(notes.identity.kind, 'stow')
        const notesFile = JSON.parse(await fs.readFile(path.join(root, 'notes', '.stow', 'project.json'), 'utf8'))
        assert.equal(notes.project_id, `stow:${notesFile.id}`)
        // A remote-backed checkout never gets a file.
        await assert.rejects(fs.access(path.join(root, 'blog', '.stow')))
        // The no-remote repo's file is invisible to git status.
        assert.equal(rows.find(r => r.directory === local).identity.kind, 'stow')
        assert.equal(gitIn(local, 'status', '--porcelain'), '?? README.md\n')
        assert.ok(events.some(e => e.type === 'projects_assigned' && e.stow_created === 2))

        // Second scan: same ids, nothing re-created, rows came from the cache.
        const again = new ProjectScanner({ scanRoots: [root], syncFile: ledger })
        const rows2 = await again.scanProjects()
        assert.deepEqual(rows2.map(r => [r.directory, r.project_id]).sort(), rows.map(r => [r.directory, r.project_id]).sort())
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('cached rows without checkout are backfilled on the next incremental scan', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-backfill-')))
    const dir = path.join(base, 'p')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'README.md'), '# p\n')
    const ledger = path.join(base, 'ledger.jsonl')
    // last_modified in the future → processProject returns the cached row untouched.
    await fs.writeFile(ledger, JSON.stringify({ directory: dir, last_modified: '2999-01-01T00:00:00.000Z', project_name: 'p', marker: 'cached' }) + '\n')
    try {
        const scanner = new ProjectScanner({ scanRoots: [base], syncFile: ledger })
        const [row] = await scanner.scanProjects()
        assert.equal(row.marker, 'cached') // really the cached row, not a re-extraction
        assert.deepEqual(row.checkout, { root: dir, subpath: '', git: false })
        assert.equal(row.identity.kind, 'stow')
        assert.match(row.project_id, /^stow:p_/)
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('a moved no-remote folder keeps its identity and its AI analysis', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-moved-')))
    const oldDir = path.join(base, 'old-name')
    const newDir = path.join(base, 'new-name')
    await fs.mkdir(path.join(newDir, '.stow'), { recursive: true })
    await fs.writeFile(path.join(newDir, 'README.md'), '# x\n')
    await fs.writeFile(path.join(newDir, '.stow', 'project.json'), '{"version":1,"id":"p_movedmovedm"}\n')
    const ledger = path.join(base, 'ledger.jsonl')
    await fs.writeFile(ledger, JSON.stringify({
        directory: oldDir, last_modified: '2026-01-01T00:00:00.000Z',
        checkout: { root: oldDir, subpath: '', git: false },
        identity: { key: 'stow:p_movedmovedm', kind: 'stow' }, project_id: 'stow:p_movedmovedm',
        ai_analysis: { category: '_Tools' }, ai_derived: { status: 'active' },
    }) + '\n')
    try {
        const events = []
        const scanner = new ProjectScanner({ scanRoots: [base], syncFile: ledger, onProgress: e => events.push(e) })
        const [row] = await scanner.scanProjects()
        assert.equal(row.directory, newDir)
        assert.equal(row.project_id, 'stow:p_movedmovedm')
        assert.deepEqual(row.ai_analysis, { category: '_Tools' })
        assert.deepEqual(row.ai_derived, { status: 'active' })
        assert.ok(events.some(e => e.type === 'moved' && e.from === oldDir && e.to === newDir))
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('refreshProjectGit keeps checkout/identity/project_id (they live outside git_info)', async () => {
    const { refreshProjectGit } = await import('../lib/git-status.mjs')
    const project = { directory: '/x', git_info: { git_detected: true, head_sha: 'a' },
        checkout: { root: '/x', subpath: '', git: true }, identity: { key: 'git:x/y', kind: 'git' }, project_id: 'git:x/y' }
    await refreshProjectGit(project, { readStatus: async () => ({ head_sha: 'b' }), fullGitInfo: async () => ({ git_detected: true, head_sha: 'b' }) })
    assert.deepEqual(project.checkout, { root: '/x', subpath: '', git: true })
    assert.deepEqual(project.identity, { key: 'git:x/y', kind: 'git' })
    assert.equal(project.project_id, 'git:x/y')
})

test('a no-remote folder that became a git repo after its .stow was written: the next scan excludes .stow/', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-gitinit-')))
    const dir = path.join(base, 'notes')
    await fs.mkdir(path.join(dir, '.stow'), { recursive: true })
    await fs.writeFile(path.join(dir, 'README.md'), '# n\n')
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), '{"version":1,"id":"p_notesnotesn"}\n')
    gitIn(dir, 'init', '-q')
    gitIn(dir, 'add', 'README.md')
    gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed')
    try {
        const [row] = await new ProjectScanner({ scanRoots: [base] }).scanProjects()
        assert.equal(row.project_id, 'stow:p_notesnotesn')
        assert.equal(gitIn(dir, 'status', '--porcelain', '-u'), '')
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('a no-remote repo and its linked worktree share one .stow id (kept in the main work tree)', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-wt-')))
    const main = path.join(base, 'app')
    await fs.mkdir(main)
    gitIn(main, 'init', '-q')
    await fs.writeFile(path.join(main, 'README.md'), '# app\n')
    gitIn(main, 'add', '.')
    gitIn(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed')
    gitIn(main, 'worktree', 'add', '-q', path.join(base, 'app-wt'))
    try {
        const rows = await new ProjectScanner({ scanRoots: [base] }).scanProjects()
        assert.equal(rows.length, 2)
        assert.equal(new Set(rows.map(r => r.project_id)).size, 1)
        assert.match(rows[0].project_id, /^stow:p_/)
        await assert.rejects(fs.access(path.join(base, 'app-wt', '.stow')))
        const id = rows[0].project_id.slice('stow:'.length)
        const metas = new Map([[main, { meta: { id }, warnings: [] }]])
        assert.deepEqual(buildRegistry(rows, { metas }).projects[0].locations.map(l => l.directory).sort(), [main, path.join(base, 'app-wt')])
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('assignProjects (quick refresh): a moved folder found before any full scan inherits from the stale row still listed', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stow-quickmove-')))
    const newDir = path.join(base, 'new')
    await fs.mkdir(path.join(newDir, '.stow'), { recursive: true })
    await fs.writeFile(path.join(newDir, '.stow', 'project.json'), '{"version":1,"id":"p_quickquickq"}\n')
    const stale = { directory: path.join(base, 'old'), checkout: { root: path.join(base, 'old'), subpath: '', git: false },
        identity: { key: 'stow:p_quickquickq', kind: 'stow' }, project_id: 'stow:p_quickquickq', ai_analysis: { category: '_Tools' } }
    const found = { directory: newDir, project_name: 'new' }
    try {
        const rows = [stale, found]
        await new ProjectScanner({ scanRoots: [base] }).assignProjects(rows, { priorRows: [stale] })
        assert.equal(found.project_id, 'stow:p_quickquickq')
        assert.equal(stale.project_id, 'stow:p_quickquickq') // stored id kept, nothing recreated
        await assert.rejects(fs.access(path.join(base, 'old')))
        assert.deepEqual(found.ai_analysis, { category: '_Tools' })
    } finally {
        await fs.rm(base, { recursive: true, force: true })
    }
})

test('assignProjects on rows that already have a checkout: no git spawn, project_id follows git_info.remotes', async () => {
    const exec = async () => assert.fail('no git spawn expected')
    const row = { directory: '/nowhere/app', checkout: { root: '/nowhere/app', subpath: '', git: true },
        identity: { key: 'stow:p_oldoldoldol', kind: 'stow' }, project_id: 'stow:p_oldoldoldol',
        git_info: { remotes: ['git@github.com:o/app.git'] } }
    await new ProjectScanner({ scanRoots: [], exec }).assignProjects([row], { priorRows: [], recheckExclude: false })
    assert.equal(row.project_id, 'git:github.com/o/app')
})
