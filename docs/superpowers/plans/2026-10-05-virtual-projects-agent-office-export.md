# Virtual projects (#14): register export for agent-office (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run registry:export` writes `data/agent-office.json` (client → buildings, project → floors, primary checkout + remote), and `GET /api/registry/agent-office` serves the same document.

**Architecture:** A pure builder `buildAgentOfficeExport(registry, opts)` over #8's `loadRegistry()` output, plus a thin I/O wrapper (`exportAgentOffice`) that resolves the file through the state-dir helpers and writes it atomically. A CLI and a GET route call the wrapper or the builder. Nothing else in the app changes.

**Tech Stack:** Node ≥ 24 ESM (`.mjs`), `node:test` + `node:assert/strict`, `node:crypto` (sha1), Next.js 16 route handler.

**Spec:** `docs/superpowers/specs/2026-10-05-virtual-projects-agent-office-export-design.md`

## Global Constraints

- **Blocked on #8 (PR #17) and #9 (PR #16).** Don't start Task 1 until both are merged to `main`. Task 0 checks this.
- State paths only through `src/lib/state-dir.mjs` (`dataFile('agent-office.json', opts)`), resolved at call time, never at module eval.
- Tests are colocated `*.test.mjs`, run with `node --test`, and touch no real home dir or ledger (`mkdtemp` + `base`).
- Output format id `"stow-dashboard/agent-office"`, `version: 1`.
- Floor id must match `^[a-z0-9-]{1,40}$` (agent-office's floor id rule).
- `repo` is `owner/name` **only** for `github.com` remotes, otherwise `null`.
- Never emit `git_info.remotes`; only #8's normalized `remote`.
- Don't touch the scanner, UI, sessions or MCP server (other issues' scope).

## Review Focus

1. A project whose **primary is an agent-office worktree** (the dashboard itself is checked out under `_AgentOffice/.../.agent-office/worktrees/*`). Expected: the floor `dir` is the main checkout, never the worktree. Pinned in Task 1.
2. **Unicode / punctuation in project names** (`Biblia čítanie`, `next.js-demo`, `_tools`). Expected: a valid, non-empty floor id. Pinned in Task 1.
3. **A primary deleted since the last scan.** Expected: the next existing location becomes `dir`; nothing points at a missing folder. Pinned in Task 1.
4. **Stale `.tmp` left by a crashed write**, or a write into a missing `data/` dir. Expected: `data/` is created, no `.tmp` is left, and the old file survives a failure. Pinned in Task 2.
5. **`--client` typo.** Expected: a non-zero exit / 404 with the message, not an empty file. Pinned in Tasks 2 and 3.

---

### Task 0: Rebase onto the prerequisites

**Files:** none (verification only)

- [ ] **Step 1: Check that #8 and #9 are merged**

```bash
git fetch origin
gh pr view 17 --json state -q .state   # expect MERGED
gh pr list --state merged --search "#9 in:body" --json number,title
git rebase origin/main
```

- [ ] **Step 2: Confirm the contract the spec assumes**

```bash
grep -n "^export" src/lib/registry/registry.mjs src/lib/registry/client.mjs
node scripts/registry.mjs --json | node -e 'const r=JSON.parse(require("fs").readFileSync(0));const p=r.projects.find(p=>p.locations.length>1);console.log(Object.keys(r),Object.keys(p),p.locations[0])'
```

