# Virtual projects 1/6 — register model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, tested model that turns ledger rows plus `.stow/project.json` metas plus `data/registry.json` into Client → Project → Location, and a read-only `npm run registry` CLI that checks it against real data.

**Architecture:** Four focused modules under `src/lib/registry/`: `identity.mjs` (remote → key), `stow-meta.mjs` (per-checkout file I/O), `client.mjs` (client catalog and name normalisation), and `registry.mjs` (pure `buildRegistry` plus the `loadRegistry` I/O wrapper). Nothing in the scanner, UI or sessions changes. Those belong to #9–#14.

**Tech Stack:** Node ≥ 24 ESM `.mjs`, `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-virtual-projects-register-design.md`

## Global Constraints

- Paths to `data/` only via `src/lib/state-dir.mjs` (`ledgerFile`, `dataFile`), resolved at call time, never at module eval.
- Subprocess calls (`git`) go through an injectable `exec(cmd, args) → Promise<stdout>`; tests never run real git.
- Tests are colocated `<module>.test.mjs`; fs tests use `mkdtemp` and clean up.
- Roles: exactly `primary | deploy | experiment | stale`.
- Project keys: `git:<host/path>`, `stow:<id>`, `path:<directory>`.
- Credentials in remote URLs must never appear in a key or in CLI output.
- `.stow/project.json` is never overwritten when it is malformed.

## Review Focus

- Remote with embedded `user:token@` reaches the key → must be stripped (identity test pins it).
- Proxy-prefixed URL (`https://github.91chi.fun/https://github.com/a/b.git`) → keys as `github.com/a/b` (identity test).
- Project inside a git subdirectory gets `.stow/` written → `info/exclude` pattern must be unanchored (`.stow/`) so `git status` stays clean (stow-meta test asserts the exact line).
- `writeStowMeta` run twice → exclude line not duplicated, `id` unchanged (stow-meta test).
- AI client `new:Archon` vs `archon` vs folder `_Bizz/archon` → one client (client test).

---

### Task 1: Remote identity

**Files:**
- Create: `src/lib/registry/identity.mjs`
- Test: `src/lib/registry/identity.test.mjs`

**Interfaces:**
- Produces: `normalizeRemote(url: string): string|null`, `remoteOwner(remote: string|null): string|null`, `identityOf(record, meta|null): { key, kind: 'git'|'stow'|'path', remote: string|null }`

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemote, remoteOwner, identityOf } from './identity.mjs'

test('normalizeRemote: scp, https, ssh with port, credentials, proxy, local', () => {
  assert.equal(normalizeRemote('git@gitlab.com:intelimail/llm/sentiment.git'), 'gitlab.com/intelimail/llm/sentiment')
  assert.equal(normalizeRemote('https://github.com/erikmeliska/Edupage-API.git'), 'github.com/erikmeliska/edupage-api')
  assert.equal(normalizeRemote('https://user:s3cret@gitlab.com/slovenskoit/uahelp.git'), 'gitlab.com/slovenskoit/uahelp')
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/team/app.git/'), 'gitlab.example.com/team/app')
  assert.equal(normalizeRemote('https://www.github.com/a/b'), 'github.com/a/b')
  assert.equal(normalizeRemote('https://github.91chi.fun/https://github.com/earlephilhower/ESP8266Audio.git'), 'github.com/earlephilhower/esp8266audio')
  assert.equal(normalizeRemote('git@bitbucket.org:/boysfromheaven/pdftable2json.git'), 'bitbucket.org/boysfromheaven/pdftable2json')
  assert.equal(normalizeRemote('/Users/me/repos/x.git'), null)
  assert.equal(normalizeRemote('../x'), null)
  assert.equal(normalizeRemote('file:///srv/x.git'), null)
  assert.equal(normalizeRemote('https://github.com/'), null)
  assert.equal(normalizeRemote(''), null)
  assert.equal(normalizeRemote(undefined), null)
})

test('remoteOwner: top-level owner/group', () => {
  assert.equal(remoteOwner('gitlab.com/intelimail/llm/sentiment'), 'intelimail')
  assert.equal(remoteOwner('github.com/a/b'), 'a')
  assert.equal(remoteOwner('github.com/onlyrepo'), null)
  assert.equal(remoteOwner(null), null)
})

