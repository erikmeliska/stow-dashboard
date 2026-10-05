# Virtuálne projekty 2/6 — Checkout Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scanned ledger row gets a checkout location and a project identity. Checkouts of one repo merge into one register project, sub-folders stop counting as duplicates, no-remote projects get a persisted `.stow/project.json` id, and moved folders keep their register entry and AI data.

**Architecture:** Three small pure-ish modules (`checkout-location`, `stow-project-file`, `checkout-merge`) with injectable `exec`/`fs`, plus one post-scan pass `assignProjects()` on `ProjectScanner`, called by the full scan (CLI and `/api/scan`) and by the quick refresh when it discovered something. The register itself (load/save/shape/normaliser) comes from #8.

**Tech Stack:** Node ≥ 24 ESM (`.mjs`), `node:test` + `node:assert/strict`, `git` CLI via `execFile`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-virtual-projects-checkout-merge-design.md`

## Global Constraints

- **Blocked on #8.** Do not start Task 1 until #8 is merged. Task 0 rebases and confirms the contract in the spec's "Contract assumed from #8" table.
- State paths only via `src/lib/state-dir.mjs` helpers (`dataFile`, `envFile`), resolved at call time, never at module eval.
- Every subprocess goes through an injectable `exec` (default: promisified `execFile`). Tests never require a real git, except the one end-to-end scanner test, which builds a temp repo with `mkdtemp`.
- Tests are colocated `<module>.test.mjs`. Run them with `npm test` and `npm run lint`.
- The scanner never edits an existing `.stow/project.json`. It only creates one, at a checkout root without a remote identity.
- `checkout`, `identity` and `project_id` live at the **top level** of a ledger row, never inside `git_info`. The refresh cycle replaces `git_info` wholesale.
- Opt-out env `STOW_WRITE_PROJECT_FILES=0` (read from `process.env` at call time; `.env.local` is already loaded by CLI/server).
- Location git spawns run at concurrency 16 (same as `GIT_CONCURRENCY` in the quick route).

## Review Focus

1. **Existing ledgers without `checkout`** (every row today): the first scan after upgrade must backfill all rows, including cached and unchanged ones, not only re-extracted ones. Otherwise nothing merges until files change. → test in Task 4.
2. **Writing `.stow/` must not dirty anything**: no +1 in Uncommitted (`info/exclude`), and no `last_modified` bump that re-triggers extraction or AI analysis (`.stow` ignored). → tests in Task 2.
3. **A user-edited or malformed `.stow/project.json`** must never be overwritten. → test in Task 2.
4. **The refresh cycle must not wipe the new fields**: `refreshProjectGit` / active-project `git_info` replacement leaves `checkout` / `identity` / `project_id` intact. → test in Task 4.
5. **A location that exists on disk but was not seen** (scan root removed from `SCAN_ROOTS`) must not be dropped from the register. → test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/checkout-location.mjs` | `resolveLocation(dir)` → `{ root, subpath, git, remoteUrl }` via git; `resolveLocations(rows)` bounded fan-out |
| Create `src/lib/stow-project-file.mjs` | read the `.stow` id, create the file when missing, `info/exclude` upkeep, opt-out |
| Create `src/lib/checkout-merge.mjs` | pure: `identityFor`, `groupCheckouts`, `carryForwardMoved`, `reconcileRegister` |
| Modify `src/scanner/index.mjs` | `.stow` in `DEFAULT_IGNORE_PATTERNS`; `assignProjects(rows, priorRows)`; prior-ledger snapshot; register save in `syncMetadata` |
| Modify `src/app/api/scan/quick/route.js` | call `assignProjects` when `discovered.length > 0` |
| Modify `CLAUDE.md` | "Virtual projects — checkouts" paragraph + Important Files entries |

---

### Task 0: Rebase onto #8 and pin the contract

**Files:** none created. Possibly adjust the import lines named below.

- [ ] **Step 1:** `git fetch && git rebase origin/main`. Confirm #8 is in `git log`.
- [ ] **Step 2:** Locate #8's exports. Run `grep -rn "export" src/lib/ | grep -i -E "register|normalizeRemote|stow"`. Fill this mapping in the PR description and use these names in Tasks 2–4:

| Plan name | #8 actual |
|---|---|
| `normalizeRemoteUrl(url)` | … |
| `STOW_PROJECT_FILE`, `newProjectId()` | … |
| `loadRegister()`, `saveRegister(reg)` | … |
| `createProject({ identity, rows })` | … |

- [ ] **Step 3:** If #8 already reads and writes `.stow/project.json`, cut Task 2 down to Steps 6–9 (exclude + ignore + opt-out) and call #8's reader and writer from `ensureStowFile`.

---

### Task 1: `checkout-location.mjs` — where does this row's checkout live?

**Files:**
- Create: `src/lib/checkout-location.mjs`
- Test: `src/lib/checkout-location.test.mjs`

**Interfaces:**
- Produces: `resolveLocation(directory, { exec }) → Promise<{ root: string, subpath: string, git: boolean, remoteUrl: string|null }>`
- Produces: `resolveLocations(rows, { exec, concurrency = 16, force = false }) → Promise<void>`. Sets `row.checkout = { root, subpath, git }` and stashes `row._remoteUrl` (transient, deleted by Task 3's `assign`) on rows whose `checkout` is missing, or on all rows when `force`.
- Produces: `pickRemote(configOutput) → string|null`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocation, resolveLocations, pickRemote } from './checkout-location.mjs'

// Fake exec: maps "arg string" → stdout, or throws when mapped to an Error.
function fakeExec(table) {
    return async (cmd, args) => {
        const key = args.join(' ')
        const hit = Object.entries(table).find(([k]) => key.endsWith(k))
        if (!hit) throw Object.assign(new Error('fatal: not a git repository'), { code: 128 })
        if (hit[1] instanceof Error) throw hit[1]
        return { stdout: hit[1] }
    }
}