Expected: `loadRegistry`, `clientKey` exported; a project has `key,kind,name,remote,client,primary,locations,warnings`, and a location has `directory,role,last_activity`. If a name differs, update the import lines and the field mapping in Task 1 (and the spec's contract table) before writing code. Also note the type of `last_activity` (ms or ISO).

### Task 1: Pure builder

**Files:**
- Create: `src/lib/registry/agent-office-export.mjs`
- Test: `src/lib/registry/agent-office-export.test.mjs`

**Interfaces:**
- Consumes: `clientKey(name)` from `./client.mjs` (#8); the registry shape from `loadRegistry` (#8).
- Produces:
  - `EXPORT_FORMAT = 'stow-dashboard/agent-office'`, `EXPORT_VERSION = 1`, `UNASSIGNED_ID = 'unassigned'`
  - `isWorktreePath(dir: string) → boolean`
  - `githubRepo(remote: string|null) → string|null`
  - `floorId(name: string, key: string) → string`
  - `buildAgentOfficeExport(registry, { now = Date.now(), includeUnassigned = false, client, exists = existsSync } = {}) → doc`. Throws `Error` with `code = 'UNKNOWN_CLIENT'` when `client` matches no building.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/registry/agent-office-export.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentOfficeExport, floorId, githubRepo, isWorktreePath, EXPORT_FORMAT,
} from './agent-office-export.mjs'

const B = '/Users/u/Projekty/_Bizz/Intelimail'
const loc = (directory, role, last_activity = null) => ({ directory, role, role_source: 'derived', last_activity, record_id: null, stow_id: null })
const project = (o) => ({ kind: 'git', remote: null, client: null, warnings: [], ...o })
const intelimail = { id: 'intelimail', name: 'Intelimail', source: 'ai' }

const blog = project({
  key: 'git:gitlab.com/intelimail/blog', name: 'blog', remote: 'gitlab.com/intelimail/blog', client: intelimail,
  primary: `${B}/blog`,
  locations: [
    loc(`${B}/blog`, 'primary', '2026-10-04T12:00:00.000Z'),
    loc(`${B}/blog-huha`, 'experiment', '2026-09-01T00:00:00.000Z'),
    loc(`${B}/blog-volaco`, 'stale', '2025-01-01T00:00:00.000Z'),
  ],
})
const app = project({
  key: 'git:github.com/intelimail/app', name: 'app', remote: 'github.com/intelimail/app', client: intelimail,
  primary: `${B}/app`, locations: [loc(`${B}/app`, 'primary', '2026-10-05T08:00:00.000Z')],
})
const loose = project({ key: 'path:/Users/u/x', kind: 'path', name: 'x', primary: '/Users/u/x', locations: [loc('/Users/u/x', 'primary')] })
const reg = (...projects) => {
  const clients = new Map()
  for (const p of projects) if (p.client) {
    const c = clients.get(p.client.id) ?? { id: p.client.id, name: p.client.name, projects: [] }
    c.projects.push(p.key); clients.set(c.id, c)
  }
  return { clients: [...clients.values()], projects, stats: {} }
}
const all = () => true
const NOW = Date.parse('2026-10-05T18:00:00.000Z')

test('blog 4x → one floor, locations primary first, gitlab has no repo', () => {
  const doc = buildAgentOfficeExport(reg(blog), { now: NOW, exists: all })
  assert.equal(doc.format, EXPORT_FORMAT)
  assert.equal(doc.version, 1)
  assert.equal(doc.generated_at, '2026-10-05T18:00:00.000Z')
  assert.equal(doc.buildings.length, 1)
  const [b] = doc.buildings
  assert.deepEqual([b.id, b.name], ['intelimail', 'Intelimail'])
  const [f] = b.floors
  assert.equal(f.dir, `${B}/blog`)
  assert.equal(f.repo, null)
  assert.equal(f.remote, 'gitlab.com/intelimail/blog')
  assert.equal(f.project_key, 'git:gitlab.com/intelimail/blog')
  assert.equal(f.last_activity, '2026-10-04T12:00:00.000Z')
  assert.deepEqual(f.locations.map(l => l.role), ['primary', 'experiment', 'stale'])
  assert.deepEqual(Object.keys(f.locations[0]), ['dir', 'role'])
})

test('githubRepo only for github.com', () => {
  assert.equal(githubRepo('github.com/IntelIMail/App'), 'IntelIMail/App')
  assert.equal(githubRepo('github.com/o/r/sub'), 'o/r')
  assert.equal(githubRepo('gitlab.com/o/r'), null)
  assert.equal(githubRepo('notgithub.com/o/r'), null)
  assert.equal(githubRepo(null), null)
})

test('floorId: stable, slug-safe, unique per key', () => {
  const re = /^[a-z0-9-]{1,40}$/
  for (const n of ['web', 'Biblia čítanie', 'next.js-demo', '_tools', '!!!', 'x'.repeat(80)]) {
    const id = floorId(n, `git:h/${n}`)
    assert.match(id, re, n)
  }
  assert.equal(floorId('web', 'git:a/web'), floorId('web', 'git:a/web'))
  assert.notEqual(floorId('web', 'git:a/web'), floorId('web', 'git:b/web'))
  assert.match(floorId('Biblia čítanie', 'k'), /^biblia-citanie-[0-9a-f]{6}$/)
  assert.match(floorId('!!!', 'k'), /^project-[0-9a-f]{6}$/)
})

test('isWorktreePath', () => {
  assert.ok(isWorktreePath('/p/_AgentOffice/o/r/.agent-office/worktrees/bolt-5310'))
  assert.ok(isWorktreePath('/p/r/.claude/worktrees/feat'))
  assert.ok(!isWorktreePath('/p/r'))
})

test('worktree primary → falls back to the most active real checkout', () => {
  const wt = '/p/r/.agent-office/worktrees/bolt-1'
  const p = project({ ...app, primary: wt, locations: [loc(wt, 'primary', '2026-10-05T10:00:00Z'), loc(`${B}/app`, 'experiment', '2026-10-01T00:00:00Z')] })
  const [f] = buildAgentOfficeExport(reg(p), { now: NOW, exists: all }).buildings[0].floors
  assert.equal(f.dir, `${B}/app`)
  assert.deepEqual(f.locations.map(l => l.dir), [`${B}/app`])
})

test('only worktrees or only missing dirs → skipped', () => {
  const wt = project({ ...app, key: 'git:github.com/o/wt', primary: '/r/.claude/worktrees/a', locations: [loc('/r/.claude/worktrees/a', 'primary')] })
  const doc = buildAgentOfficeExport(reg(wt, blog), { now: NOW, exists: d => d !== `${B}/blog` && d !== `${B}/blog-huha` && d !== `${B}/blog-volaco` })
  assert.deepEqual(doc.skipped, [
    { project_key: 'git:github.com/o/wt', reason: 'no-location' },
    { project_key: blog.key, reason: 'no-location' },
  ])
  assert.deepEqual(doc.buildings, [])
  assert.deepEqual(doc.stats, { buildings: 0, floors: 0, skipped: 2 })
})

test('deleted primary → next existing location', () => {
  const doc = buildAgentOfficeExport(reg(blog), { now: NOW, exists: d => d !== `${B}/blog` })
  assert.equal(doc.buildings[0].floors[0].dir, `${B}/blog-huha`)
})

test('unassigned off by default, own building when asked', () => {
  assert.equal(buildAgentOfficeExport(reg(loose), { now: NOW, exists: all }).buildings.length, 0)
  const doc = buildAgentOfficeExport(reg(loose, blog), { now: NOW, exists: all, includeUnassigned: true })
  assert.deepEqual(doc.buildings.map(b => b.id), ['intelimail', 'unassigned'])
  assert.equal(doc.buildings[1].name, 'Unassigned')
})

test('client filter by name or spelling variant; unknown throws', () => {
  const other = project({ ...loose, key: 'git:github.com/t/t', client: { id: 'trisoft', name: 'TriSoft', source: 'ai' } })
  const r = reg(blog, other)
  for (const c of ['Intelimail', 'InteliMail', 'intelimail']) {
    assert.deepEqual(buildAgentOfficeExport(r, { now: NOW, exists: all, client: c }).buildings.map(b => b.id), ['intelimail'])
  }
  assert.throws(() => buildAgentOfficeExport(r, { now: NOW, exists: all, client: 'Intelimial' }), e => e.code === 'UNKNOWN_CLIENT')
})

test('floors by last activity desc, null last; deterministic', () => {
  const quiet = project({ ...blog, key: 'git:gitlab.com/intelimail/aaa', name: 'aaa', locations: [loc(`${B}/aaa`, 'primary')], primary: `${B}/aaa` })
  const r = reg(blog, quiet, app)
  const a = buildAgentOfficeExport(r, { now: NOW, exists: all })
  assert.deepEqual(a.buildings[0].floors.map(f => f.name), ['app', 'blog', 'aaa'])
  assert.deepEqual(buildAgentOfficeExport(r, { now: NOW, exists: all }), a)
})

test('last_activity accepts ms numbers', () => {
  const p = project({ ...app, locations: [loc(`${B}/app`, 'primary', Date.parse('2026-10-05T08:00:00.000Z'))] })
  assert.equal(buildAgentOfficeExport(reg(p), { now: NOW, exists: all }).buildings[0].floors[0].last_activity, '2026-10-05T08:00:00.000Z')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/lib/registry/agent-office-export.test.mjs`
Expected: FAIL with `Cannot find module './agent-office-export.mjs'`

- [ ] **Step 3: Implement**

```js
// src/lib/registry/agent-office-export.mjs
// Register (#8) → the building/floor document agent-office reads (#14):
// one building per client, one floor per project at its primary checkout.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { clientKey } from './client.mjs'

export const EXPORT_FORMAT = 'stow-dashboard/agent-office'
export const EXPORT_VERSION = 1
export const UNASSIGNED_ID = 'unassigned'

// Worker worktrees are short-lived checkouts of a project, never its floor.
const WORKTREE_RE = /\/\.(?:agent-office|claude)\/worktrees\//

export function isWorktreePath(dir) {
  return WORKTREE_RE.test(dir + '/')
}

// Agent-office floors take a GitHub `owner/name` only; other hosts open by dir.
export function githubRepo(remote) {
  const m = /^github\.com\/([^/]+)\/([^/]+)/.exec(remote || '')
  return m ? `${m[1]}/${m[2]}` : null
}

export function floorId(name, key) {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 6)
  const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 33).replace(/-+$/, '')
  return `${slug || 'project'}-${hash}`
}

const toMs = v => (v == null ? null : (Number.isFinite(+v) && typeof v !== 'string' ? +v : Date.parse(v)))
const toIso = ms => (ms == null || Number.isNaN(ms) ? null : new Date(ms).toISOString())

function toFloor(p, exists) {
  const live = p.locations.filter(l => !isWorktreePath(l.directory) && exists(l.directory))
  if (!live.length) return null
  const byActivity = [...live].sort((a, b) => (toMs(b.last_activity) ?? -Infinity) - (toMs(a.last_activity) ?? -Infinity))
  const main = live.find(l => l.directory === p.primary) ?? byActivity[0]
  const ordered = [main, ...live.filter(l => l !== main)]
  const last = Math.max(...live.map(l => toMs(l.last_activity) ?? -Infinity))
  return {
    id: floorId(p.name, p.key),
    name: p.name,
    project_key: p.key,
    dir: main.directory,
    repo: githubRepo(p.remote),
    remote: p.remote ?? null,
    last_activity: Number.isFinite(last) ? toIso(last) : null,
    locations: ordered.map(l => ({ dir: l.directory, role: l.role })),
  }
}

const byActivityThenName = (a, b) =>
  (b.last_activity ?? '').localeCompare(a.last_activity ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function buildAgentOfficeExport(registry, { now = Date.now(), includeUnassigned = false, client, exists = existsSync } = {}) {
  const buildings = registry.clients.map(c => ({ id: c.id, name: c.name, keys: new Set(c.projects), floors: [] }))
  if (includeUnassigned) buildings.push({ id: UNASSIGNED_ID, name: 'Unassigned', keys: null, floors: [] })

  let wanted = buildings
  if (client != null) {
    const k = clientKey(client)
    wanted = buildings.filter(b => b.id === k || clientKey(b.name) === k)
    if (!wanted.length) throw Object.assign(new Error(`Unknown client: ${client}`), { code: 'UNKNOWN_CLIENT' })
  }

  const skipped = []
  for (const p of registry.projects) {
    const b = wanted.find(b => (b.keys ? b.keys.has(p.key) : !p.client))
    if (!b) continue
    const floor = toFloor(p, exists)
    if (floor) b.floors.push(floor)
    else skipped.push({ project_key: p.key, reason: 'no-location' })
  }

  const out = wanted.filter(b => b.floors.length)
    .map(b => ({ id: b.id, name: b.name, floors: b.floors.sort(byActivityThenName) }))
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generated_at: new Date(now).toISOString(),
    buildings: out,
    skipped,
    stats: { buildings: out.length, floors: out.reduce((n, b) => n + b.floors.length, 0), skipped: skipped.length },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/lib/registry/agent-office-export.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/registry/agent-office-export.mjs src/lib/registry/agent-office-export.test.mjs
git commit -m "feat(registry): build the agent-office export (client → building, project → floor)"
```

### Task 2: File writer + CLI

**Files:**
- Modify: `src/lib/registry/agent-office-export.mjs` (append `exportAgentOffice`, `EXPORT_FILE`)
- Modify: `src/lib/registry/agent-office-export.test.mjs` (append tests)
- Create: `scripts/registry-export.mjs`
- Modify: `package.json` (`"registry:export": "node scripts/registry-export.mjs"`, next to `"registry"`)

**Interfaces:**
- Consumes: `buildAgentOfficeExport` (Task 1); `loadRegistry({ base })` from `./registry.mjs` (#8); `dataFile(name, opts)` from `../state-dir.mjs`.
- Produces: `EXPORT_FILE = 'agent-office.json'`; `exportAgentOffice({ base, includeUnassigned, client, write = true, now, load = loadRegistry, exists } = {}) → Promise<{ doc, file }>` (`file` is `null` when `write` is false).

- [ ] **Step 1: Write the failing tests** (append)

```js
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exportAgentOffice, EXPORT_FILE } from './agent-office-export.mjs'

test('exportAgentOffice writes data/agent-office.json atomically', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-ao-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const prev = process.env.STOW_STATE_DIR
  process.env.STOW_STATE_DIR = base
  t.after(() => { if (prev === undefined) delete process.env.STOW_STATE_DIR; else process.env.STOW_STATE_DIR = prev })

  const { doc, file } = await exportAgentOffice({ base, now: NOW, load: async () => reg(blog), exists: all })
  assert.equal(file, path.join(base, 'data', EXPORT_FILE))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), doc)
  assert.deepEqual((await readdir(path.join(base, 'data'))).filter(n => n.endsWith('.tmp')), [])
})

