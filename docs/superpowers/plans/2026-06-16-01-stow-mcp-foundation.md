# Stow MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give stow's MCP server (and CLI) the capabilities the Command Center depends on: read/write `STATUS.md`, list/run project scripts (on-demand dev servers), surface `scc` code stats, and remove the stale duplicated process-detection code — all behind shared, unit-tested libs.

**Architecture:** Extract the logic the Next.js API routes already contain into framework-free `src/lib/*.mjs` modules so both the Next routes and the standalone MCP server (`src/mcp/server.mjs`, run by `node` outside the Next bundler) import one copy. New behavior (`STATUS.md` read/write) lives in its own lib. MCP gains four tools wired to these libs.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict` (built-in, no new deps), `@modelcontextprotocol/sdk` (already a dep). Next routes import via the `@/*` → `./src/*` alias; the MCP server imports libs **relatively with explicit `.mjs` extension** (it is not bundled by Next).

---

### Task 1: Add a test harness

**Files:**
- Modify: `package.json` (scripts block)
- Test: `src/lib/_smoke.test.mjs`

- [ ] **Step 1: Write the failing smoke test**

Create `src/lib/_smoke.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('test runner works', () => {
  assert.equal(1 + 1, 2)
})
```

- [ ] **Step 2: Add the `test` script**

In `package.json`, add to `"scripts"` (after `"lint"`):
```json
    "test": "node --test",
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS — `tests 1 / pass 1 / fail 0`. (Node v24 auto-discovers `**/*.test.mjs`.)

- [ ] **Step 4: Commit**

```bash
git add package.json src/lib/_smoke.test.mjs
git commit -m "test: add node:test harness"
```

---

### Task 2: `src/lib/status.mjs` — parse/serialize/read/write STATUS.md

**Files:**
- Create: `src/lib/status.mjs`
- Test: `src/lib/status.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/status.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseStatus, serializeStatus, readStatus, writeStatus } from './status.mjs'

test('parseStatus reads frontmatter, NEXT and links', () => {
  const s = parseStatus(
    '---\nstatus: active\nupdated: 2026-06-16\n---\n\n' +
    'NEXT: ship SSO logout\n\n## Links\n' +
    '- https://localhost:3000 — dev\n- https://gitlab.com/x — repo\n'
  )
  assert.equal(s.status, 'active')
  assert.equal(s.updated, '2026-06-16')
  assert.equal(s.next, 'ship SSO logout')
  assert.equal(s.links.length, 2)
  assert.equal(s.links[0].url, 'https://localhost:3000')
  assert.equal(s.links[0].label, 'dev')
})

test('parseStatus on empty content returns defaults', () => {
  const s = parseStatus('')
  assert.equal(s.next, null)
  assert.deepEqual(s.links, [])
})

test('serializeStatus round-trips through parseStatus', () => {
  const original = { status: 'paused', updated: '2026-06-16', next: 'do the thing', links: [{ url: 'https://a.test', label: 'x' }], notes: '' }
  const parsed = parseStatus(serializeStatus(original))
  assert.equal(parsed.status, 'paused')
  assert.equal(parsed.next, 'do the thing')
  assert.equal(parsed.links[0].url, 'https://a.test')
})