test('identityOf: remote wins, then stow id, then path', () => {
  const git = { directory: '/p/blog-test', git_info: { remotes: ['/local/mirror', 'git@gitlab.com:intelimail/blog.git'] } }
  assert.deepEqual(identityOf(git, { id: 'p_aaaaaaaaaaaa' }), { key: 'git:gitlab.com/intelimail/blog', kind: 'git', remote: 'gitlab.com/intelimail/blog' })
  assert.deepEqual(identityOf({ directory: '/p/x', git_info: { remotes: [] } }, { id: 'p_bbbbbbbbbbbb' }), { key: 'stow:p_bbbbbbbbbbbb', kind: 'stow', remote: null })
  assert.deepEqual(identityOf({ directory: '/p/y' }, null), { key: 'path:/p/y', kind: 'path', remote: null })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node --test src/lib/registry/identity.test.mjs` (module not found).

- [ ] **Step 3: Implement**

```js
/**
 * Project identity for the virtual-project register (#8): a hosted remote
 * URL normalised to host/path, else the stable id from .stow/project.json,
 * else the directory itself (unstable until #9 writes an id).
 */

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i
// scp-like `user@host:path`; the lookahead keeps `C:\` and `x://` out.
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

export function normalizeRemote(url) {
  if (typeof url !== 'string') return null
  let s = url.trim()
  if (!s) return null
  // Proxy/mirror prefixes embed the real URL in the path.
  const inner = s.slice(1).search(/https?:\/\//i)
  if (inner >= 0) s = s.slice(inner + 1)

  let host, rest
  const m = s.match(SCHEME)
  if (m) {
    if (m[1].toLowerCase() === 'file') return null
    const slash = m[2].indexOf('/')
    if (slash < 0) return null
    host = m[2].slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '')
    rest = m[2].slice(slash + 1)
  } else {
    const scp = s.match(SCP)
    if (!scp) return null
    host = scp[1]
    rest = scp[2]
  }
  host = host.toLowerCase().replace(/^www\./, '')
  const p = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
  if (!host || !p) return null
  return `${host}/${p}`
}

export function remoteOwner(remote) {
  if (!remote) return null
  const segs = remote.split('/')
  return segs.length >= 3 ? segs[1] : null
}

export function identityOf(record, meta) {
  for (const url of record?.git_info?.remotes || []) {
    const remote = normalizeRemote(url)
    if (remote) return { key: `git:${remote}`, kind: 'git', remote }
  }
  if (meta?.id) return { key: `stow:${meta.id}`, kind: 'stow', remote: null }
  return { key: `path:${record.directory}`, kind: 'path', remote: null }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git add src/lib/registry/identity*.mjs && git commit -m "feat(registry): remote URL identity for virtual projects"`

### Task 2: `.stow/project.json` I/O

**Files:**
- Create: `src/lib/registry/stow-meta.mjs`
- Test: `src/lib/registry/stow-meta.test.mjs`

**Interfaces:**
- Produces: `ROLES`, `newProjectId(): string` (`/^p_[a-z2-7]{12}$/`), `parseStowMeta(text) → { meta|null, warnings: string[] }`, `readStowMeta(dir) → Promise<{ meta|null, warnings }>`, `writeStowMeta(dir, patch, { exec }) → Promise<meta>` (a `null` patch value deletes the key; throws on a malformed existing file), `excludeFromGit(dir, { exec }) → Promise<boolean>`.

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { newProjectId, parseStowMeta, readStowMeta, writeStowMeta, excludeFromGit } from './stow-meta.mjs'

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'stow-meta-')) }

test('newProjectId: format and uniqueness', () => {
  const a = newProjectId(), b = newProjectId()
  assert.match(a, /^p_[a-z2-7]{12}$/)
  assert.notEqual(a, b)
})

test('parseStowMeta: valid, invalid fields, malformed', () => {
  assert.deepEqual(parseStowMeta('{"version":1,"id":"p_abcdefghijkl","client":"Intelimail","role":"deploy","x":1}'),
    { meta: { version: 1, id: 'p_abcdefghijkl', client: 'Intelimail', role: 'deploy', x: 1 }, warnings: [] })
  const r = parseStowMeta('{"id":"p_abcdefghijkl","client":"  ","role":"prod"}')
  assert.deepEqual(r.meta, { id: 'p_abcdefghijkl' })
  assert.equal(r.warnings.length, 2)
  assert.equal(parseStowMeta('{nope').meta, null)
  assert.equal(parseStowMeta('[]').meta, null)
  assert.equal(parseStowMeta('{"client":"X"}').meta, null) // id required
})

test('readStowMeta: missing file is no meta, no warning', async () => {
  const dir = await tmp()
  try { assert.deepEqual(await readStowMeta(dir), { meta: null, warnings: [] }) }
  finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('writeStowMeta: creates id, merges, deletes on null, keeps unknown keys, excludes from git once', async () => {
  const dir = await tmp()
  const exclude = path.join(dir, 'fakegit', 'info', 'exclude')
  const calls = []
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return 'fakegit/info/exclude\n' }
  try {
    const m1 = await writeStowMeta(dir, { client: 'Intelimail' }, { exec })
    assert.match(m1.id, /^p_[a-z2-7]{12}$/)
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.stow', 'project.json'), 'utf8'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), JSON.stringify({ ...raw, extra: true }))
    const m2 = await writeStowMeta(dir, { role: 'stale', client: null }, { exec })
    assert.deepEqual(m2, { version: 1, id: m1.id, extra: true, role: 'stale' })
    assert.equal(await fs.readFile(exclude, 'utf8'), '.stow/\n')
    assert.deepEqual(calls[0], ['git', '-C', dir, 'rev-parse', '--git-path', 'info/exclude'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('writeStowMeta: refuses to overwrite a malformed file and rejects a bad role', async () => {
  const dir = await tmp()
  const exec = async () => { throw new Error('not a repo') }
  try {
    await assert.rejects(writeStowMeta(dir, { role: 'prod' }, { exec }), /role/)
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(path.join(dir, '.stow', 'project.json'), '{broken')
    await assert.rejects(writeStowMeta(dir, { client: 'X' }, { exec }), /malformed/)
    assert.equal(await fs.readFile(path.join(dir, '.stow', 'project.json'), 'utf8'), '{broken')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('excludeFromGit: not a repo → false; appends after a line without newline; skips if present', async () => {
  const dir = await tmp()
  try {
    assert.equal(await excludeFromGit(dir, { exec: async () => { throw new Error('x') } }), false)
    const ex = path.join(dir, 'exclude')
    await fs.writeFile(ex, '# git ls-files\n*.log')
    const exec = async () => `${ex}\n`
    assert.equal(await excludeFromGit(dir, { exec }), true)
    assert.equal(await fs.readFile(ex, 'utf8'), '# git ls-files\n*.log\n.stow/\n')
    assert.equal(await excludeFromGit(dir, { exec }), false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```js
/**
 * Per-checkout identity file `<dir>/.stow/project.json` (#8):
 *   { version: 1, id, client?, role? } — unknown keys are preserved.
 * It travels with the folder, so a moved checkout keeps its id (#9) and its
 * manual client/role. It is kept out of `git status` through the repo's
 * info/exclude, or every registered repo would count as uncommitted.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const STOW_DIR = '.stow'
export const META_FILE = 'project.json'
export const ROLES = ['primary', 'deploy', 'experiment', 'stale']
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
// Unanchored so it also matches a project that sits in a subdirectory of its repo.
const EXCLUDE_LINE = '.stow/'

const execFileP = promisify(execFile)
const defaultExec = async (cmd, args) => (await execFileP(cmd, args)).stdout

export function newProjectId() {
  return 'p_' + Array.from(crypto.randomBytes(12), b => B32[b & 31]).join('')
}

export function metaPath(dir) {
  return path.join(dir, STOW_DIR, META_FILE)
}

export function parseStowMeta(text) {
  let raw
  try { raw = JSON.parse(text) } catch { return { meta: null, warnings: ['malformed .stow/project.json'] } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { meta: null, warnings: ['.stow/project.json is not an object'] }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { meta: null, warnings: ['.stow/project.json has no valid id'] }
  const meta = { ...raw }
  const warnings = []
  if ('client' in meta && (typeof meta.client !== 'string' || !meta.client.trim())) {
    warnings.push('ignored invalid client'); delete meta.client
  } else if (typeof meta.client === 'string') meta.client = meta.client.trim()
  if ('role' in meta && !ROLES.includes(meta.role)) {
    warnings.push(`ignored invalid role ${JSON.stringify(meta.role)}`); delete meta.role
  }
  return { meta, warnings }
}

export async function readStowMeta(dir) {
  let text
  try { text = await fs.readFile(metaPath(dir), 'utf8') } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { meta: null, warnings: [] }
    return { meta: null, warnings: [`cannot read .stow/project.json: ${e.code || e.message}`] }
  }
  return parseStowMeta(text)
}

export async function excludeFromGit(dir, { exec = defaultExec } = {}) {
  let out
  try { out = await exec('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude']) } catch { return false }
  const rel = String(out).trim()
  if (!rel) return false
  const file = path.resolve(dir, rel)
  let current = ''
  try { current = await fs.readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const lines = current.split(/\r?\n/).map(l => l.trim())
  if (lines.some(l => l === EXCLUDE_LINE || l === '/.stow/' || l === '.stow')) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  const sep = current && !current.endsWith('\n') ? '\n' : ''
  await fs.appendFile(file, `${sep}${EXCLUDE_LINE}\n`)
  return true
}

export async function writeStowMeta(dir, patch = {}, { exec = defaultExec } = {}) {
  if ('role' in patch && patch.role !== null && !ROLES.includes(patch.role)) throw new Error(`invalid role ${JSON.stringify(patch.role)}`)
  if ('client' in patch && patch.client !== null && (typeof patch.client !== 'string' || !patch.client.trim())) throw new Error('invalid client')
  const file = metaPath(dir)
  let existing = {}
  try {
    const text = await fs.readFile(file, 'utf8')
    const { meta } = parseStowMeta(text)
    if (!meta) throw new Error(`refusing to overwrite malformed ${file}`)
    existing = JSON.parse(text)
  } catch (e) { if (e.code !== 'ENOENT') throw e }

  const next = { ...existing, version: 1 }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k]
    else next[k] = typeof v === 'string' ? v.trim() : v
  }
  if (!next.id) next.id = newProjectId()
  const ordered = { version: 1, id: next.id, ...next }

  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + '\n')
  await fs.rename(tmp, file)
  await excludeFromGit(dir, { exec })
  return ordered
}
```

Note: the "malformed" error must contain the word `malformed`. `parseStowMeta` returns `meta: null` for a missing id too, which the refusal also covers.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(registry): .stow/project.json identity file with git exclude`

### Task 3: Client catalog

**Files:**
- Create: `src/lib/registry/client.mjs`
- Test: `src/lib/registry/client.test.mjs`

**Interfaces:**
- Produces: `clientKey(name) → string`, `cleanClientName(name) → string`, `bizzClient(directory) → string|null`, `buildClientCatalog({ config, names: { bizz: string[], seen: string[] } }) → { lookup(name) → {id,name}|null, list() → [{id,name}] }`

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientKey, cleanClientName, bizzClient, buildClientCatalog } from './client.mjs'

test('clientKey folds case, punctuation, diacritics and the AI new: marker', () => {
  for (const n of ['Boys from Heaven', 'boys-from-heaven', 'boysfromheaven']) assert.equal(clientKey(n), 'boysfromheaven')
  assert.equal(clientKey('new:Archon'), 'archon')
  assert.equal(clientKey('Farnosť Domaňovce'), 'farnostdomanovce')
  assert.equal(clientKey(''), '')
  assert.equal(clientKey(null), '')
  assert.equal(cleanClientName('  new:Acme '), 'Acme')
})

test('bizzClient reads the _Bizz/<Client> segment', () => {
  assert.equal(bizzClient('/Users/x/Projekty/_Bizz/Intelimail/sms'), 'Intelimail')
  assert.equal(bizzClient('/Users/x/Projekty/_Bizz/TriSoft'), 'TriSoft')
  assert.equal(bizzClient('/Users/x/Projekty/blog'), null)
})

test('catalog: display name priority config > bizz > most frequent; aliases', () => {
  const cat = buildClientCatalog({
    config: { clients: [{ name: 'TriSoft s.r.o.', aliases: ['tri-soft', 'trisoft'] }] },
    names: { bizz: ['Intelimail', 'TriSoft'], seen: ['InteliMail', 'archon', 'new:Archon', 'Archon', 'Archon'] },
  })
  assert.deepEqual(cat.lookup('INTELIMAIL'), { id: 'intelimail', name: 'Intelimail' })
  assert.deepEqual(cat.lookup('tri-soft'), { id: 'trisoftsro', name: 'TriSoft s.r.o.' })
  assert.deepEqual(cat.lookup('TriSoft'), { id: 'trisoftsro', name: 'TriSoft s.r.o.' })
  assert.deepEqual(cat.lookup('new:archon'), { id: 'archon', name: 'Archon' })
  assert.equal(cat.lookup('erikmeliska'), null)
  assert.deepEqual(cat.list().map(c => c.id), ['archon', 'intelimail', 'trisoftsro'])
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```js
/**
 * Client names for the virtual-project register (#8). One client = one
 * clientKey; spellings (`Intelimail`/`InteliMail`, `new:Archon`, `boys-from-
 * heaven`/`Boys from Heaven`) collapse, aliases in data/registry.json map
 * other names (a GitLab group, an old brand) onto a client.
 */

export function cleanClientName(name) {
  return typeof name === 'string' ? name.trim().replace(/^new:\s*/i, '').trim() : ''
}

export function clientKey(name) {
  return cleanClientName(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function bizzClient(directory) {
  const m = typeof directory === 'string' && directory.match(/\/_Bizz\/([^/]+)(?:\/|$)/)
  return m ? m[1] : null
}

const RANK = { config: 0, bizz: 1, seen: 2 }

export function buildClientCatalog({ config = { clients: [] }, names = {} } = {}) {
  const alias = new Map()
  const byKey = new Map() // key -> { rank, name, counts: Map }
  const canon = k => alias.get(k) || k

  const add = (raw, rank) => {
    const name = cleanClientName(raw)
    const k = canon(clientKey(name))
    if (!k) return
    let e = byKey.get(k)
    if (!e) byKey.set(k, e = { rank, name, counts: new Map() })
    if (rank < e.rank) { e.rank = rank; e.name = name }
    if (rank === RANK.seen) e.counts.set(name, (e.counts.get(name) || 0) + 1)
  }

  for (const c of config.clients || []) {
    const k = clientKey(c.name)
    for (const a of c.aliases || []) { const ak = clientKey(a); if (ak && ak !== k) alias.set(ak, k) }
  }
  for (const c of config.clients || []) add(c.name, RANK.config)
  for (const n of names.bizz || []) add(n, RANK.bizz)
  for (const n of names.seen || []) add(n, RANK.seen)

  for (const e of byKey.values()) {
    if (e.rank !== RANK.seen) continue
    let best = e.name, bestN = -1
    for (const [n, c] of e.counts) if (c > bestN) { best = n; bestN = c }
    e.name = best
  }

  return {
    lookup(name) {
      const k = canon(clientKey(name))
      const e = k && byKey.get(k)
      return e ? { id: k, name: e.name } : null
    },
    list() {
      return [...byKey].map(([id, e]) => ({ id, name: e.name })).sort((a, b) => a.id.localeCompare(b.id))
    },
  }
}
```

(Most-frequent tie-break: first seen wins, since `Map` keeps insertion order and the comparison is strict `>`.)

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(registry): client catalog with key folding and aliases`

### Task 4: `buildRegistry` (pure)

**Files:**
- Create: `src/lib/registry/registry.mjs`
- Test: `src/lib/registry/registry.test.mjs`

**Interfaces:**
- Consumes: `identityOf`, `remoteOwner` (Task 1); `ROLES` (Task 2); `buildClientCatalog`, `bizzClient`, `cleanClientName` (Task 3).
- Produces: `buildRegistry(records, { metas: Map<dir,{meta,warnings}>, config, now }) → { clients, projects, stats }` (shape in the spec); `deriveRole(directory, activityMs, now) → 'deploy'|'stale'|'experiment'`; `STALE_DAYS = 180`.

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry, deriveRole } from './registry.mjs'

const NOW = Date.parse('2026-10-05T00:00:00Z')
const day = n => new Date(NOW - n * 86400000).toISOString()
const rec = (id, directory, extra = {}) => ({ id, directory, project_name: directory.split('/').pop(), last_code_modified: day(1), ...extra })
const remote = url => ({ git_info: { remotes: [url] } })

test('deriveRole: name tokens then age', () => {
  assert.equal(deriveRole('/p/krestan-next-prod-old', NOW - 86400000, NOW), 'stale')
  assert.equal(deriveRole('/p/blog-prod', NOW - 86400000, NOW), 'deploy')
  assert.equal(deriveRole('/p/blog-test', NOW - 200 * 86400000, NOW), 'stale')
  assert.equal(deriveRole('/p/blog-test', NOW - 86400000, NOW), 'experiment')
  assert.equal(deriveRole('/p/blog-test', null, NOW), 'stale')
})

test('four checkouts of one repo become one project with roles and an owner client', () => {
  const records = [
    rec('a', '/P/_Bizz/Intelimail/blog', { ...remote('git@gitlab.com:intelimail/blog.git'), last_code_modified: day(2) }),
    rec('b', '/P/blog-huha', { ...remote('https://gitlab.com/intelimail/blog.git'), last_code_modified: day(1) }),
    rec('c', '/P/blog-test', { ...remote('git@gitlab.com:Intelimail/blog'), last_code_modified: day(400) }),
    rec('d', '/P/blog-prod', { ...remote('git@gitlab.com:intelimail/blog.git'), last_code_modified: day(3) }),
  ]
  const { projects, clients, stats } = buildRegistry(records, { now: NOW })
  assert.equal(projects.length, 1)
  const p = projects[0]
  assert.equal(p.key, 'git:gitlab.com/intelimail/blog')
  assert.equal(p.name, 'blog')
  assert.equal(p.primary, '/P/blog-huha')
  assert.deepEqual(p.client, { id: 'intelimail', name: 'Intelimail', source: 'owner' })
  assert.deepEqual(Object.fromEntries(p.locations.map(l => [l.directory, l.role])),
    { '/P/blog-huha': 'primary', '/P/_Bizz/Intelimail/blog': 'experiment', '/P/blog-prod': 'deploy', '/P/blog-test': 'stale' })
  assert.deepEqual(clients, [{ id: 'intelimail', name: 'Intelimail', projects: ['git:gitlab.com/intelimail/blog'] }])
  assert.equal(stats.multi_location, 1)
  assert.equal(stats.locations_in_multi, 4)
})

test('client chain: manual > ai > owner > path; unknown owner is ignored', () => {
  const metas = new Map([['/P/m', { meta: { id: 'p_mmmmmmmmmmmm', client: 'Acme' }, warnings: [] }]])
  const records = [
    rec('m', '/P/m', { ai_analysis: { client: 'Intelimail' } }),
    rec('ai', '/P/ai', { ...remote('git@github.com:erikmeliska/ai.git'), ai_analysis: { client: 'new:Archon' } }),
    rec('o', '/P/o', remote('git@github.com:joweich/trends.git')),
    rec('pa', '/P/_Bizz/TriSoft/tool'),
    rec('own', '/P/own', remote('git@gitlab.com:tri-soft/calc.git')),
  ]
  const config = { clients: [{ name: 'TriSoft', aliases: ['tri-soft'] }] }
  const by = Object.fromEntries(buildRegistry(records, { metas, config, now: NOW }).projects.map(p => [p.primary, p.client]))
  assert.deepEqual(by['/P/m'], { id: 'acme', name: 'Acme', source: 'manual' })
  assert.deepEqual(by['/P/ai'], { id: 'archon', name: 'Archon', source: 'ai' })
  assert.equal(by['/P/o'], null)
  assert.deepEqual(by['/P/_Bizz/TriSoft/tool'], { id: 'trisoft', name: 'TriSoft', source: 'path' })
  assert.deepEqual(by['/P/own'], { id: 'trisoft', name: 'TriSoft', source: 'owner' })
})

test('manual roles win; several manual primaries warn; stow id identity; meta warnings surface', () => {
  const metas = new Map([
    ['/P/x1', { meta: { id: 'p_111111111111', role: 'primary' }, warnings: [] }],
    ['/P/x2', { meta: { id: 'p_222222222222', role: 'primary' }, warnings: [] }],
    ['/P/solo', { meta: { id: 'p_soloooooooo', role: 'stale' }, warnings: ['ignored invalid client'] }],
  ])
  const records = [
    rec('1', '/P/x1', { ...remote('git@github.com:a/x.git'), last_code_modified: day(10) }),
    rec('2', '/P/x2', { ...remote('git@github.com:a/x.git'), last_code_modified: day(5) }),
    rec('3', '/P/x3', { ...remote('git@github.com:a/x.git'), last_code_modified: day(1) }),
    rec('s', '/P/solo'),
  ]
  const { projects } = buildRegistry(records, { metas, now: NOW })
  const x = projects.find(p => p.key === 'git:github.com/a/x')
  assert.equal(x.primary, '/P/x2')
  assert.deepEqual(x.warnings, ['multiple-primary'])
  assert.deepEqual(x.locations.map(l => [l.directory, l.role, l.role_source]),
    [['/P/x2', 'primary', 'manual'], ['/P/x3', 'experiment', 'derived'], ['/P/x1', 'primary', 'manual']])
  const solo = projects.find(p => p.key === 'stow:p_soloooooooo')
  assert.equal(solo.kind, 'stow')
  assert.equal(solo.primary, '/P/solo')
  assert.deepEqual(solo.locations.map(l => [l.role, l.role_source]), [['stale', 'manual']])
  assert.deepEqual(solo.warnings, ['/P/solo: ignored invalid client'])
})

test('no manual primary: derived primary skips manually-roled locations; tie → shortest path', () => {
  const metas = new Map([['/P/a', { meta: { id: 'p_aaaaaaaaaaaa', role: 'deploy' }, warnings: [] }]])
  const records = [
    rec('a', '/P/a', { ...remote('git@github.com:o/r.git'), last_code_modified: day(0) }),
    rec('b', '/P/bb', { ...remote('git@github.com:o/r.git'), last_code_modified: day(2) }),
    rec('c', '/P/b', { ...remote('git@github.com:o/r.git'), last_code_modified: day(2) }),
  ]
  const [p] = buildRegistry(records, { metas, now: NOW }).projects
  assert.equal(p.primary, '/P/b')
})

test('sorting and stats: unassigned last, by_kind / by_client_source counts', () => {
  const records = [
    rec('1', '/P/zeta', remote('git@github.com:x/zeta.git')),
    rec('2', '/P/_Bizz/Acme/beta'),
    rec('3', '/P/_Bizz/Acme/alpha'),
  ]
  const r = buildRegistry(records, { now: NOW })
  assert.deepEqual(r.projects.map(p => p.name), ['alpha', 'beta', 'zeta'])
  assert.deepEqual(r.stats, { records: 3, projects: 3, multi_location: 0, locations_in_multi: 0, unassigned: 1,
    by_kind: { git: 1, path: 2 }, by_client_source: { path: 2 } })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** (`loadRegistry` is added in Task 5)

```js
/**
 * The virtual-project register (#8): Client → Project → Location over the
 * scanned ledger. buildRegistry is pure — callers pass the ledger rows, the
 * per-directory .stow metas and the data/registry.json config. Nothing on
 * disk moves; this is a view.
 */
import path from 'node:path'
import { identityOf, remoteOwner } from './identity.mjs'
import { buildClientCatalog, bizzClient, cleanClientName } from './client.mjs'

export const STALE_DAYS = 180
const DAY_MS = 86400000
const STALE_RE = /(^|[-_.\s])(old|backup|bak|archive)([-_.\s]|$)/i
const DEPLOY_RE = /(^|[-_.\s])(prod|production|deploy|live)([-_.\s]|$)/i

function activityOf(record) {
  const t = Date.parse(record.last_code_modified || record.last_modified || '')
  return Number.isFinite(t) ? t : null
}

export function deriveRole(directory, activityMs, now = Date.now()) {
  const base = path.basename(directory || '')
  if (STALE_RE.test(base)) return 'stale'
  if (DEPLOY_RE.test(base)) return 'deploy'
  if (activityMs == null || now - activityMs > STALE_DAYS * DAY_MS) return 'stale'
  return 'experiment'
}

// Most recent first; tie → shorter path, then lexical — deterministic.
const byActivity = (a, b) =>
  (b.last_activity ?? -Infinity) - (a.last_activity ?? -Infinity) ||
  a.directory.length - b.directory.length ||
  a.directory.localeCompare(b.directory)

export function buildRegistry(records, { metas = new Map(), config = { clients: [] }, now = Date.now() } = {}) {
  const metaOf = dir => metas.get(dir) || { meta: null, warnings: [] }

  const groups = new Map()
  for (const record of records) {
    if (!record || typeof record.directory !== 'string') continue
    const { meta } = metaOf(record.directory)
    const id = identityOf(record, meta)
    let g = groups.get(id.key)
    if (!g) groups.set(id.key, g = { ...id, rows: [] })
    g.rows.push(record)
  }

  const bizz = [], seen = []
  for (const r of records) {
    if (!r || typeof r.directory !== 'string') continue
    const b = bizzClient(r.directory); if (b) bizz.push(b)
    const m = metaOf(r.directory).meta; if (m?.client) seen.push(m.client)
    const ai = cleanClientName(r.ai_analysis?.client); if (ai) seen.push(ai)
  }
  const catalog = buildClientCatalog({ config, names: { bizz, seen } })

  const projects = []
  for (const g of groups.values()) {
    const warnings = []
    const locs = g.rows.map(r => {
      const { meta, warnings: w } = metaOf(r.directory)
      for (const x of w) warnings.push(`${r.directory}: ${x}`)
      return { record: r, meta, directory: r.directory, record_id: r.id ?? null, stow_id: meta?.id ?? null, last_activity: activityOf(r) }
    })

    const manualPrimaries = locs.filter(l => l.meta?.role === 'primary').sort(byActivity)
    if (manualPrimaries.length > 1) warnings.push('multiple-primary')
    const unroled = locs.filter(l => !l.meta?.role)
    const primary = manualPrimaries[0] || [...(unroled.length ? unroled : locs)].sort(byActivity)[0]

    for (const l of locs) {
      if (l.meta?.role) { l.role = l.meta.role; l.role_source = 'manual' }
      else if (l === primary) { l.role = 'primary'; l.role_source = 'derived' }
      else { l.role = deriveRole(l.directory, l.last_activity, now); l.role_source = 'derived' }
    }
    const ordered = [primary, ...locs.filter(l => l !== primary).sort(byActivity)]

    let client = null
    const pick = (source, name) => {
      if (client || !name) return
      const c = catalog.lookup(name)
      if (c) client = { ...c, source }
    }
    for (const l of ordered) pick('manual', l.meta?.client)
    for (const l of ordered) pick('ai', cleanClientName(l.record.ai_analysis?.client))
    pick('owner', remoteOwner(g.remote))
    for (const l of ordered) pick('path', bizzClient(l.directory))

    const name = g.kind === 'git'
      ? g.remote.split('/').pop()
      : primary.record.project_name || path.basename(primary.directory)

    projects.push({
      key: g.key, kind: g.kind, name, remote: g.remote, client,
      primary: primary.directory,
      locations: ordered.map(({ directory, record_id, stow_id, role, role_source, last_activity }) =>
        ({ directory, record_id, stow_id, role, role_source, last_activity })),
      warnings,
    })
  }

  // Unassigned last; then client name, project name, key.
  projects.sort((a, b) =>
    (a.client ? 0 : 1) - (b.client ? 0 : 1) ||
    (a.client?.name || '').localeCompare(b.client?.name || '') ||
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key))

  const clientMap = new Map()
  for (const p of projects) {
    if (!p.client) continue
    let c = clientMap.get(p.client.id)
    if (!c) clientMap.set(p.client.id, c = { id: p.client.id, name: p.client.name, projects: [] })
    c.projects.push(p.key)
  }
  const clients = [...clientMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  const count = (obj, k) => { obj[k] = (obj[k] || 0) + 1 }
  const stats = { records: records.length, projects: projects.length, multi_location: 0, locations_in_multi: 0, unassigned: 0, by_kind: {}, by_client_source: {} }
  for (const p of projects) {
    if (p.locations.length > 1) { stats.multi_location++; stats.locations_in_multi += p.locations.length }
    if (!p.client) stats.unassigned++
    else count(stats.by_client_source, p.client.source)
    count(stats.by_kind, p.kind)
  }
  return { clients, projects, stats }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(registry): buildRegistry — clients, projects, locations, roles`

### Task 5: Config, `loadRegistry` and the CLI

**Files:**
- Modify: `src/lib/registry/registry.mjs` (add `readRegistryConfig`, `parseRegistryConfig`, `loadRegistry`)
- Modify: `src/lib/registry/registry.test.mjs`
- Create: `scripts/registry.mjs`
- Modify: `package.json` (`"registry": "node scripts/registry.mjs"`), `CLAUDE.md` (commands + Important Files + a "Virtual projects" section)

**Interfaces:**
- Consumes: `dataFile`, `ledgerFile` from `src/lib/state-dir.mjs`; `readStowMeta` (Task 2); `buildRegistry` (Task 4).
- Produces: `parseRegistryConfig(text) → { version: 1, clients: [{ name, aliases }] }` (throws on invalid), `readRegistryConfig({ base }) → Promise<config>` (missing file gives `{ version: 1, clients: [] }`), `loadRegistry({ base, readMeta = readStowMeta, now }) → Promise<registry>`.

- [ ] **Step 1: Write failing tests** (append to `registry.test.mjs`)

```js
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRegistryConfig, readRegistryConfig, loadRegistry } from './registry.mjs'

test('parseRegistryConfig validates shape', () => {
  assert.deepEqual(parseRegistryConfig('{"clients":[{"name":"TriSoft","aliases":["tri-soft"]},{"name":"Acme"}]}'),
    { version: 1, clients: [{ name: 'TriSoft', aliases: ['tri-soft'] }, { name: 'Acme', aliases: [] }] })
  assert.throws(() => parseRegistryConfig('{nope'), /registry.json/)
  assert.throws(() => parseRegistryConfig('{"clients":[{"aliases":[]}]}'), /name/)
  assert.throws(() => parseRegistryConfig('{"clients":[{"name":"A","aliases":"x"}]}'), /aliases/)
})

test('loadRegistry reads ledger + config from the state dir and metas per directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stow-reg-'))
  const saved = process.env.STOW_STATE_DIR
  process.env.STOW_STATE_DIR = base
  try {
    await fs.mkdir(path.join(base, 'data'))
    assert.deepEqual(await readRegistryConfig(), { version: 1, clients: [] })
    await fs.writeFile(path.join(base, 'data', 'projects_metadata.jsonl'),
      JSON.stringify(rec('a', '/P/one')) + '\nnot json\n' + JSON.stringify(rec('b', '/P/two')) + '\n')
    await fs.writeFile(path.join(base, 'data', 'registry.json'), '{"clients":[{"name":"Acme"}]}')
    const readMeta = async dir => dir === '/P/one'
      ? { meta: { id: 'p_oneoneoneone', client: 'acme' }, warnings: [] } : { meta: null, warnings: [] }
    const r = await loadRegistry({ readMeta, now: NOW })
    assert.equal(r.stats.records, 2)
    assert.deepEqual(r.projects.map(p => [p.key, p.client?.name ?? null]),
      [['stow:p_oneoneoneone', 'Acme'], ['path:/P/two', null]])
  } finally {
    if (saved === undefined) delete process.env.STOW_STATE_DIR; else process.env.STOW_STATE_DIR = saved
    await fs.rm(base, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** (append to `registry.mjs`; add the imports at the top)

```js
import fs from 'node:fs/promises'
import { dataFile, ledgerFile } from '../state-dir.mjs'
import { readStowMeta } from './stow-meta.mjs'

export const REGISTRY_FILE = 'registry.json'
const META_CONCURRENCY = 32

export function parseRegistryConfig(text) {
  let raw
  try { raw = JSON.parse(text) } catch (e) { throw new Error(`invalid ${REGISTRY_FILE}: ${e.message}`) }
  const list = raw?.clients ?? []
  if (!Array.isArray(list)) throw new Error(`invalid ${REGISTRY_FILE}: clients must be an array`)
  const clients = list.map((c, i) => {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error(`invalid ${REGISTRY_FILE}: clients[${i}].name`)
    const aliases = c.aliases ?? []
    if (!Array.isArray(aliases) || aliases.some(a => typeof a !== 'string')) throw new Error(`invalid ${REGISTRY_FILE}: clients[${i}].aliases`)
    return { name: c.name.trim(), aliases }
  })
  return { version: 1, clients }
}

export async function readRegistryConfig(opts = {}) {
  let text
  try { text = await fs.readFile(dataFile(REGISTRY_FILE, opts), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, clients: [] }
    throw e
  }
  return parseRegistryConfig(text)
}

async function readLedger(opts) {
  let text
  try { text = await fs.readFile(ledgerFile(opts), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* skip malformed line */ }
  }
  return rows
}

export async function loadRegistry({ base, readMeta = readStowMeta, now = Date.now() } = {}) {
  const opts = base ? { base } : {}
  const [records, config] = await Promise.all([readLedger(opts), readRegistryConfig(opts)])
  const metas = new Map()
  const dirs = [...new Set(records.map(r => r?.directory).filter(d => typeof d === 'string'))]
  for (let i = 0; i < dirs.length; i += META_CONCURRENCY) {
    const chunk = dirs.slice(i, i + META_CONCURRENCY)
    const got = await Promise.all(chunk.map(d => readMeta(d)))
    chunk.forEach((d, j) => metas.set(d, got[j]))
  }
  return buildRegistry(records, { metas, config, now })
}
```

`scripts/registry.mjs`, a read-only summary:

```js
#!/usr/bin/env node
// Read-only summary of the virtual-project register (#8).
//   node scripts/registry.mjs [--multi] [--unassigned] [--json]
// Reads the live ledger + data/registry.json + each checkout's .stow/project.json;
// writes nothing.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/lib/registry/registry.mjs'

const STATE = { base: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }
const args = new Set(process.argv.slice(2))

const reg = await loadRegistry(STATE)
if (args.has('--json')) {
  process.stdout.write(JSON.stringify(reg, null, 2) + '\n')
} else {
  const s = reg.stats
  console.log(`${s.records} ledger rows → ${s.projects} projects (${s.multi_location} with several checkouts, ${s.locations_in_multi} checkouts in them)`)
  console.log(`identity: ${Object.entries(s.by_kind).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  console.log(`client source: ${Object.entries(s.by_client_source).map(([k, n]) => `${k} ${n}`).join(', ')}, unassigned ${s.unassigned}`)
  console.log('\nclients:')
  for (const c of reg.clients) console.log(`  ${c.name.padEnd(28)} ${c.projects.length}`)
  if (args.has('--multi')) {
    console.log('\nprojects with several checkouts:')
    for (const p of reg.projects.filter(p => p.locations.length > 1).sort((a, b) => b.locations.length - a.locations.length)) {
      console.log(`  ${p.key}  [${p.client?.name ?? 'unassigned'}]`)
      for (const l of p.locations) console.log(`    ${l.role.padEnd(10)} ${l.role_source === 'manual' ? '*' : ' '} ${l.directory}`)
    }
  }
  if (args.has('--unassigned')) {
    console.log('\nunassigned:')
    for (const p of reg.projects.filter(p => !p.client)) console.log(`  ${p.primary}`)
  }
  const warned = reg.projects.filter(p => p.warnings.length)
  if (warned.length) {
    console.log(`\nwarnings (${warned.length} projects):`)
    for (const p of warned) console.log(`  ${p.key}: ${p.warnings.join('; ')}`)
  }
}
```

- [ ] **Step 4: Run** `npm test` (expect all pass), `npx eslint src/lib/registry scripts/registry.mjs` (expect clean), then `npm run registry -- --multi | head -80` against live data and check that `git:gitlab.com/intelimail/blog` lists the 4 blog checkouts and that no URL with credentials appears.
- [ ] **Step 5: Docs + commit.** Add to CLAUDE.md: the `npm run registry` command line, the four files under Important Files, and a short "Virtual projects (register)" section (key format, `.stow/project.json`, client chain, roles, `data/registry.json`). Commit: `feat(registry): registry config, loadRegistry and npm run registry`