test('pickRemote prefers origin, else the alphabetically first remote', () => {
    assert.equal(pickRemote('remote.upstream.url https://x/up\nremote.origin.url git@x:me/fork.git\n'), 'git@x:me/fork.git')
    assert.equal(pickRemote('remote.zeta.url https://x/z\nremote.alpha.url https://x/a\n'), 'https://x/a')
    assert.equal(pickRemote(''), null)
})

test('resolveLocation: sub-folder of a repo → root is the toplevel, subpath relative', async () => {
    const exec = fakeExec({
        'rev-parse --show-toplevel': '/p/btstack\n',
        'config --get-regexp ^remote\\..*\\.url$': 'remote.origin.url https://github.com/bluekitchen/btstack.git\n',
    })
    const loc = await resolveLocation('/p/btstack/example', { exec })
    assert.deepEqual(loc, { root: '/p/btstack', subpath: 'example', git: true, remoteUrl: 'https://github.com/bluekitchen/btstack.git' })
})

test('resolveLocation: repo root → subpath is empty', async () => {
    const exec = fakeExec({ 'rev-parse --show-toplevel': '/p/blog\n', 'config --get-regexp ^remote\\..*\\.url$': '' })
    assert.deepEqual(await resolveLocation('/p/blog', { exec }), { root: '/p/blog', subpath: '', git: true, remoteUrl: null })
})

test('resolveLocation: a git repo with no remotes (config exits 1) → remoteUrl null', async () => {
    const exec = fakeExec({
        'rev-parse --show-toplevel': '/p/local\n',
        'config --get-regexp ^remote\\..*\\.url$': Object.assign(new Error('exit 1'), { code: 1 }),
    })
    assert.deepEqual(await resolveLocation('/p/local', { exec }), { root: '/p/local', subpath: '', git: true, remoteUrl: null })
})

test('resolveLocation: not a repo / git failure → non-git, root = directory', async () => {
    assert.deepEqual(await resolveLocation('/p/plain', { exec: fakeExec({}) }),
        { root: '/p/plain', subpath: '', git: false, remoteUrl: null })
})

test('resolveLocations only fills rows without checkout unless force', async () => {
    let calls = 0
    const exec = async () => { calls++; throw new Error('not a repo') }
    const rows = [{ directory: '/a' }, { directory: '/b', checkout: { root: '/b', subpath: '', git: false } }]
    await resolveLocations(rows, { exec })
    assert.equal(rows[0].checkout.root, '/a')
    assert.equal(calls, 1)
    await resolveLocations(rows, { exec, force: true })
    assert.equal(calls, 3)
})
```

- [ ] **Step 2:** Run `node --test src/lib/checkout-location.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
/**
 * Where a ledger row's checkout lives. A "checkout" is one git work tree
 * (`git rev-parse --show-toplevel`: linked worktrees and submodules each have
 * their own) or, outside git, the row's own directory. Sub-folders of one
 * repo share a root — that is what stops btstack's 49 rows from looking like
 * 49 copies. The root need not be a ledger row itself (weak-only groups).
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Semaphore } from '../scanner/index.mjs'

const execFileAsync = promisify(execFile)

/** `git config --get-regexp` output → the remote URL that names the project. */
export function pickRemote(configOutput) {
    const remotes = new Map()
    for (const line of String(configOutput).split('\n')) {
        const m = line.match(/^remote\.(.+)\.url\s+(.+)$/)
        if (m) remotes.set(m[1], m[2].trim())
    }
    if (remotes.has('origin')) return remotes.get('origin')
    const [first] = [...remotes.keys()].sort()
    return first ? remotes.get(first) : null
}

export async function resolveLocation(directory, { exec = execFileAsync } = {}) {
    let root
    try {
        const { stdout } = await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'])
        root = stdout.trim()
    } catch {
        return { root: directory, subpath: '', git: false, remoteUrl: null }
    }
    let remoteUrl = null
    try {
        const { stdout } = await exec('git', ['-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$'])
        remoteUrl = pickRemote(stdout)
    } catch {
        // exit 1 = no remotes configured
    }
    return { root, subpath: path.relative(root, directory), git: true, remoteUrl }
}

export async function resolveLocations(rows, { exec, concurrency = 16, force = false } = {}) {
    const limiter = new Semaphore(concurrency)
    await Promise.all(rows
        .filter(r => force || !r.checkout)
        .map(row => limiter.run(async () => {
            const { remoteUrl, ...checkout } = await resolveLocation(row.directory, { exec })
            row.checkout = checkout
            row._remoteUrl = remoteUrl
        })))
}
```

Note: on macOS `--show-toplevel` returns the realpath. If a scan root goes through a symlink, `path.relative` would produce `../…`. Guard against that: when `subpath.startsWith('..')`, keep `root` but set `subpath` to `''` and use `directory` as root. Add this test:

```js
test('resolveLocation: toplevel outside the directory path (symlinked root) → treat directory as root', async () => {
    const exec = fakeExec({ 'rev-parse --show-toplevel': '/private/p/x\n', 'config --get-regexp ^remote\\..*\\.url$': '' })
    assert.deepEqual(await resolveLocation('/p/x', { exec }), { root: '/p/x', subpath: '', git: true, remoteUrl: null })
})
```

and implement it as `const rel = path.relative(root, directory); if (rel.startsWith('..')) return { root: directory, subpath: '', git: true, remoteUrl }`.

- [ ] **Step 4:** Run `node --test src/lib/checkout-location.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit: `git add src/lib/checkout-location.* && git commit -m "feat(scanner): resolve checkout root and naming remote per row (#9)"`

---

### Task 2: `stow-project-file.mjs` — stable id for no-remote checkouts