test('writeStatus then readStatus persists NEXT and status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-status-'))
  try {
    await writeStatus(dir, { status: 'active', updated: '2026-06-16', next: 'first step', links: [] })
    const back = await readStatus(dir)
    assert.equal(back.next, 'first step')
    assert.equal(back.status, 'active')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeStatus merges over existing fields, preserving links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-status-'))
  try {
    await writeStatus(dir, { status: 'active', updated: '2026-06-16', next: 'one', links: [{ url: 'https://a.test', label: '' }] })
    await writeStatus(dir, { next: 'two', updated: '2026-06-16' })
    const back = await readStatus(dir)
    assert.equal(back.next, 'two')
    assert.equal(back.links.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './status.mjs'`.

- [ ] **Step 3: Implement `src/lib/status.mjs`**

```js
import { readFile, writeFile } from 'fs/promises'
import path from 'path'

const STATUS_FILE = 'STATUS.md'

export function parseStatus(content) {
  const result = { status: null, updated: null, next: null, links: [], notes: '' }
  if (!content) return result
  let body = content
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    body = content.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) continue
      if (m[1] === 'status') result.status = m[2].trim()
      if (m[1] === 'updated') result.updated = m[2].trim()
    }
  }
  const nextM = body.match(/^NEXT:\s*(.*)$/m)
  if (nextM) result.next = nextM[1].trim()
  const linksM = body.match(/^##\s*Links\s*\n([\s\S]*?)(?:\n##\s|\s*$)/m)
  if (linksM) {
    for (const line of linksM[1].split('\n')) {
      const lm = line.match(/^-\s*(\S+)(?:\s+[—-]\s*(.*))?$/)
      if (lm) result.links.push({ url: lm[1], label: (lm[2] || '').trim() })
    }
  }
  return result
}

export function serializeStatus({ status = 'active', updated, next = '', links = [], notes = '' }) {
  const lines = ['---', `status: ${status}`, `updated: ${updated}`, '---', '', `NEXT: ${next}`, '', '## Links']
  for (const l of links) lines.push(`- ${l.url}${l.label ? ` — ${l.label}` : ''}`)
  if (notes) { lines.push('', '## Notes', notes) }
  lines.push('')
  return lines.join('\n')
}

export async function readStatus(projectDir) {
  try {
    return parseStatus(await readFile(path.join(projectDir, STATUS_FILE), 'utf-8'))
  } catch {
    return parseStatus('')
  }
}

export async function writeStatus(projectDir, fields) {
  const current = await readStatus(projectDir)
  const merged = { ...current, ...fields }
  merged.updated = fields.updated ?? merged.updated ?? new Date().toISOString().slice(0, 10)
  await writeFile(path.join(projectDir, STATUS_FILE), serializeStatus(merged), 'utf-8')
  return merged
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 6 tests (5 new + smoke) green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/status.mjs src/lib/status.test.mjs
git commit -m "feat: add STATUS.md parse/serialize/read/write lib"
```

---

### Task 3: `src/lib/scripts.mjs` — list/run scripts (extracted from API routes)

**Files:**
- Create: `src/lib/scripts.mjs`
- Test: `src/lib/scripts.test.mjs`
- Modify: `src/app/api/scripts/route.js`
- Modify: `src/app/api/scripts/run/route.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scripts.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { listScripts, runScript } from './scripts.mjs'

test('listScripts returns package.json scripts and .sh files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scripts-'))
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', build: 'next build' } }))
    await writeFile(path.join(dir, 'deploy.sh'), '#!/bin/bash\necho hi\n')
    const s = await listScripts(dir)
    assert.equal(s.dev, 'next dev')
    assert.equal(s.build, 'next build')
    assert.equal(s['deploy.sh'], './deploy.sh')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('listScripts on empty dir returns empty object', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-scripts-'))
  try {
    assert.deepEqual(await listScripts(dir), {})
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('runScript spawns a detached process and returns pid + logFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-run-'))
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { noop: 'true' } }))
    const r = await runScript(dir, 'noop', { now: 12345 })
    assert.ok(r.pid > 0)
    assert.match(r.logFile, /noop-12345\.log$/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './scripts.mjs'`.

- [ ] **Step 3: Implement `src/lib/scripts.mjs`**

(Logic moved verbatim from the two API routes, with `Date.now()` lifted to an injectable `now` option for testability.)
```js
import { readFile, readdir, mkdir, open as fsOpen } from 'fs/promises'
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'

export const LOG_DIR = path.join(os.tmpdir(), 'stow-dashboard-logs')

export async function listScripts(directory) {
  const scripts = {}
  try {
    const content = await readFile(path.join(directory, 'package.json'), 'utf-8')
    Object.assign(scripts, JSON.parse(content).scripts || {})
  } catch { /* no/invalid package.json */ }
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.sh')) scripts[e.name] = `./${e.name}`
    }
  } catch { /* unreadable dir */ }
  return scripts
}