test('exportAgentOffice: write:false returns the doc only; unknown client rejects and keeps the old file', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-ao-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const prev = process.env.STOW_STATE_DIR
  process.env.STOW_STATE_DIR = base
  t.after(() => { if (prev === undefined) delete process.env.STOW_STATE_DIR; else process.env.STOW_STATE_DIR = prev })
  await mkdir(path.join(base, 'data'))
  await writeFile(path.join(base, 'data', EXPORT_FILE), 'old')

  const r = await exportAgentOffice({ base, write: false, now: NOW, load: async () => reg(blog), exists: all })
  assert.equal(r.file, null)
  await assert.rejects(exportAgentOffice({ base, client: 'nope', load: async () => reg(blog), exists: all }), e => e.code === 'UNKNOWN_CLIENT')
  assert.equal(await readFile(path.join(base, 'data', EXPORT_FILE), 'utf8'), 'old')
})
```

(If `resolveStateDir` on the merged `main` prefers the app-data dir over `base` even with `STOW_STATE_DIR` set, adjust only the env setup; the assertions stay.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test src/lib/registry/agent-office-export.test.mjs`
Expected: FAIL, `exportAgentOffice` is not exported

- [ ] **Step 3: Implement** (append to `agent-office-export.mjs`; move the new imports to the top)