**Files:**
- Create: `src/lib/stow-project-file.mjs`
- Test: `src/lib/stow-project-file.test.mjs`
- Modify: `src/scanner/index.mjs:11-16` (`DEFAULT_IGNORE_PATTERNS` gains `'.stow'`)
- Test: `src/scanner/index.test.mjs` (mtime test)

**Interfaces:**
- Consumes (#8): `STOW_PROJECT_FILE` (`'.stow/project.json'`), `newProjectId()`
- Produces: `readStowId(root, { fs }) → Promise<{ id: string|null, error: string|null }>`. `error` is `'malformed'` when the file exists but is unusable.
- Produces: `ensureStowFile(root, { git, fs, exec, enabled, newId }) → Promise<{ id: string|null, created: boolean, error: string|null }>`

- [ ] **Step 1: Write the failing tests** (real temp dirs; `exec` faked for the `git --git-path` lookup)

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readStowId, ensureStowFile } from './stow-project-file.mjs'

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'stow-file-')) }
const newId = () => 'p_test123'

test('creates .stow/project.json with only an id when missing', async () => {
    const dir = await tmp()
    const r = await ensureStowFile(dir, { git: false, enabled: true, newId })
    assert.deepEqual(r, { id: 'p_test123', created: true, error: null })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.stow/project.json'), 'utf8')), { id: 'p_test123' })
    await fs.rm(dir, { recursive: true })
})

test('reads an existing id and never rewrites the file', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    const body = '{ "id": "p_keep", "client": "Intelimail", "role": "deploy" }\n'
    await fs.writeFile(path.join(dir, '.stow/project.json'), body)
    const r = await ensureStowFile(dir, { git: false, enabled: true, newId })
    assert.deepEqual(r, { id: 'p_keep', created: false, error: null })
    assert.equal(await fs.readFile(path.join(dir, '.stow/project.json'), 'utf8'), body)
    await fs.rm(dir, { recursive: true })
})

test('malformed file → no id, error, file untouched', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(path.join(dir, '.stow/project.json'), '{ not json')
    const r = await ensureStowFile(dir, { git: false, enabled: true, newId })
    assert.deepEqual(r, { id: null, created: false, error: 'malformed' })
    assert.equal(await fs.readFile(path.join(dir, '.stow/project.json'), 'utf8'), '{ not json')
    await fs.rm(dir, { recursive: true })
})

test('disabled → reads an existing id but creates nothing', async () => {
    const dir = await tmp()
    const r = await ensureStowFile(dir, { git: false, enabled: false, newId })
    assert.deepEqual(r, { id: null, created: false, error: null })
    await assert.rejects(fs.access(path.join(dir, '.stow')))
    await fs.rm(dir, { recursive: true })
})

test('git root: appends /.stow/ to info/exclude exactly once', async () => {
    const dir = await tmp()
    const exclude = path.join(dir, 'gitdir-info-exclude')
    await fs.writeFile(exclude, '# git ls-files --others --exclude-from=.git/info/exclude\n')
    const exec = async () => ({ stdout: exclude + '\n' })
    await ensureStowFile(dir, { git: true, enabled: true, newId, exec })
    await fs.rm(path.join(dir, '.stow'), { recursive: true })
    await ensureStowFile(dir, { git: true, enabled: true, newId, exec })
    const lines = (await fs.readFile(exclude, 'utf8')).split('\n').filter(l => l === '/.stow/')
    assert.equal(lines.length, 1)
    await fs.rm(dir, { recursive: true })
})

test('unwritable root → error, no throw', async () => {
    const dir = await tmp()
    await fs.chmod(dir, 0o500)
    const r = await ensureStowFile(dir, { git: false, enabled: true, newId })
    assert.equal(r.id, null)
    assert.equal(r.created, false)
    assert.match(r.error, /EACCES|EPERM/)
    await fs.chmod(dir, 0o700)
    await fs.rm(dir, { recursive: true })
})
```

- [ ] **Step 2:** Run `node --test src/lib/stow-project-file.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
/**
 * `.stow/project.json` — the stable identity of a checkout that has no git
 * remote (#8 owns the schema; the scanner only creates `{ id }` when the file
 * is missing and reads `id`). Never rewrites an existing file: client/role in
 * it are the user's (edited through #10's UI). In a git work tree the file is
 * kept out of `git status` via info/exclude so the Uncommitted column doesn't
 * jump by one for every no-remote repo.
 */
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { STOW_PROJECT_FILE, newProjectId } from './<#8 module>.mjs' // Task 0 mapping

const execFileAsync = promisify(execFile)
const EXCLUDE_LINE = '/.stow/'

export async function readStowId(root, { fs = nodeFs } = {}) {
    let text
    try {
        text = await fs.readFile(path.join(root, STOW_PROJECT_FILE), 'utf8')
    } catch (err) {
        if (err.code === 'ENOENT') return { id: null, error: null }
        return { id: null, error: err.code || err.message }
    }
    try {
        const id = JSON.parse(text)?.id
        return typeof id === 'string' && id ? { id, error: null } : { id: null, error: 'malformed' }
    } catch {
        return { id: null, error: 'malformed' }
    }
}

async function excludeFromGit(root, { fs, exec }) {
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'])
    const file = path.resolve(root, stdout.trim())
    const current = await fs.readFile(file, 'utf8').catch(() => '')
    if (current.split('\n').includes(EXCLUDE_LINE)) return
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + EXCLUDE_LINE + '\n')
}