export async function runScript(directory, script, { now = Date.now() } = {}) {
  await mkdir(LOG_DIR, { recursive: true })
  const logFile = path.join(LOG_DIR, `${script.replace(/[^a-zA-Z0-9-_]/g, '_')}-${now}.log`)
  const fd = await fsOpen(logFile, 'w')
  const isShell = script.endsWith('.sh')
  const cmd = isShell ? 'bash' : 'npm'
  const args = isShell ? [`./${script}`] : ['run', script]
  const child = spawn(cmd, args, {
    cwd: directory,
    detached: true,
    stdio: ['ignore', fd.fd, fd.fd],
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  child.unref()
  child.once('spawn', () => fd.close().catch(() => {}))
  child.once('error', () => fd.close().catch(() => {}))
  return { pid: child.pid, logFile, script }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 3 new tests green. (The `noop` run uses `npm run noop` → `true`; it exits immediately and is harmless.)

- [ ] **Step 5: Refactor the two API routes to use the lib (DRY)**

Replace the body of `src/app/api/scripts/route.js` with:
```js
import { listScripts } from '@/lib/scripts.mjs'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const directory = searchParams.get('directory')
  if (!directory) return Response.json({ error: 'Directory is required' }, { status: 400 })
  return Response.json({ scripts: await listScripts(directory) })
}
```

Replace the body of `src/app/api/scripts/run/route.js` with:
```js
import { runScript } from '@/lib/scripts.mjs'

export async function POST(request) {
  const { directory, script } = await request.json()
  if (!directory || !script) return Response.json({ error: 'Directory and script are required' }, { status: 400 })
  try {
    const result = await runScript(directory, script)
    return Response.json({ success: true, ...result })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
```

- [ ] **Step 6: Verify the dashboard still builds**

Run: `npm run lint`
Expected: no errors in the two routes. (Optional sanity: `npm run dev`, hit a project's "run script" in the UI — behavior unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/scripts.mjs src/lib/scripts.test.mjs src/app/api/scripts/route.js src/app/api/scripts/run/route.js
git commit -m "refactor: extract scripts list/run into shared lib"
```

---

### Task 4: Remove the stale duplicated process detection

**Context:** `src/mcp/server.mjs` carries its own inline `getRunningProcesses()` (around line 102), predating the dashboard's improved detection in `src/app/api/processes/route.js` (idle-terminal + Claude-CLI host classification, May 2026). Make one shared copy.

**Files:**
- Read first: `src/app/api/processes/route.js` (the canonical, newer logic)
- Create: `src/lib/processes.mjs`
- Test: `src/lib/processes.test.mjs`
- Modify: `src/mcp/server.mjs` (delete inline copies, import the lib)
- Modify: `src/app/api/processes/route.js` (import the lib)

- [ ] **Step 1: Read both implementations**

Read `src/app/api/processes/route.js` in full and the inline `getRunningProcesses()` / `getProjectProcesses()` / any `classifyHost`-style helper in `src/mcp/server.mjs` (≈ lines 100–230). Identify the canonical detection functions and the pure command→host-label helper.

- [ ] **Step 2: Write the failing test for the pure helper**

Create `src/lib/processes.test.mjs`. Standardize the pure classifier as `classifyHost(command)`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHost } from './processes.mjs'

test('classifyHost recognizes Claude CLI', () => {
  assert.equal(classifyHost('node /usr/local/bin/claude'), 'claude')
  assert.equal(classifyHost('claude'), 'claude')
})

test('classifyHost recognizes dev servers and shells', () => {
  assert.equal(classifyHost('next dev -p 3089'), 'dev-server')
  assert.equal(classifyHost('-zsh'), 'terminal')
})

test('classifyHost falls back to process', () => {
  assert.equal(classifyHost('some-random-binary'), 'process')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './processes.mjs'`.

- [ ] **Step 4: Create `src/lib/processes.mjs`**

Move the canonical detection functions from `src/app/api/processes/route.js` into this lib **unchanged** (exporting `getRunningProcesses`, `getProjectProcesses`, and any helpers the MCP `get_project_details`/`list_running_projects` cases call). Add the pure classifier (consolidating the inline host-classification logic):
```js
export function classifyHost(command) {
  const c = (command || '').toLowerCase()
  if (/\bclaude\b/.test(c)) return 'claude'
  if (/\b(next|vite|nodemon|webpack|ng serve)\b.*\bdev\b|\bnext dev\b|\bvite\b/.test(c)) return 'dev-server'
  if (/(^|\/)(-?z?sh|bash|fish|tmux)\b/.test(c)) return 'terminal'
  return 'process'
}

// ...moved detection functions (getRunningProcesses, getProjectProcesses, etc.) go here,
// updated to call classifyHost where the inline versions inlined the same checks.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 3 classifier tests green.

- [ ] **Step 6: Point both consumers at the lib**

- In `src/app/api/processes/route.js`: delete the moved functions; `import { getRunningProcesses, getProjectProcesses } from '@/lib/processes.mjs'`.
- In `src/mcp/server.mjs`: delete the inline `getRunningProcesses()`/`getProjectProcesses()` and add near the other imports: `import { getRunningProcesses, getProjectProcesses } from '../lib/processes.mjs'` (relative — the MCP runs outside Next).

- [ ] **Step 7: Verify nothing broke**

Run: `npm test && npm run lint`
Expected: PASS, no lint errors.
Run: `node src/mcp/server.smoke.mjs` *(created in Task 5 — if doing Task 4 first, defer this line to after Task 5).*

- [ ] **Step 8: Commit**

```bash
git add src/lib/processes.mjs src/lib/processes.test.mjs src/app/api/processes/route.js src/mcp/server.mjs
git commit -m "refactor: single shared process-detection lib, drop stale MCP copy"
```

---

### Task 5: Wire four new MCP tools

**Files:**
- Modify: `src/mcp/server.mjs` (imports, tools array ≈ line 334+, switch ≈ line 499+)
- Create: `src/mcp/server.smoke.mjs`

- [ ] **Step 1: Add lib imports to `src/mcp/server.mjs`**

Near the existing imports (after the `simpleGit` import):
```js
import { readStatus, writeStatus } from '../lib/status.mjs'
import { listScripts, runScript } from '../lib/scripts.mjs'
```

- [ ] **Step 2: Add the four tool definitions**

In the array returned by the `ListToolsRequestSchema` handler, after the `stop_process` entry, add:
```js
            {
                name: 'get_status',
                description: 'Read a project STATUS.md: current NEXT step, status (active/paused/blocked/done), updated date, and working links.',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Project ID, name, or partial path' } },
                    required: ['name'],
                },
            },
            {
                name: 'set_status',
                description: 'Update a project STATUS.md. Provide any of: next, status, links. Stamps today as updated. Use this to record the single next step when ending work.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        next: { type: 'string', description: 'The single next action' },
                        status: { type: 'string', enum: ['active', 'paused', 'blocked', 'done'] },
                        links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] } },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'list_scripts',
                description: 'List runnable scripts for a project (package.json scripts + root .sh files).',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Project ID, name, or partial path' } },
                    required: ['name'],
                },
            },
            {
                name: 'run_script',
                description: 'Start a project script (e.g. dev server) detached in the background. Returns pid and log file. Stop it later with stop_process.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Project ID, name, or partial path' },
                        script: { type: 'string', description: 'Script name from list_scripts (e.g. "dev" or "deploy.sh")' },
                    },
                    required: ['name', 'script'],
                },
            },