```js
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataFile } from '../state-dir.mjs'
import { loadRegistry } from './registry.mjs'

export const EXPORT_FILE = 'agent-office.json'

export async function exportAgentOffice({ base, includeUnassigned = false, client, write = true, now = Date.now(), load = loadRegistry, exists } = {}) {
  const opts = base ? { base } : {}
  const registry = await load(opts)
  const doc = buildAgentOfficeExport(registry, { now, includeUnassigned, client, ...(exists ? { exists } : {}) })
  if (!write) return { doc, file: null }
  const file = dataFile(EXPORT_FILE, opts)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n')
  await rename(tmp, file)
  return { doc, file }
}
```

```js
#!/usr/bin/env node
// scripts/registry-export.mjs
// Writes the agent-office export (#14): data/agent-office.json.
//   node scripts/registry-export.mjs [--unassigned] [--client <name>] [--stdout]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportAgentOffice } from '../src/lib/registry/agent-office-export.mjs'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const ci = argv.indexOf('--client')
const client = ci >= 0 ? argv[ci + 1] : undefined
const toStdout = argv.includes('--stdout')

try {
  const { doc, file } = await exportAgentOffice({ base, client, includeUnassigned: argv.includes('--unassigned'), write: !toStdout })
  if (toStdout) process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
  else console.log(`${doc.stats.buildings} buildings, ${doc.stats.floors} floors, ${doc.stats.skipped} skipped → ${file}`)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
```