export async function ensureStowFile(root, {
    git = false, fs = nodeFs, exec = execFileAsync,
    enabled = process.env.STOW_WRITE_PROJECT_FILES !== '0', newId = newProjectId,
} = {}) {
    const existing = await readStowId(root, { fs })
    if (existing.id || existing.error) return { ...existing, created: false }
    if (!enabled) return { id: null, created: false, error: null }
    try {
        const id = newId()
        await fs.mkdir(path.join(root, '.stow'), { recursive: true })
        // 'wx': never clobber a file that appeared between read and write.
        await fs.writeFile(path.join(root, STOW_PROJECT_FILE), JSON.stringify({ id }, null, 2) + '\n', { flag: 'wx' })
        if (git) await excludeFromGit(root, { fs, exec }).catch(() => {})
        return { id, created: true, error: null }
    } catch (err) {
        if (err.code === 'EEXIST') return { ...(await readStowId(root, { fs })), created: false }
        return { id: null, created: false, error: err.code || err.message }
    }
}
```

- [ ] **Step 4:** Run `node --test src/lib/stow-project-file.test.mjs`. Expected: PASS.
- [ ] **Step 5: Failing test — `.stow` must not bump `last_modified`.** Add to `src/scanner/index.test.mjs`:

```js
test('getLatestMtime ignores .stow/ so writing the project file does not trigger a rescan', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-mtime-'))
    await fs.writeFile(path.join(dir, 'a.js'), 'x')
    const old = new Date('2020-01-01T00:00:00Z')
    await fs.utimes(path.join(dir, 'a.js'), old, old)
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), '{"id":"p"}')
    assert.equal(await getLatestMtime(dir), old.toISOString())
    await fs.rm(dir, { recursive: true })
})
```

- [ ] **Step 6:** Run `node --test src/scanner/index.test.mjs`. Expected: the new test FAILS.
- [ ] **Step 7:** In `src/scanner/index.mjs`, add `'.stow'` to `DEFAULT_IGNORE_PATTERNS` (after `'.git'`). `isExcludedPath` in `discovery.mjs` already skips any dot-segment, so it needs no change.
- [ ] **Step 8:** Run `npm test`. Expected: PASS.
- [ ] **Step 9:** Commit: `git commit -am "feat(scanner): create/read .stow/project.json for no-remote checkouts (#9)"` (and `git add` the new files first).

---

### Task 3: `checkout-merge.mjs` — group, carry forward, reconcile the register

**Files:**
- Create: `src/lib/checkout-merge.mjs`
- Test: `src/lib/checkout-merge.test.mjs`

**Interfaces:**
- Consumes: rows carrying `checkout` and `_remoteUrl` (Task 1), stow ids (Task 2), and from #8 `normalizeRemoteUrl(url)` and `createProject({ identity, rows })`
- Produces: `identityFor({ remoteUrl, stowId, root }) → { key: string, source: 'remote'|'stow'|'path' }`
- Produces: `groupCheckouts(rows) → Map<identityKey, Map<root, row[]>>`
- Produces: `carryForwardMoved(rows, priorRows) → number` (count carried)
- Produces: `reconcileRegister(register, rows, { exists, createProject }) → { register, moved: Array<{from,to,projectId}>, created: number }`. Sets `row.project_id`. The input register is not mutated; a new object is returned.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identityFor, groupCheckouts, carryForwardMoved, reconcileRegister } from './checkout-merge.mjs'

const row = (directory, root, key, extra = {}) => ({
    directory, checkout: { root, subpath: directory.slice(root.length + 1), git: true },
    identity: { key, source: key.split(':')[0] }, ...extra,
})
let n = 0
const createProject = ({ identity }) => ({ id: `p${++n}`, identity: identity.key, locations: [] })
const exists = () => false

test('identityFor: remote beats stow id beats path; remote is normalized', () => {
    assert.equal(identityFor({ remoteUrl: 'git@gitlab.com:intelimail/blog.git', stowId: 'x', root: '/r' }).key,
        identityFor({ remoteUrl: 'https://u@gitlab.com/Intelimail/blog', root: '/q' }).key)
    assert.deepEqual(identityFor({ remoteUrl: null, stowId: 'p_1', root: '/r' }), { key: 'stow:p_1', source: 'stow' })
    assert.deepEqual(identityFor({ remoteUrl: null, stowId: null, root: '/r' }), { key: 'path:/r', source: 'path' })
})

test('btstack: 49 rows in one checkout → one project, one location', () => {
    const rows = [row('/e/btstack', '/e/btstack', 'remote:github.com/bluekitchen/btstack')]
    for (let i = 0; i < 48; i++) rows.push(row(`/e/btstack/sub${i}`, '/e/btstack', 'remote:github.com/bluekitchen/btstack'))
    const { register } = reconcileRegister({ projects: [] }, rows, { exists, createProject })
    assert.equal(register.projects.length, 1)
    assert.deepEqual(register.projects[0].locations.map(l => l.directory), ['/e/btstack'])
    assert.ok(rows.every(r => r.project_id === register.projects[0].id))
})

test('blog: four checkouts of one remote → one project, four locations', () => {
    const k = 'remote:gitlab.com/intelimail/blog'
    const rows = ['blog', 'blog-huha', 'blog-test', 'blog-volaco'].map(d => row(`/i/${d}`, `/i/${d}`, k))
    const { register } = reconcileRegister({ projects: [] }, rows, { exists, createProject })
    assert.equal(register.projects.length, 1)
    assert.equal(register.projects[0].locations.length, 4)
})

test('eranet: checkout root is not itself a row → still one location', () => {
    const k = 'remote:bitbucket.org/eranetproject/eranet3-analyza'
    const rows = ['eranet2/ZFK', 'eranet2/security', 'prechod-do-vyvoja'].map(s => row(`/b/era/${s}`, '/b/era', k))
    const { register } = reconcileRegister({ projects: [] }, rows, { exists, createProject })
    assert.deepEqual(register.projects[0].locations.map(l => l.directory), ['/b/era'])
})

test('rename: one vanished + one appeared → location rewritten, role/primary kept', () => {
    const k = 'stow:p_x'
    const reg = { projects: [{ id: 'P', identity: k, client: 'Acme', locations: [{ directory: '/old/x', role: 'deploy', primary: true }] }] }
    const rows = [row('/new/y', '/new/y', k)]
    const { register, moved } = reconcileRegister(reg, rows, { exists, createProject })
    assert.deepEqual(register.projects[0].locations, [{ directory: '/new/y', role: 'deploy', primary: true }])
    assert.equal(register.projects[0].client, 'Acme')
    assert.deepEqual(moved, [{ from: '/old/x', to: '/new/y', projectId: 'P' }])
    assert.equal(reg.projects[0].locations[0].directory, '/old/x') // input not mutated
})

test('two of three checkouts moved → paired by basename, then head_sha', () => {
    const k = 'remote:gitlab.com/a/app'
    const reg = { projects: [{ id: 'P', identity: k, locations: [
        { directory: '/a/app', role: 'primary', primary: true },
        { directory: '/a/app-test', role: 'experiment', primary: false },
        { directory: '/a/app-deploy', role: 'deploy', primary: false },
    ] }] }
    const rows = [
        row('/a/app', '/a/app', k),
        row('/moved/app-test', '/moved/app-test', k),
        row('/srv/live', '/srv/live', k, { git_info: { head_sha: 'h2' } }),
    ]
    const priorRows = [{ directory: '/a/app-deploy', checkout: { root: '/a/app-deploy', subpath: '' }, git_info: { head_sha: 'h2' } }]
    const { register } = reconcileRegister(reg, rows, { exists, createProject, priorRows })
    const byDir = Object.fromEntries(register.projects[0].locations.map(l => [l.directory, l.role]))
    assert.deepEqual(byDir, { '/a/app': 'primary', '/moved/app-test': 'experiment', '/srv/live': 'deploy' })
})

test('copied no-remote folder (same stow id) → two locations of one project', () => {
    const k = 'stow:p_same'
    const rows = [row('/x/a', '/x/a', k), row('/x/a-copy', '/x/a-copy', k)]
    const { register } = reconcileRegister({ projects: [] }, rows, { exists, createProject })
    assert.equal(register.projects.length, 1)
    assert.equal(register.projects[0].locations.length, 2)
})

test('location not seen but still on disk is kept', () => {
    const k = 'remote:x/y'
    const reg = { projects: [{ id: 'P', identity: k, locations: [{ directory: '/outside/root', role: 'stale', primary: false }] }] }
    const { register } = reconcileRegister(reg, [row('/in/y', '/in/y', k)], { exists: d => d === '/outside/root', createProject })
    assert.deepEqual(register.projects[0].locations.map(l => l.directory).sort(), ['/in/y', '/outside/root'])
})

test('project whose every location vanished stays with locations: []', () => {
    const reg = { projects: [{ id: 'P', identity: 'stow:gone', client: 'Acme', locations: [{ directory: '/gone', role: 'primary', primary: true }] }] }
    const { register } = reconcileRegister(reg, [], { exists, createProject })
    assert.deepEqual(register.projects[0].locations, [])
    assert.equal(register.projects[0].client, 'Acme')
})

test('carryForwardMoved: new row inherits ai_* of the vanished row with same identity+subpath', () => {
    const k = 'stow:p'
    const prior = [{ ...row('/old/p/web', '/old/p', k), ai_analysis: { category: '_Bizz' }, ai_derived: { status: 'active' } }]
    const rows = [row('/new/p/web', '/new/p', k), row('/new/p/api', '/new/p', k)]
    assert.equal(carryForwardMoved(rows, prior), 1)
    assert.deepEqual(rows[0].ai_analysis, { category: '_Bizz' })
    assert.equal(rows[1].ai_analysis, undefined)
})

test('carryForwardMoved: never overwrites, never copies from a row still present', () => {
    const k = 'remote:a/b'
    const prior = [{ ...row('/a', '/a', k), ai_analysis: { category: 'old' } }]
    const rows = [row('/a', '/a', k), row('/a2', '/a2', k, { ai_analysis: { category: 'own' } })]
    assert.equal(carryForwardMoved(rows, prior), 0)
    assert.deepEqual(rows[1].ai_analysis, { category: 'own' })
})
```

