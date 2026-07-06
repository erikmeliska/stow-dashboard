# Unified 60s Refresh + Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One opt-in 60s refresh cycle (POST /api/scan/quick) that detects processes, auto-discovers new projects from unmatched process cwds, and refreshes git info — plus a ScanControls rework (manual refresh button, Scan/Force in a ⋯ menu).

**Architecture:** Pure discovery logic in `src/lib/discovery.mjs` (unit-tested). Process grouping extracted into `src/lib/processes.mjs` so the quick route and `GET /api/processes` share one implementation and the quick route gets `unmatchedCwds`. The quick route becomes the combined cycle; the client stops polling `/api/processes` and instead receives the processes map in the cycle's final SSE event via a window CustomEvent.

**Tech Stack:** Next.js 16 API routes (SSE), node:test for lib tests, shadcn/radix DropdownMenu, existing ProjectScanner.

**Spec:** `docs/superpowers/specs/2026-07-05-unified-refresh-auto-discovery-design.md`

## Global Constraints

- Bare directories (no indicator from `STRONG_PROJECT_INDICATORS`/`WEAK_PROJECT_INDICATORS` in `src/scanner/index.mjs:17-30`) are never added.
- Negative-cache TTL: **5 minutes**; module-level (per server process), key = process cwd.
- The cycle runs only via the autorefresh toggle (60 s, localStorage-persisted, run-immediately-on-enable — all existing behavior) or the manual refresh button. No always-on polling remains.
- `GET /api/processes` keeps working unchanged for external consumers and the details sheet (`?directory=`), it just stops being polled by the table.
- Full scan (`POST /api/scan`) and its API are unchanged; only its buttons move into the ⋯ menu. Tray/MCP/CLI untouched.
- JSONL is written at most once per cycle (single write at end, as today).
- Tests run with `npm test` (node --test); lib tests live next to the lib as `src/lib/<name>.test.mjs` and use plain relative imports (the `@/*` alias does not work under node --test).
- SSE event contract produced by the cycle (client depends on it): `{type:'discovered', directory, project_name}` per discovery; final `{type:'complete', success:true, projectCount, discovered:[dirs], processes:{[dir]:entries}, duration}`.
- Window event contract: `window.dispatchEvent(new CustomEvent('stow:processes', { detail: { projects, timestamp } }))`.

---

### Task 1: Discovery lib (`src/lib/discovery.mjs`) with unit tests

**Files:**
- Modify: `src/scanner/index.mjs` (add exports only)
- Create: `src/lib/discovery.mjs`
- Test: `src/lib/discovery.test.mjs`

**Interfaces:**
- Consumes: `STRONG_PROJECT_INDICATORS`, `WEAK_PROJECT_INDICATORS`, `DEFAULT_IGNORE_PATTERNS` from `src/scanner/index.mjs` (exported in Step 1).
- Produces (used by Task 3):
  - `resolveCandidateRoot(cwd: string, scanRoots: string[]): Promise<string|null>` — nearest ancestor of `cwd` (starting at `cwd` itself, stopping below the scan root) that has a project indicator; `null` if none, if `cwd` isn't under any root, equals a root, or is excluded.
  - `class NegativeCache { constructor(ttlMs = 300000); has(key): boolean; add(key): void }`
  - `dirHasProjectIndicator(dir): Promise<boolean>`, `isExcludedPath(cwd, root): boolean` (also exported for tests).

- [ ] **Step 1: Export the constants from the scanner**

In `src/scanner/index.mjs`, the three constants are currently module-private: `DEFAULT_IGNORE_PATTERNS` (top of file), `STRONG_PROJECT_INDICATORS` (line ~17), `WEAK_PROJECT_INDICATORS` (line ~28). Add `export` to each declaration (e.g. `export const STRONG_PROJECT_INDICATORS = new Set([...])`). No other change.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/discovery.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveCandidateRoot, NegativeCache, isExcludedPath } from './discovery.mjs'