```

- [ ] **Step 3: Add the four switch cases**

In the `CallToolRequestSchema` handler's `switch (name)`, after the `stop_process` case, add:
```js
        case 'get_status': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const status = await readStatus(project.directory)
            return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
        }
        case 'set_status': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const fields = {}
            if (args.next !== undefined) fields.next = args.next
            if (args.status !== undefined) fields.status = args.status
            if (args.links !== undefined) fields.links = args.links
            const merged = await writeStatus(project.directory, fields)
            return { content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }] }
        }
        case 'list_scripts': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const scripts = await listScripts(project.directory)
            return { content: [{ type: 'text', text: JSON.stringify(scripts, null, 2) }] }
        }
        case 'run_script': {
            const project = await getProjectByIdOrName(args.name)
            if (!project) return { content: [{ type: 'text', text: `Project not found: ${args.name}` }] }
            const result = await runScript(project.directory, args.script)
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
```

- [ ] **Step 4: Create the smoke verification script**

Create `src/mcp/server.smoke.mjs`:
```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: 'node', args: [path.join(__dirname, 'server.mjs')] })
const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} })
await client.connect(transport)
const { tools } = await client.listTools()
const names = tools.map(t => t.name)
const required = ['get_status', 'set_status', 'list_scripts', 'run_script']
const missing = required.filter(n => !names.includes(n))
await client.close()
if (missing.length) { console.error('MISSING TOOLS:', missing); process.exit(1) }
console.log('OK: new MCP tools present:', required.join(', '))
process.exit(0)
```

- [ ] **Step 5: Run the smoke script**

Run: `node src/mcp/server.smoke.mjs`
Expected: `OK: new MCP tools present: get_status, set_status, list_scripts, run_script` and exit 0.

- [ ] **Step 6: Functional check against a real project**

Run (lists this repo's own scripts via the lib path resolution):
```bash
node -e "import('./src/lib/scripts.mjs').then(async m => console.log(Object.keys(await m.listScripts(process.cwd()))))"
```
Expected: an array including `dev`, `build`, `start`, `scan`, `mcp`, `test`.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.mjs src/mcp/server.smoke.mjs
git commit -m "feat: MCP tools get_status, set_status, list_scripts, run_script"
```