- [ ] **Step 4: Run the tests, then the CLI on real data**

Run: `node --test src/lib/registry/agent-office-export.test.mjs`. Expected: PASS (13 tests).
Run: `npm run registry:export -- --stdout --client Intelimail | head -40`. Expected: one `intelimail` building, a `blog` floor with 4 locations, no credentials in any remote (`npm run registry:export -- --stdout --unassigned | grep -cE '"remote": "[^"]*@'` → `0`; a bare `@` does occur, in npm-scoped project names like `@idea-council/core`).
Run: `npm run registry:export -- --client Intelimial; echo $?`. Expected: `Unknown client: Intelimial` and `1`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/registry/agent-office-export.mjs src/lib/registry/agent-office-export.test.mjs scripts/registry-export.mjs package.json
git commit -m "feat(registry): npm run registry:export writes data/agent-office.json"
```

### Task 3: GET route + docs

**Files:**
- Create: `src/app/api/registry/agent-office/route.js`
- Modify: `CLAUDE.md` (Commands: `npm run registry:export`; Important Files: the new module, script and route; a short "Agent Office export" paragraph under the virtual-projects section #8 adds)

**Interfaces:**
- Consumes: `exportAgentOffice({ includeUnassigned, client, write: false })` (Task 2).
- Produces: `GET /api/registry/agent-office?unassigned=1&client=<name>` → 200 doc | 404 `{error}` (unknown client) | 500 `{error}`.

- [ ] **Step 1: Implement**

```js
// src/app/api/registry/agent-office/route.js
import { exportAgentOffice } from '@/lib/registry/agent-office-export.mjs'