async function makeTree(spec) {
    // spec: { 'relative/dir': ['file1', ...] }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discovery-test-'))
    for (const [rel, files] of Object.entries(spec)) {
        const dir = path.join(root, rel)
        await fs.mkdir(dir, { recursive: true })
        for (const f of files) await fs.writeFile(path.join(dir, f), '')
    }
    return root
}

test('resolveCandidateRoot finds the cwd itself when it has an indicator', async () => {
    const root = await makeTree({ 'proj': ['package.json'] })
    const result = await resolveCandidateRoot(path.join(root, 'proj'), [root])
    assert.equal(result, path.join(root, 'proj'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot walks up from a nested cwd to the nearest indicator', async () => {
    const root = await makeTree({ 'proj': ['package.json'], 'proj/src/deep': [] })
    const result = await resolveCandidateRoot(path.join(root, 'proj/src/deep'), [root])
    assert.equal(result, path.join(root, 'proj'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot prefers the NEAREST indicator when nested projects exist', async () => {
    const root = await makeTree({ 'outer': ['package.json'], 'outer/inner': ['package.json'] })
    const result = await resolveCandidateRoot(path.join(root, 'outer/inner'), [root])
    assert.equal(result, path.join(root, 'outer/inner'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null for a bare dir (no indicator anywhere)', async () => {
    const root = await makeTree({ 'bare/sub': [] })
    assert.equal(await resolveCandidateRoot(path.join(root, 'bare/sub'), [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot accepts a weak indicator (.git dir)', async () => {
    const root = await makeTree({ 'repo/.git': [], 'repo/src': [] })
    const result = await resolveCandidateRoot(path.join(root, 'repo/src'), [root])
    assert.equal(result, path.join(root, 'repo'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null when cwd is not under any scan root', async () => {
    const root = await makeTree({ 'proj': ['package.json'] })
    assert.equal(await resolveCandidateRoot('/somewhere/else', [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null when cwd IS a scan root', async () => {
    const root = await makeTree({ '.': ['package.json'] })
    assert.equal(await resolveCandidateRoot(root, [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null for excluded paths (node_modules, hidden dirs)', async () => {
    const root = await makeTree({
        'proj': ['package.json'],
        'proj/node_modules/dep': ['package.json'],
        'proj/.cache/x': [],
    })
    assert.equal(await resolveCandidateRoot(path.join(root, 'proj/node_modules/dep'), [root]), null)
    assert.equal(await resolveCandidateRoot(path.join(root, 'proj/.cache/x'), [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('isExcludedPath flags hidden and ignored segments, not clean paths', () => {
    assert.equal(isExcludedPath('/r/proj/node_modules/x', '/r'), true)
    assert.equal(isExcludedPath('/r/proj/.git/hooks', '/r'), true)
    assert.equal(isExcludedPath('/r/proj/src', '/r'), false)
})

test('NegativeCache: add/has respects TTL', async () => {
    const cache = new NegativeCache(50) // 50ms TTL for the test
    cache.add('/a')
    assert.equal(cache.has('/a'), true)
    assert.equal(cache.has('/b'), false)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(cache.has('/a'), false) // expired
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test src/lib/discovery.test.mjs`
Expected: FAIL — `Cannot find module ... discovery.mjs`

- [ ] **Step 4: Implement `src/lib/discovery.mjs`**

```js
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
```

Note: `DEFAULT_IGNORE_PATTERNS` in the scanner may be an array or Set — the spread in `isExcludedPath` handles both; check its actual shape when exporting in Step 1 and keep the code consistent.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/lib/discovery.test.mjs`
Expected: all tests PASS. Then run the full suite: `npm test` — all pass, no new noise.

- [ ] **Step 6: Commit**

```bash
git add src/scanner/index.mjs src/lib/discovery.mjs src/lib/discovery.test.mjs
git commit -m "feat: discovery lib — resolve project root from process cwd (scanner indicator rules, negative cache)"
```

---

### Task 2: Shared process grouping in `src/lib/processes.mjs`

**Files:**
- Modify: `src/lib/processes.mjs` (add two functions at the end)
- Modify: `src/app/api/processes/route.js` (use the shared function)
- Test: `src/lib/processes.test.mjs` (append tests)

**Interfaces:**
- Consumes: existing `getProcTable`, `getRunningProcesses`, `getClaudeAndTerminalSessions`, `getDockerContainers`, `matchProcessToProject` (all already exported from `src/lib/processes.mjs`).
- Produces (used by Task 3 and the processes route):
  - `groupProcessSources({ runningProcesses, claudeSessions, openTerminals, dockerContainers }, projectDirs) -> { projects: Record<string, object[]>, unmatchedCwds: string[] }` — pure, synchronous.
  - `collectProjectProcesses(projectDirs) -> Promise<{ projects, unmatchedCwds }>` — does the syscalls, then calls `groupProcessSources`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/processes.test.mjs` (keep existing imports; add `groupProcessSources` to the import from `./processes.mjs`):

```js
test('groupProcessSources groups matched entries by project and collects unmatched cwds', () => {
    const projectDirs = ['/r/proj-a', '/r/proj-b']
    const sources = {
        runningProcesses: [
            { pid: '11', command: 'node server.js', cwd: '/r/proj-a', ports: [3000], host: null, hostLabel: null },
            { pid: '12', command: 'node x', cwd: '/r/unknown-1', ports: [4000], host: null, hostLabel: null },
        ],
        claudeSessions: [
            { pid: '21', cwd: '/r/proj-b/sub', host: null, hostLabel: null },
        ],
        openTerminals: [
            { pid: '31', command: 'zsh', cwd: '/r/unknown-2/deep', tty: 'ttys001', host: null, hostLabel: null },
        ],
        dockerContainers: [
            { id: 'c1', name: 'db', image: 'postgres', ports: [5432], status: 'Up', cwd: '/r/proj-a' },
        ],
    }

    const { projects, unmatchedCwds } = groupProcessSources(sources, projectDirs)

    assert.equal(projects['/r/proj-a'].length, 2) // process + docker
    assert.equal(projects['/r/proj-a'][0].type, 'process')
    assert.equal(projects['/r/proj-a'][1].type, 'docker')
    assert.equal(projects['/r/proj-b'].length, 1)
    assert.equal(projects['/r/proj-b'][0].type, 'claude')
    assert.deepEqual(unmatchedCwds.sort(), ['/r/unknown-1', '/r/unknown-2/deep'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/processes.test.mjs`
Expected: FAIL — `groupProcessSources` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/processes.mjs`. IMPORTANT: the entry shapes must match what `src/app/api/processes/route.js` currently builds in its four loops (lines 44-121) — this function is that code, moved:

```js
/**
 * Group already-collected process sources by project directory.
 * Returns the per-project map (same shapes the /api/processes response uses)
 * plus the cwds that matched no known project (input for auto-discovery).
 */
export function groupProcessSources(sources, projectDirs) {
    const { runningProcesses = [], claudeSessions = [], openTerminals = [], dockerContainers = [] } = sources
    const projects = {}
    const unmatched = new Set()

    const push = (dir, entry) => {
        if (!projects[dir]) projects[dir] = []
        projects[dir].push(entry)
    }

    for (const proc of runningProcesses) {
        const dir = matchProcessToProject(proc.cwd, projectDirs)
        if (dir) {
            push(dir, {
                pid: parseInt(proc.pid),
                command: proc.command,
                ports: proc.ports,
                type: 'process',
                host: proc.host,
                hostLabel: proc.hostLabel
            })
        } else if (proc.cwd) {
            unmatched.add(proc.cwd)
        }
    }

    for (const session of claudeSessions) {
        const dir = matchProcessToProject(session.cwd, projectDirs)
        if (dir) {
            push(dir, {
                pid: parseInt(session.pid),
                command: 'claude',
                cwd: session.cwd,
                ports: [],
                type: 'claude',
                host: session.host,
                hostLabel: session.hostLabel
            })
        } else if (session.cwd) {
            unmatched.add(session.cwd)
        }
    }

    for (const term of openTerminals) {
        const dir = matchProcessToProject(term.cwd, projectDirs)
        if (dir) {
            push(dir, {
                pid: parseInt(term.pid),
                command: term.command,
                cwd: term.cwd,
                tty: term.tty,
                ports: [],
                type: 'terminal',
                host: term.host,
                hostLabel: term.hostLabel
            })
        } else if (term.cwd) {
            unmatched.add(term.cwd)
        }
    }

    for (const container of dockerContainers) {
        const dir = matchProcessToProject(container.cwd, projectDirs)
        if (dir) {
            push(dir, {
                id: container.id,
                name: container.name,
                image: container.image,
                ports: container.ports,
                status: container.status,
                type: 'docker'
            })
        } else if (container.cwd) {
            unmatched.add(container.cwd)
        }
    }

    return { projects, unmatchedCwds: [...unmatched] }
}

/** One full sweep (lsof/ps/docker) grouped by project. */
export async function collectProjectProcesses(projectDirs) {
    const { procTable, childCount } = await getProcTable()
    const [runningProcesses, dockerContainers, terminalsAndClaude] = await Promise.all([
        getRunningProcesses(procTable),
        getDockerContainers(),
        getClaudeAndTerminalSessions(procTable, childCount),
    ])
    const { claudeSessions, openTerminals } = terminalsAndClaude
    return groupProcessSources(
        { runningProcesses, claudeSessions, openTerminals, dockerContainers },
        projectDirs
    )
}
```

Compare the four entry shapes against the route's loops before deleting anything — they must be byte-for-byte the same fields.

- [ ] **Step 4: Refactor `src/app/api/processes/route.js` to use it**

Replace the body of `GET` so the four loops are gone:

```js
import fs from 'fs/promises'
import path from 'path'
import { collectProjectProcesses } from '@/lib/processes.mjs'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

async function getProjectDirectories() {
    try {
        const content = await fs.readFile(DATA_FILE, 'utf-8')
        return content
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line).directory)
    } catch {
        return []
    }
}

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    try {
        const projectDirs = await getProjectDirectories()
        const { projects } = await collectProjectProcesses(projectDirs)

        if (directory) {
            return Response.json({
                directory,
                processes: projects[directory] || []
            })
        }

        return Response.json({
            projects,
            timestamp: new Date().toISOString()
        })
    } catch (error) {
        return Response.json({
            error: 'Failed to get process info',
            details: error.message
        }, { status: 500 })
    }
}
```

- [ ] **Step 5: Run tests + manual endpoint check**

Run: `node --test src/lib/processes.test.mjs` → PASS; `npm test` → all pass.
With the dev server running (`npm run dev` if not already): `curl -s http://localhost:3089/api/processes | head -c 400` → same JSON shape as before (a `projects` object keyed by directory).

- [ ] **Step 6: Commit**

```bash
git add src/lib/processes.mjs src/lib/processes.test.mjs src/app/api/processes/route.js
git commit -m "refactor: extract shared process grouping with unmatched-cwd output"
```

---

### Task 3: Combined refresh cycle in `POST /api/scan/quick`

**Files:**
- Modify: `src/app/api/scan/quick/route.js` (rewrite the collection + add discovery; keep `getGitInfo` as-is)

**Interfaces:**
- Consumes: `collectProjectProcesses(projectDirs)` (Task 2), `resolveCandidateRoot`, `NegativeCache` (Task 1), `ProjectScanner`/`getLatestMtime` from `@/scanner/index.mjs`.
- Produces (Task 4 depends on these SSE events): `{type:'discovered', directory, project_name}`; final `{type:'complete', success:true, projectCount, discovered, processes, duration}`. Existing events (`status`, `refreshing`, `error`) unchanged.

- [ ] **Step 1: Rewrite the route's collection and add discovery**

In `src/app/api/scan/quick/route.js`:

1. Replace the imports and delete the local `getRunningProjectDirs()` entirely (its lsof/docker logic is now `collectProjectProcesses`):

```js
import path from 'path'
import fs from 'fs/promises'
import { simpleGit } from 'simple-git'
import { getLatestMtime, ProjectScanner } from '@/scanner/index.mjs'
import { collectProjectProcesses } from '@/lib/processes.mjs'
import { resolveCandidateRoot, NegativeCache } from '@/lib/discovery.mjs'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')
const SCAN_ROOTS = (process.env.SCAN_ROOTS || '/Users/ericsko/Projekty').split(',').map(s => s.trim())

// Module-level: survives across requests within one server process.
const negativeCache = new NegativeCache()
```

2. Keep `getGitInfo(repoPath)` exactly as it is.

3. Replace the `start(controller)` body's middle section (between loading projects and the final write) with:

```js
// Load existing projects
const content = await fs.readFile(DATA_FILE, 'utf-8')
const projects = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const projectMap = new Map(projects.map(p => [p.directory, p]))

// One sweep: processes grouped by project + unmatched cwds
sendEvent({ type: 'status', message: 'Detecting processes...' })
const projectDirs = [...projectMap.keys()]
const { projects: processMap, unmatchedCwds } = await collectProjectProcesses(projectDirs)

// Auto-discovery: unmatched cwds under SCAN_ROOTS -> candidate project roots
const discovered = []
for (const cwd of unmatchedCwds) {
    if (negativeCache.has(cwd)) continue
    try {
        const candidate = await resolveCandidateRoot(cwd, SCAN_ROOTS)
        if (!candidate) {
            negativeCache.add(cwd)
            continue
        }
        if (projectMap.has(candidate)) continue // known via another path

        sendEvent({ type: 'status', message: `Discovering: ${candidate}` })
        const scanner = new ProjectScanner({ scanRoots: SCAN_ROOTS })
        const meta = await scanner.processProject(candidate)
        if (meta) {
            projectMap.set(candidate, meta)
            discovered.push(candidate)
            sendEvent({ type: 'discovered', directory: candidate, project_name: meta.project_name })
        } else {
            negativeCache.add(cwd)
        }
    } catch (err) {
        sendEvent({ type: 'discover_error', directory: cwd, message: err.message })
        negativeCache.add(cwd)
    }
}

// Git refresh for projects with a running process + freshly discovered ones
const activeDirs = new Set([...Object.keys(processMap), ...discovered])
const activeProjects = [...activeDirs].map(d => projectMap.get(d)).filter(Boolean)

sendEvent({ type: 'status', message: `Refreshing ${activeProjects.length} active projects`, total: activeProjects.length })

let current = 0
for (const project of activeProjects) {
    current++
    sendEvent({ type: 'refreshing', directory: project.directory, current, total: activeProjects.length })
    const [gitInfo, lastModified] = await Promise.all([
        getGitInfo(project.directory),
        getLatestMtime(project.directory)
    ])
    project.git_info = gitInfo
    project.last_modified = lastModified
    projectMap.set(project.directory, project)
}

// Single JSONL write
sendEvent({ type: 'status', message: 'Saving...' })
const lines = Array.from(projectMap.values()).map(p => JSON.stringify(p))
await fs.writeFile(DATA_FILE, lines.join('\n') + '\n')

// Regroup so newly discovered projects claim their processes in the payload
const finalProcesses = discovered.length > 0
    ? (await collectProjectProcesses([...projectMap.keys()])).projects
    : processMap

const duration = Math.round((Date.now() - startTime) / 1000)
sendEvent({
    type: 'complete',
    success: true,
    projectCount: activeProjects.length,
    discovered,
    processes: finalProcesses,
    duration
})
```

Implementation notes for this step:
- Verify `ProjectScanner.processProject(directory)` (src/scanner/index.mjs:457) returns the project meta object (it feeds `scannedProjects` in `scanProjects()`); it needs no prior `loadExistingCache()` when the instance cache is empty — an empty cache just means `needsUpdate: true`. If it turns out it returns a wrapper (e.g. `{directory, ...meta}` vs meta), adapt the `projectMap.set`/`project_name` lines to the real shape and note it in your report.
- The re-sweep for `finalProcesses` costs a second lsof pass ONLY on cycles that discovered something (rare); on normal cycles the first sweep's map is reused.
- Update the `GET` handler's description string to mention discovery (e.g. `'Combined refresh: process detection, project auto-discovery, git refresh for active projects'`).

- [ ] **Step 2: Verify against the dev server**

With `npm run dev` running:

```bash
mkdir -p ~/Projekty/_test-discovery && cd ~/Projekty/_test-discovery && git init -q && cd -
# open a shell there so it has a process (or run: (cd ~/Projekty/_test-discovery && sleep 300 &) )
curl -sN -X POST http://localhost:3089/api/scan/quick | tee /tmp/quick-cycle.log | grep -E "discovered|complete" | head
grep '_test-discovery' data/projects_metadata.jsonl | head -c 200
```

Expected: a `discovered` event for `~/Projekty/_test-discovery`, the final `complete` event contains `"discovered":[".../_test-discovery"]` and a `processes` object; the JSONL now contains the project. Then run the same curl again — no `discovered` event (already known). Clean up: kill the sleep, `rm -rf ~/Projekty/_test-discovery`, remove its line from `data/projects_metadata.jsonl` (or leave it — a Full scan will drop it since the dir is gone).

Also verify the bare-dir rule: `mkdir ~/Projekty/_test-bare` + a `sleep` process inside, run the cycle — NO discovered event; then `touch ~/Projekty/_test-bare/README.md`, run again — discovered (negative cache keys on the *cwd*, and the candidate walk re-runs after TTL or via a different cwd; if the same cwd is cached, wait out the 5-min TTL or restart the dev server and note this behavior in your report). Clean up both test dirs afterwards.

- [ ] **Step 3: Run full test suite**

Run: `npm test` → all pass (no route tests exist; this guards the libs).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/scan/quick/route.js
git commit -m "feat: quick cycle = one sweep for processes + auto-discovery + git refresh"
```

---

### Task 4: Client — ScanControls rework + event-driven useProcesses

**Files:**
- Modify: `src/components/ScanControls.js`
- Modify: `src/hooks/useProcesses.js`
- Modify: `src/app/project-table.js:182` (drop the polling arg)

**Interfaces:**
- Consumes: SSE contract from Task 3 (`discovered`, `complete` with `processes`).
- Produces: window CustomEvent `'stow:processes'` with `detail: { projects, timestamp }` — dispatched by ScanControls, consumed by useProcesses.

- [ ] **Step 1: useProcesses — stop polling, listen for cycle results**

Rewrite the state/effect part of `src/hooks/useProcesses.js` (keep ALL helper callbacks — `getProcessesForProject`, `getPortsForProject`, `isProjectRunning`, `hasDockerContainers`, `getRunningInfo` — and the return object exactly as they are):

```js
'use client'

import { useState, useEffect, useCallback } from 'react'

export function useProcesses() {
    const [processes, setProcesses] = useState({})
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [lastUpdate, setLastUpdate] = useState(null)

    // One-shot fetch: initial mount + explicit refresh() callers.
    const fetchProcesses = useCallback(async () => {
        try {
            const response = await fetch('/api/processes')
            if (!response.ok) throw new Error('Failed to fetch processes')
            const data = await response.json()
            setProcesses(data.projects || {})
            setLastUpdate(data.timestamp)
            setError(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [])

    // Initial load once; afterwards the refresh cycle (ScanControls) pushes
    // fresh data via the 'stow:processes' window event — no polling.
    useEffect(() => {
        fetchProcesses()

        const onCycle = (e) => {
            setProcesses(e.detail?.projects || {})
            setLastUpdate(e.detail?.timestamp || new Date().toISOString())
            setLoading(false)
        }
        window.addEventListener('stow:processes', onCycle)
        return () => window.removeEventListener('stow:processes', onCycle)
    }, [fetchProcesses])
```

(The rest of the file — helpers and return — unchanged.)

- [ ] **Step 2: project-table — drop the interval argument**

In `src/app/project-table.js` line ~182, change:

```js
const { getPortsForProject, getRunningInfo, isProjectRunning } = useProcesses(30000)
```

to:

```js
const { getPortsForProject, getRunningInfo, isProjectRunning } = useProcesses()
```

- [ ] **Step 3: ScanControls — manual refresh + ⋯ menu + event dispatch**

In `src/components/ScanControls.js`:

1. Imports: add `MoreHorizontal` to the lucide imports and the dropdown components:

```js
import { RefreshCw, Zap, CheckCircle, XCircle, Loader2, Activity, MoreHorizontal } from 'lucide-react'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
```

If `src/components/ui/dropdown-menu.jsx` does not exist, check how `project-table.js` renders its column-visibility dropdown and reuse that component; only if the codebase truly has none, add the standard shadcn dropdown-menu component file (the `@radix-ui/react-dropdown-menu` dependency is already installed).

2. In `handleProgressEvent`, add two cases before `'complete'`:

```js
case 'discovered':
    setProgress({ message: `Discovered: ${getShortPath(data.directory)}` })
    setLogs(prev => [...prev.slice(-9), { type: 'discovered', path: getShortPath(data.directory), time: '' }])
    break
case 'discover_error':
    setLogs(prev => [...prev.slice(-9), { type: 'error', path: getShortPath(data.directory), time: '' }])
    break
```

3. In the `'complete'` case, before `router.refresh()`, push the processes map to the table:

```js
case 'complete':
    if (data.success) {
        const durationMsg = data.duration ? ` in ${formatDuration(data.duration)}` : ''
        const discoveredMsg = data.discovered?.length ? `, +${data.discovered.length} discovered` : ''
        setProgress({ message: `Done! ${data.projectCount || 0} projects${discoveredMsg}${durationMsg}`, success: true })
        setLastSync(new Date().toISOString())
        if (data.processes) {
            window.dispatchEvent(new CustomEvent('stow:processes', {
                detail: { projects: data.processes, timestamp: new Date().toISOString() }
            }))
        }
        router.refresh()
    }
    break
```

4. Replace the three-button block (Auto/Quick, Scan, Force — lines ~274-320) with: the autorefresh toggle unchanged except the title text, a manual refresh button, and the ⋯ menu:

```jsx
<Button
    variant={autoRefresh ? "default" : "outline"}
    size="sm"
    onClick={() => {
        if (!autoRefresh) {
            setAutoRefresh(true)
            handleScan('quick') // Run immediately when enabled
        } else {
            setAutoRefresh(false)
        }
    }}
    disabled={isScanning && !autoRefresh}
    title={autoRefresh ? "Auto-refresh enabled (60s): processes, discovery, git — click to disable" : "Enable 60s auto-refresh (processes, discovery, git)"}
>
    {isScanning && scanType === 'quick' ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
    ) : (
        <Activity className={`mr-2 h-4 w-4 ${autoRefresh ? 'animate-pulse' : ''}`} />
    )}
    {autoRefresh ? 'Auto' : 'Auto off'}
</Button>
<Button
    variant="outline"
    size="sm"
    onClick={() => handleScan('quick')}
    disabled={isScanning}
    title="Refresh now: processes, project discovery, git status of active projects"
>
    {isScanning && scanType === 'quick' ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
    ) : (
        <RefreshCw className="mr-2 h-4 w-4" />
    )}
    Refresh
</Button>
<DropdownMenu>
    <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isScanning} title="Maintenance scans">
            {isScanning && (scanType === 'normal' || scanType === 'force') ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <MoreHorizontal className="h-4 w-4" />
            )}
        </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleScan('normal')}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Full scan
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleScan('force')}>
            <Zap className="mr-2 h-4 w-4" />
            Force rescan
        </DropdownMenuItem>
    </DropdownMenuContent>
</DropdownMenu>
```

5. In the logs portal render, show discovered entries with a different mark:

```jsx
{logs.slice(-3).map((log, i) => (
    <div key={i}>
        <span className={log.type === 'discovered' ? 'text-blue-500' : 'text-green-600'}>
            {log.type === 'discovered' ? '+' : '✓'}
        </span> {log.path}{log.time ? ` (${log.time}s)` : ''}
    </div>
))}
```

- [ ] **Step 4: Manual verification in the browser**

With `npm run dev`:

1. Load the dashboard — Running column populates once (initial fetch), then does NOT change on its own (watch ~90 s with autorefresh off; start/stop a dev server in some project — no change until refresh).
2. Click **Refresh** — Running column updates; sync time resets; countdown text ("Synced …s ago") ticks.
3. Toggle **Auto** — cycle fires immediately, then every 60 s (watch two cycles); toggle off stops it. Reload the page — the toggle state persisted (localStorage).
4. ⋯ menu → Full scan runs with the usual progress; Force rescan likewise.
5. Discovery end-to-end: `mkdir -p ~/Projekty/_test-ui && cd ~/Projekty/_test-ui && git init -q` + keep the shell open; click Refresh → progress shows "Discovered: …", table gains the project after completion. Clean up (`rm -rf`, then ⋯ → Full scan removes the row).
6. Open a project's details sheet — processes/git info still load (unchanged `GET /api/processes?directory=`).
7. `npm run lint` → no new warnings; `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScanControls.js src/hooks/useProcesses.js src/app/project-table.js
git commit -m "feat: unified refresh UI — manual refresh, scan/force in overflow menu, event-driven processes"
```

(Include `src/components/ui/dropdown-menu.jsx` in the add if it was created.)

---

### Task 5: Docs + STATUS

**Files:**
- Modify: `CLAUDE.md` (Process Monitoring section + Important Files if needed)
- Modify: `STATUS.md` (NEXT line)

- [ ] **Step 1: Update CLAUDE.md**

In the "### Process Monitoring" section, replace the "Polls every 30 seconds for updates" bullet with:

```markdown
- Refresh cycle (opt-in): the toolbar's Auto toggle runs a combined 60s cycle — process detection, project auto-discovery, git refresh of active projects (`POST /api/scan/quick`); a manual Refresh button runs the same once. With Auto off, the Running column updates only on manual refresh.
- Auto-discovery: unmatched process cwds under `SCAN_ROOTS` are walked up to the nearest directory with a project indicator and added to the JSONL automatically (bare directories are skipped; 5-min negative cache). Full scan remains the only path that removes deleted projects and refreshes scc/size metrics.
- Full scan / Force rescan moved into the ⋯ menu next to the refresh controls.
```

Add `src/lib/discovery.mjs - Project auto-discovery from process cwds` to the Important Files list (after the `src/lib/projects.js` line).

- [ ] **Step 2: Update STATUS.md NEXT**

Replace the leading "Design + implement process-based project auto-discovery …" clause with "Auto-discovery + unified 60s refresh SHIPPED (spec docs/superpowers/specs/2026-07-05-unified-refresh-auto-discovery-design.md)." — keep the rest of the line (Command Center Phase 06 items) verbatim. Bump the front-matter `updated:` date to today.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: unified refresh + auto-discovery (CLAUDE.md, STATUS)"
```