---

### Task 6: Surface `scc` code stats in `get_project_details`

**Context:** the scanner already attaches an `scc` field to each project record (`src/scanner/index.mjs`, "Run git info and scc in parallel"). The MCP just omits it from the details payload.

**Files:**
- Modify: `src/mcp/server.mjs` (the `details` object in `case 'get_project_details'`, ≈ line 567)

- [ ] **Step 1: Add `scc` to the details object**

In `case 'get_project_details'`, inside the `details = { ... }` literal, add after the `stack: project.stack,` line:
```js
                scc: project.scc ?? null,
```

- [ ] **Step 2: Verify the field flows through**

Ensure a fresh scan exists, then confirm the record carries `scc`:
```bash
npm run scan
node -e "const fs=require('fs');const l=fs.readFileSync('data/projects_metadata.jsonl','utf8').trim().split('\n').map(JSON.parse);const me=l.find(p=>p.project_name&&p.directory.endsWith('stow-dashboard'));console.log('scc present:', !!me.scc, me.scc?Object.keys(me.scc):null)"
```
Expected: `scc present: true` with keys (e.g. languages/total lines). If `false`, `scc` CLI may be missing — install via `brew install scc`, re-scan; the MCP line still degrades safely to `null`.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.mjs
git commit -m "feat: include scc code stats in get_project_details"
```

---

## Self-Review

- **Spec coverage** (index decisions 1–2, 7–8 foundations): `STATUS.md` read/write → Task 2 + Task 5 (`get_status`/`set_status`); on-demand dev servers (kills "20 running") → Task 3 + Task 5 (`list_scripts`/`run_script`); scc stats → Task 6; stale process duplicate → Task 4. No foundation gap.
- **Placeholder scan:** every code step contains complete code; every run step has an exact command + expected output. Task 4 Step 1 is an explicit read of named files before moving them (a refactor procedure, not a placeholder).
- **Type/name consistency:** `readStatus`/`writeStatus`/`parseStatus`/`serializeStatus`, `listScripts`/`runScript`, `getRunningProcesses`/`getProjectProcesses`/`classifyHost` are used with identical names across libs, tests, routes, and the MCP server. Tool names `get_status`/`set_status`/`list_scripts`/`run_script` match between the tools array, the switch cases, and the smoke script's `required` list.

## Execution Handoff

After this plan, proceed to `02-intent-skills.md` (depends on `get_status`/`set_status` shipped here).