// The agent-office export (#14), built per request. Read-only: the file
// data/agent-office.json is written only by `npm run registry:export`.
export async function GET(request) {
    const q = new URL(request.url).searchParams
    try {
        const { doc } = await exportAgentOffice({
            includeUnassigned: q.get('unassigned') === '1',
            client: q.get('client') || undefined,
            write: false,
        })
        return Response.json(doc)
    } catch (error) {
        const status = error.code === 'UNKNOWN_CLIENT' ? 404 : 500
        return Response.json({ error: error.message }, { status })
    }
}
```

- [ ] **Step 2: Check it against the dev server**

Run: `npm run dev`, then
`curl -s localhost:3089/api/registry/agent-office | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.format,d.stats)'`
Expected: `stow-dashboard/agent-office { buildings: N, floors: M, skipped: K }`.
`curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3089/api/registry/agent-office?client=nope'` → `404`.

- [ ] **Step 3: Update CLAUDE.md** (the three places listed under Files)

- [ ] **Step 4: Full verification**

Run: `npm test`. Expected: all pass.
Run: `npx eslint src/lib/registry scripts/registry-export.mjs src/app/api/registry`. Expected: clean (repo-wide `npm run lint` has pre-existing errors; add none).

- [ ] **Step 5: Commit and open the PR**

```bash
git add src/app/api/registry/agent-office/route.js CLAUDE.md
git commit -m "feat(registry): GET /api/registry/agent-office; docs"
```

PR body: "Closes #14", plus the real-data numbers from Task 2 Step 4.