(The move-pairing test passes `priorRows` so that a vanished location's `head_sha` can be looked up. Add `priorRows = []` to the `reconcileRegister` options.)

- [ ] **Step 2:** Run `node --test src/lib/checkout-merge.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
/**
 * Virtual projects, step 2 (#9): turn scanned rows into register projects.
 * A project = one identity (normalized remote | .stow id | path fallback);
 * its locations = distinct checkout roots. Rows inside one checkout are
 * members, not copies. Pure — fs/git happen in checkout-location.mjs and
 * stow-project-file.mjs; persistence is #8's register I/O.
 */
import path from 'node:path'
import { normalizeRemoteUrl } from './<#8 module>.mjs' // Task 0 mapping

export function identityFor({ remoteUrl, stowId, root }) {
    if (remoteUrl) return { key: `remote:${normalizeRemoteUrl(remoteUrl)}`, source: 'remote' }
    if (stowId) return { key: `stow:${stowId}`, source: 'stow' }
    return { key: `path:${root}`, source: 'path' }
}

export function groupCheckouts(rows) {
    const groups = new Map()
    for (const r of rows) {
        if (!r.identity || !r.checkout) continue
        const byRoot = groups.get(r.identity.key) ?? groups.set(r.identity.key, new Map()).get(r.identity.key)
        const members = byRoot.get(r.checkout.root) ?? byRoot.set(r.checkout.root, []).get(r.checkout.root)
        members.push(r)
    }
    return groups
}

export function carryForwardMoved(rows, priorRows) {
    const present = new Set(rows.map(r => r.directory))
    const donors = new Map()
    for (const p of priorRows) {
        if (present.has(p.directory) || !p.identity || !p.checkout || !p.ai_analysis) continue
        donors.set(`${p.identity.key}\0${p.checkout.subpath}`, p)
    }
    const priorDirs = new Set(priorRows.map(p => p.directory))
    let carried = 0
    for (const r of rows) {
        if (priorDirs.has(r.directory) || r.ai_analysis || !r.identity || !r.checkout) continue
        const donor = donors.get(`${r.identity.key}\0${r.checkout.subpath}`)
        if (!donor) continue
        r.ai_analysis = donor.ai_analysis
        if (donor.ai_derived) r.ai_derived = donor.ai_derived
        carried++
    }
    return carried
}

function headOf(root, rows) {
    const atRoot = rows.find(r => r.checkout?.root === root && r.git_info?.head_sha)
    return atRoot?.git_info.head_sha ?? null
}

// Pair vanished with appeared roots: 1↔1 directly, else basename, else head_sha.
function pairMoves(vanished, appeared, { rows, priorRows }) {
    const pairs = []
    const v = [...vanished], a = [...appeared]
    const take = (match) => {
        for (const from of [...v]) {
            const i = a.findIndex(to => match(from, to))
            if (i >= 0) { pairs.push([from, a[i]]); a.splice(i, 1); v.splice(v.indexOf(from), 1) }
        }
    }
    if (v.length === 1 && a.length === 1) return { pairs: [[v[0], a[0]]], dropped: [], added: [] }
    take((from, to) => path.basename(from) === path.basename(to))
    take((from, to) => {
        const h = headOf(from, priorRows)
        return Boolean(h) && h === headOf(to, rows)
    })
    return { pairs, dropped: v, added: a }
}

export function reconcileRegister(register, rows, { exists, createProject, priorRows = [] }) {
    const projects = (register.projects ?? []).map(p => ({ ...p, locations: (p.locations ?? []).map(l => ({ ...l })) }))
    const byIdentity = new Map(projects.map(p => [p.identity, p]))
    const groups = groupCheckouts(rows)
    const moved = []
    let created = 0

    for (const [key, byRoot] of groups) {
        let project = byIdentity.get(key)
        if (!project) {
            const members = [...byRoot.values()].flat()
            project = { ...createProject({ identity: members[0].identity, rows: members }), locations: [] }
            projects.push(project)
            byIdentity.set(key, project)
            created++
        }
        const seen = new Set(byRoot.keys())
        const known = new Set(project.locations.map(l => l.directory))
        const vanished = project.locations.filter(l => !seen.has(l.directory) && !exists(l.directory)).map(l => l.directory)
        const appeared = [...seen].filter(root => !known.has(root))
        const { pairs, dropped, added } = pairMoves(vanished, appeared, { rows, priorRows })

        for (const [from, to] of pairs) {
            project.locations.find(l => l.directory === from).directory = to
            moved.push({ from, to, projectId: project.id })
        }
        project.locations = project.locations.filter(l => !dropped.includes(l.directory))
        for (const root of added) {
            project.locations.push({ directory: root, role: null, primary: project.locations.length === 0 })
        }
        for (const members of byRoot.values()) for (const r of members) r.project_id = project.id
    }

    // Projects not seen at all this scan: drop only locations gone from disk.
    for (const p of projects) {
        if (groups.has(p.identity)) continue
        p.locations = p.locations.filter(l => exists(l.directory))
    }
    return { register: { ...register, projects }, moved, created }
}
```

`role: null` for an added location is a placeholder for #8's default-role rule. In Task 0, replace it with #8's helper (e.g. `defaultRole(project, root)`) if #8 exports one. Otherwise `null` means "unset" for #10's UI.

- [ ] **Step 4:** Run `node --test src/lib/checkout-merge.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit: `git add src/lib/checkout-merge.* && git commit -m "feat(register): merge checkouts by identity, detect moved folders (#9)"`

---

### Task 4: Wire into the scanner, the scan routes and the quick refresh

**Files:**
- Modify: `src/scanner/index.mjs` (constructor, `loadExistingCache`, new `assignProjects`, `scanProjects`, `syncMetadata`)
- Modify: `src/app/api/scan/quick/route.js:131-224`
- Test: `src/scanner/index.test.mjs`

**Interfaces:**
- Consumes: `resolveLocations` (T1), `ensureStowFile` (T2), `identityFor`, `carryForwardMoved`, `reconcileRegister` (T3), and from #8 `loadRegister`, `saveRegister`, `createProject`
- Produces: `ProjectScanner#assignProjects(rows, { priorRows, exec, exists, register }) → Promise<{ register, moved, created, carried }>`. `scanProjects()` calls it before returning, and `syncMetadata` persists `this.register` after the ledger write.
- Options: `new ProjectScanner({ …, exec, loadRegister, saveRegister, createProject })`. Every option is injectable for tests; the defaults are #8's.

- [ ] **Step 1: Write the failing end-to-end test** (real git, temp dirs)

```js
import { execFileSync } from 'node:child_process'

test('scan merges two clones of one remote, and creates .stow for a no-remote dir', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-merge-'))
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' })
    const origin = path.join(base, 'origin.git')
    git(base, 'init', '--bare', '-q', origin)
    const root = path.join(base, 'root')
    await fs.mkdir(root)
    for (const name of ['blog', 'blog-test']) {
        git(root, 'clone', '-q', origin, name)
        await fs.writeFile(path.join(root, name, 'README.md'), '# blog\n')
        await fs.mkdir(path.join(root, name, 'docs'))
        await fs.writeFile(path.join(root, name, 'docs', 'README.md'), '# docs\n')
    }
    await fs.mkdir(path.join(root, 'notes'))
    await fs.writeFile(path.join(root, 'notes', 'README.md'), '# notes\n')

    let register = { projects: [] }
    let n = 0
    const scanner = new ProjectScanner({
        scanRoots: [root],
        loadRegister: async () => register,
        saveRegister: async (r) => { register = r },
        createProject: ({ identity }) => ({ id: `p${++n}`, identity: identity.key, locations: [] }),
    })
    const rows = await scanner.scanProjects()
    await scanner.syncMetadata(rows) // no syncFile → only the register is saved

    const blog = register.projects.find(p => p.identity.startsWith('remote:'))
    assert.equal(blog.locations.length, 2)                       // blog + blog-test
    assert.equal(rows.filter(r => r.project_id === blog.id).length, 4) // + their docs/ sub-folders
    const notes = register.projects.find(p => p.identity.startsWith('stow:'))
    assert.ok(notes)
    await fs.access(path.join(root, 'notes', '.stow', 'project.json'))

    // Second scan: stable ids, no new projects.
    const again = new ProjectScanner({ scanRoots: [root], loadRegister: async () => register,
        saveRegister: async (r) => { register = r }, createProject: () => assert.fail('no new project expected') })
    await again.syncMetadata(await again.scanProjects())
    assert.equal(register.projects.length, 2)
    await fs.rm(base, { recursive: true, force: true })
})

test('cached rows without checkout are backfilled on the next incremental scan', async () => {
    // Write a ledger row for an existing dir without `checkout`/`identity` and a
    // last_modified in the future so processProject returns the cached row,
    // then scan with syncFile: the returned row must now carry checkout+identity+project_id.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-backfill-'))
    const dir = path.join(base, 'p')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'README.md'), '# p\n')
    const ledger = path.join(base, 'ledger.jsonl')
    await fs.writeFile(ledger, JSON.stringify({ directory: dir, last_modified: '2999-01-01T00:00:00.000Z', project_name: 'p' }) + '\n')
    const scanner = new ProjectScanner({ scanRoots: [base], syncFile: ledger,
        loadRegister: async () => ({ projects: [] }), saveRegister: async () => {},
        createProject: ({ identity }) => ({ id: 'P', identity: identity.key, locations: [] }) })
    const [row] = await scanner.scanProjects()
    assert.equal(row.checkout.root, dir)
    assert.equal(row.identity.source, 'stow')
    assert.equal(row.project_id, 'P')
    await fs.rm(base, { recursive: true, force: true })
})

test('refreshProjectGit keeps checkout/identity/project_id (they live outside git_info)', async () => {
    const { refreshProjectGit } = await import('../lib/git-status.mjs')
    const project = { directory: '/x', git_info: { git_detected: true, head_sha: 'a' },
        checkout: { root: '/x', subpath: '', git: true }, identity: { key: 'remote:x', source: 'remote' }, project_id: 'P' }
    await refreshProjectGit(project, { readStatus: async () => ({ head_sha: 'b' }), fullGitInfo: async () => ({ git_detected: true, head_sha: 'b' }) })
    assert.deepEqual(project.checkout, { root: '/x', subpath: '', git: true })
    assert.equal(project.project_id, 'P')
})
```

- [ ] **Step 2:** Run `node --test src/scanner/index.test.mjs`. Expected: the first two new tests FAIL (no `checkout`/`project_id`). The third passes already and pins the invariant.

- [ ] **Step 3: Implement in `src/scanner/index.mjs`**

Constructor additions:

```js
        this.exec = options.exec           // undefined → modules' execFile default
        this.loadRegister = options.loadRegister || defaultLoadRegister   // #8
        this.saveRegister = options.saveRegister || defaultSaveRegister   // #8
        this.createProject = options.createProject || defaultCreateProject // #8
        this.register = null
```

New method (place it after `processProject`):

```js
    // Virtual projects (#9): checkout root + identity per row, then merge the
    // rows into register projects. Runs on *every* row (cached ones too) so an
    // existing ledger is backfilled on the first scan after upgrade.
    async assignProjects(rows, { priorRows = [...this.existingProjectsCache.values()] } = {}) {
        await resolveLocations(rows, { exec: this.exec })
        const stowByRoot = new Map()
        for (const r of rows) {
            // Only rows resolved *this run* and without a remote: `_remoteUrl` is
            // undefined for cached rows (they keep their stored identity) and a
            // string for remote-backed ones — neither may get a .stow file.
            if (r._remoteUrl !== null || stowByRoot.has(r.checkout.root)) continue
            stowByRoot.set(r.checkout.root, null) // one write per root
        }
        const limiter = new Semaphore(16)
        await Promise.all([...stowByRoot.keys()].map(root => limiter.run(async () => {
            const git = rows.find(r => r.checkout.root === root)?.checkout.git
            const res = await ensureStowFile(root, { git, exec: this.exec })
            if (res.error) this.onProgress({ type: 'stow_file_error', directory: root, error: res.error })
            stowByRoot.set(root, res.id)
        })))
        for (const r of rows) {
            r.identity = r._remoteUrl !== undefined || !r.identity
                ? identityFor({ remoteUrl: r._remoteUrl, stowId: stowByRoot.get(r.checkout.root), root: r.checkout.root })
                : r.identity
            delete r._remoteUrl
        }
        const carried = carryForwardMoved(rows, priorRows)
        const result = reconcileRegister(await this.loadRegister(), rows, {
            exists: (d) => existsSync(d), createProject: this.createProject, priorRows,
        })
        this.register = result.register
        for (const m of result.moved) this.onProgress({ type: 'moved', ...m })
        return { ...result, carried }
    }
```

Note on the identity line: rows whose `checkout` was already present were skipped by `resolveLocations` and have no `_remoteUrl`. They keep their stored `identity`. A row re-extracted by `processProject` is a fresh object with no `checkout`, so it is re-resolved. A changed `origin` URL is therefore picked up the next time that project's files change, or on `--force`. `stowByRoot` only covers rows that were resolved this run, and only those without a remote.

In `processProject`'s update branch, next to the `ai_analysis` carry: **do not** copy `checkout`/`identity` from `prior`. Re-resolving is what refreshes them.

`scanProjects()`: after the batch loop, before the `complete` event:

```js
        const assigned = await this.assignProjects(scannedProjects)
        this.onProgress({ type: 'projects_assigned', projects: assigned.register.projects.length,
            moved: assigned.moved.length, created: assigned.created, carried: assigned.carried })
```

`syncMetadata()`: after the ledger write (and also when `!this.syncFile`, so tests can inject `saveRegister`), restructure the early return:

```js
    async syncMetadata(projects, { allowShrink = false } = {}) {
        if (this.syncFile) {
            // …existing shrink guard + write, unchanged…
        }
        // Register after the ledger: a register failure must not lose the scan.
        if (this.register) {
            try { await this.saveRegister(this.register) }
            catch (err) { this.onProgress({ type: 'register_error', error: err.message }) }
        }
    }
```

The shrink guard still throws before either write. That is intended, since a refused scan must not rewrite the register's locations either.

Imports at the top of `index.mjs`:

```js
import { existsSync } from 'fs'
import { resolveLocations } from '../lib/checkout-location.mjs'
import { ensureStowFile } from '../lib/stow-project-file.mjs'
import { identityFor, carryForwardMoved, reconcileRegister } from '../lib/checkout-merge.mjs'
import { loadRegister as defaultLoadRegister, saveRegister as defaultSaveRegister,
    createProject as defaultCreateProject } from '../lib/<#8 module>.mjs' // Task 0 mapping
```

`checkout-location.mjs` imports `Semaphore` from `index.mjs`. That makes a circular ESM import, which is safe here because neither side uses the other at module-eval time. To avoid the cycle anyway, move `Semaphore` into `src/lib/semaphore.mjs` and re-export it from `index.mjs` (`export { Semaphore } from '../lib/semaphore.mjs'`), so the existing imports keep working.

- [ ] **Step 4:** Run `node --test src/scanner/index.test.mjs`. Expected: PASS.

- [ ] **Step 5: Quick refresh.** In `src/app/api/scan/quick/route.js`, before the "Single JSONL write", only when something was discovered:

```js
                if (discovered.length > 0) {
                    // New rows need a checkout/identity and a register project (#9).
                    const scanner = new ProjectScanner({ scanRoots: SCAN_ROOTS })
                    const priorRows = [...projectMap.values()].filter(p => !discovered.includes(p.directory))
                    await scanner.assignProjects([...projectMap.values()], { priorRows })
                    await scanner.syncMetadata([]) // syncFile unset → saves only the register
                }
```

`assignProjects` touches only rows without `checkout`, so the cost is just the discovered rows plus `loadRegister`/`saveRegister`. The `/api/scan` route and `scripts/scan.mjs` need no change: they already call `scanProjects()` + `syncMetadata()`.

- [ ] **Step 6:** Run `npm test && npm run lint`. Expected: PASS.

- [ ] **Step 7: Manual check on real data** (repo-local state, so the live ledger isn't touched):

```bash
mkdir -p /tmp/stow-9 && cp "$HOME/Library/Application Support/StowDashboardDeno/data/projects_metadata.jsonl" /tmp/stow-9/
STOW_STATE_DIR=/tmp/stow-9 STOW_WRITE_PROJECT_FILES=0 node scripts/scan.mjs -s
node -e 'const r=require("/tmp/stow-9/data/<register file>");console.log(r.projects.length, r.projects.filter(p=>p.locations.length>1).length)'
```

Expected on today's data: about 34 projects with >1 location (the spec's table). btstack, awesome-llm-apps and helicone each have 1 location. `STOW_WRITE_PROJECT_FILES=0` keeps this dry run from writing into ~400 real directories. Record the actual numbers in the PR.

- [ ] **Step 8:** Commit: `git commit -am "feat(scanner): assign rows to virtual projects on scan and auto-discovery (#9)"`

---

### Task 5: Docs

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1:** Under "Important Files", add `checkout-location.mjs`, `stow-project-file.mjs` and `checkout-merge.mjs`, one line each, matching the existing style.
- [ ] **Step 2:** Add a "### Virtual projects — checkouts (#9)" paragraph next to "Project Detection". Cover:
  - the row fields `checkout` / `identity` / `project_id` and why they sit outside `git_info`
  - identity order: remote (origin, else first) → `.stow` id → path
  - `.stow/project.json` is created only for no-remote checkout roots, kept out of git via `info/exclude`, and ignored for mtime
  - `STOW_WRITE_PROJECT_FILES=0`
  - move pairing order
  - an all-vanished project stays with `locations: []`
- [ ] **Step 3:** Add `STOW_WRITE_PROJECT_FILES` to the env block.
- [ ] **Step 4:** Commit: `git commit -am "docs: virtual projects — checkout merge (#9)"`

---

## Self-review notes

- Spec coverage: grouping and sub-folders (T1+T3), `.stow` read/write (T2), move by identity (T3 `reconcileRegister` + `carryForwardMoved`), quick refresh (T4), backfill (T4 test), no-dirty guarantees (T2), docs (T5).
- Names used across tasks: `resolveLocations`, `ensureStowFile`, `identityFor`, `groupCheckouts`, `carryForwardMoved`, `reconcileRegister`, `assignProjects`. The row fields are `checkout{root,subpath,git}`, `identity{key,source}`, `project_id`, and the transient `_remoteUrl`.
- The `<#8 module>` import paths are the only intentional unknowns. Task 0 resolves them.
