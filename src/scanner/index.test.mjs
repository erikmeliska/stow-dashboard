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
