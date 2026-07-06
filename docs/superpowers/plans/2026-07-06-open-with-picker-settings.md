# Open-With Pickers + Settings Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split-button IDE/Terminal openers in the details sheet (picker + last-used default) with app lists configurable in a new header settings dialog.

**Architecture:** Pure config parsing/validation in `src/lib/open-with.mjs` (unit-tested, reads `.env.local` per request so settings apply without restart). `POST /api/open-with` gains an allowlist-validated `app` field and a `GET` that returns the configured lists. New `SplitOpenButton` component used twice in the sheet; new `SettingsDialog` (gear) next to ScanControls in the header; `/api/settings` whitelist extended.

**Tech Stack:** Next.js 16 API routes, node:test, existing shadcn ui components (dialog.jsx, input.jsx, dropdown-menu.jsx all already exist in `src/components/ui/`).

**Spec:** `docs/superpowers/specs/2026-07-06-open-with-picker-settings-design.md`

## Global Constraints

- API field names are the EXISTING ones: `{ directory, action: 'vscode'|'terminal'|'finder', app? }` — `action: 'vscode'` means "IDE" (legacy name, kept for backward compatibility with existing callers incl. MCP). Requests without `app` behave exactly as today (first/legacy configured app).
- **Server-side allowlist:** `app` must be an exact member of the configured list for its action; otherwise HTTP 400. Never exec a client-supplied string that is not in the list.
- Env keys: `IDE_COMMANDS` (comma-separated CLI commands, invoked `<cmd> -n "<dir>"`), `TERMINAL_APPS` (comma-separated app names, invoked `open -a "<app>" "<dir>"`). Fallback order per type: list key → legacy single key (`IDE_COMMAND`/`TERMINAL_APP`) → hard default (`code`/`Terminal`). First list item = default.
- The four keys are read from `.env.local` per request (merged over `process.env`) so a settings save applies immediately, no server restart.
- localStorage keys: `stow-dashboard-open-ide`, `stow-dashboard-open-terminal`; a stored value not present in the configured list falls back to the first entry.
- Tests: `npm test` (node --test), lib tests in `src/lib/open-with.test.mjs`, plain relative imports.
- Finder button and the Run-script dropdown in the sheet stay unchanged.

---

### Task 1: `src/lib/open-with.mjs` + unit tests

**Files:**
- Create: `src/lib/open-with.mjs`
- Test: `src/lib/open-with.test.mjs`

**Interfaces:**
- Produces (used by Task 2):
  - `parseAppList(listValue, legacyValue, hardDefault): string[]`
  - `isAllowedApp(app: string, list: string[]): boolean`
  - `readOpenWithEnv(envPath: string): Promise<{ ide: string[], terminal: string[] }>` — reads `.env.local` (missing file OK), merges file values over `process.env`, applies the fallback chain.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/open-with.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseAppList, isAllowedApp, readOpenWithEnv } from './open-with.mjs'

test('parseAppList splits, trims and filters a comma list', () => {
    assert.deepEqual(parseAppList(' code, cursor ,zed,, ', 'ignored', 'code'), ['code', 'cursor', 'zed'])
})

test('parseAppList falls back to the legacy single value', () => {
    assert.deepEqual(parseAppList(undefined, 'cursor', 'code'), ['cursor'])
    assert.deepEqual(parseAppList('   ', 'cursor', 'code'), ['cursor'])
})

test('parseAppList falls back to the hard default when nothing is set', () => {
    assert.deepEqual(parseAppList(undefined, undefined, 'Terminal'), ['Terminal'])
    assert.deepEqual(parseAppList('', '  ', 'Terminal'), ['Terminal'])
})

test('isAllowedApp is exact membership', () => {
    assert.equal(isAllowedApp('cursor', ['code', 'cursor']), true)
    assert.equal(isAllowedApp('cursor; rm -rf /', ['code', 'cursor']), false)
    assert.equal(isAllowedApp('Code', ['code']), false) // case-sensitive
})

test('readOpenWithEnv reads lists from an env file and strips quotes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openwith-'))
    const envPath = path.join(dir, '.env.local')
    await fs.writeFile(envPath, '# comment\nIDE_COMMANDS="code,cursor"\nTERMINAL_APPS=Terminal, Warp\n')
    const config = await readOpenWithEnv(envPath)
    assert.deepEqual(config.ide, ['code', 'cursor'])
    assert.deepEqual(config.terminal, ['Terminal', 'Warp'])
    await fs.rm(dir, { recursive: true, force: true })
})

test('readOpenWithEnv tolerates a missing env file (falls back to process.env/defaults)', async () => {
    const before = { IDE_COMMANDS: process.env.IDE_COMMANDS, IDE_COMMAND: process.env.IDE_COMMAND }
    delete process.env.IDE_COMMANDS
    process.env.IDE_COMMAND = 'zed'
    try {
        const config = await readOpenWithEnv('/nonexistent/.env.local')
        assert.deepEqual(config.ide, ['zed'])
    } finally {
        if (before.IDE_COMMANDS !== undefined) process.env.IDE_COMMANDS = before.IDE_COMMANDS
        if (before.IDE_COMMAND !== undefined) process.env.IDE_COMMAND = before.IDE_COMMAND
        else delete process.env.IDE_COMMAND
    }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/lib/open-with.test.mjs`
Expected: FAIL — `Cannot find module ... open-with.mjs`

- [ ] **Step 3: Implement `src/lib/open-with.mjs`**

```js
/**
 * Open-with configuration: which IDE commands and terminal apps the
 * dashboard may launch. Read from .env.local PER REQUEST (merged over
 * process.env) so the settings dialog applies without a server restart.
 * The lists double as the security allowlist for /api/open-with.
 */

import fs from 'node:fs/promises'

const HARD_DEFAULTS = { ide: 'code', terminal: 'Terminal' }

export function parseAppList(listValue, legacyValue, hardDefault) {
    const raw = (listValue ?? '').trim()
    if (raw) {
        const items = raw.split(',').map(s => s.trim()).filter(Boolean)
        if (items.length) return items
    }
    const legacy = (legacyValue ?? '').trim()
    if (legacy) return [legacy]
    return [hardDefault]
}

export function isAllowedApp(app, list) {
    return list.includes(app)
}

function parseEnvContent(content) {
    const vars = {}
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const pos = line.indexOf('=')
        if (pos === -1) continue
        const value = line.slice(pos + 1).trim()
        vars[line.slice(0, pos).trim()] = value.replace(/^(['"])(.*)\1$/, '$2')
    }
    return vars
}

export async function readOpenWithEnv(envPath) {
    let fileVars = {}
    try {
        fileVars = parseEnvContent(await fs.readFile(envPath, 'utf-8'))
    } catch {
        // No .env.local — process.env / defaults apply
    }
    const get = (key) => fileVars[key] ?? process.env[key]
    return {
        ide: parseAppList(get('IDE_COMMANDS'), get('IDE_COMMAND'), HARD_DEFAULTS.ide),
        terminal: parseAppList(get('TERMINAL_APPS'), get('TERMINAL_APP'), HARD_DEFAULTS.terminal),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/open-with.test.mjs` → all PASS. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/open-with.mjs src/lib/open-with.test.mjs
git commit -m "feat: open-with config lib — app lists with legacy fallback + allowlist check"
```

---

### Task 2: API — `app` override + GET lists in `/api/open-with`

**Files:**
- Modify: `src/app/api/open-with/route.js` (full rewrite below)

**Interfaces:**
- Consumes: `readOpenWithEnv`, `isAllowedApp` from Task 1.
- Produces (Task 4 depends on): `GET /api/open-with` → `{ ide: string[], terminal: string[] }`; `POST` accepts optional `app` (validated), unchanged behavior without it.

- [ ] **Step 1: Rewrite the route**

```js
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readOpenWithEnv, isAllowedApp } from '@/lib/open-with.mjs'

const execAsync = promisify(exec)
const ENV_PATH = path.join(process.cwd(), '.env.local')

export async function GET() {
    const config = await readOpenWithEnv(ENV_PATH)
    return Response.json(config)
}

export async function POST(request) {
    const { directory, action, app } = await request.json()

    if (!directory) {
        return Response.json({ error: 'Directory is required' }, { status: 400 })
    }

    const config = await readOpenWithEnv(ENV_PATH)

    try {
        switch (action) {
            case 'vscode': {
                const cmd = app ?? config.ide[0]
                if (!isAllowedApp(cmd, config.ide)) {
                    return Response.json({ error: `IDE not configured: ${cmd}` }, { status: 400 })
                }
                // -n flag opens in new window (works for code, cursor, zed, etc.)
                await execAsync(`${cmd} -n "${directory}"`)
                break
            }
            case 'finder':
                await execAsync(`open "${directory}"`)
                break
            case 'terminal': {
                const term = app ?? config.terminal[0]
                if (!isAllowedApp(term, config.terminal)) {
                    return Response.json({ error: `Terminal not configured: ${term}` }, { status: 400 })
                }
                await execAsync(`open -a "${term}" "${directory}"`)
                break
            }
            default:
                return Response.json({ error: 'Unknown action' }, { status: 400 })
        }

        return Response.json({ success: true })
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}
```

- [ ] **Step 2: Verify against the dev server**

With `npm run dev` (reuse if already running on 3089; do not kill the user's):

```bash
curl -s http://localhost:3089/api/open-with
# expect {"ide":[...],"terminal":[...]} matching your .env.local (or defaults)
curl -s -X POST http://localhost:3089/api/open-with -H 'Content-Type: application/json' \
  -d '{"directory":"/tmp","action":"vscode","app":"definitely-not-configured"}'
# expect {"error":"IDE not configured: definitely-not-configured"} with HTTP 400 (-w '%{http_code}')
```

Do NOT verify the happy path by actually launching apps on the user's machine beyond ONE quick check: `{"directory":"/tmp","action":"finder"}` (opens a Finder window — acceptable) — confirm `{"success":true}`.

- [ ] **Step 3: Run `npm test` (all pass), commit**

```bash
git add src/app/api/open-with/route.js
git commit -m "feat: open-with API — per-request config, GET lists, allowlist-validated app override"
```

---

### Task 3: Settings dialog + header gear

**Files:**
- Create: `src/components/SettingsDialog.js`
- Modify: `src/app/api/settings/route.js` (extend `SETTINGS_KEYS`)
- Modify: `src/app/page.js` (render gear next to ScanControls, line ~112)

**Interfaces:**
- Consumes: existing `GET/POST /api/settings`.
- Produces: settings UI for `SCAN_ROOTS`, `BASE_DIR`, `IDE_COMMANDS`, `TERMINAL_APPS`.

- [ ] **Step 1: Extend the settings whitelist**

In `src/app/api/settings/route.js` change:

```js
const SETTINGS_KEYS = ['SCAN_ROOTS', 'BASE_DIR', 'TERMINAL_APP', 'IDE_COMMAND']
```

to:

```js
const SETTINGS_KEYS = ['SCAN_ROOTS', 'BASE_DIR', 'TERMINAL_APP', 'IDE_COMMAND', 'TERMINAL_APPS', 'IDE_COMMANDS']
```

Read the POST handler before assuming: it writes keys present in the body and appends missing ones — verify a posted `IDE_COMMANDS` lands in `.env.local` and survives a GET round-trip.

- [ ] **Step 2: Create `src/components/SettingsDialog.js`**

```jsx
'use client'

import * as React from 'react'
import { Settings, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'

const FIELDS = [
    { key: 'SCAN_ROOTS', label: 'Scan roots', help: 'Comma-separated directories scanned for projects' },
    { key: 'BASE_DIR', label: 'Base directory', help: 'Base for relative paths shown in the UI' },
    { key: 'IDE_COMMANDS', label: 'IDE commands', help: 'Comma-separated CLI commands, e.g. code,cursor,zed — first is the default' },
    { key: 'TERMINAL_APPS', label: 'Terminal apps', help: 'Comma-separated app names, e.g. Terminal,Warp,cmux — first is the default' },
]

export function SettingsDialog() {
    const [open, setOpen] = React.useState(false)
    const [values, setValues] = React.useState({})
    const [loading, setLoading] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState(null)

    React.useEffect(() => {
        if (!open) return
        setLoading(true)
        setError(null)
        fetch('/api/settings')
            .then(r => r.json())
            .then(data => setValues(data || {}))
            .catch(() => setError('Failed to load settings'))
            .finally(() => setLoading(false))
    }, [open])

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values),
            })
            if (!res.ok) throw new Error('Save failed')
            setOpen(false)
        } catch (e) {
            setError(e.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" title="Settings">
                    <Settings className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Stored in this instance&apos;s .env.local — applied immediately, no restart needed.
                    </DialogDescription>
                </DialogHeader>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        {FIELDS.map(({ key, label, help }) => (
                            <div key={key} className="space-y-1">
                                <label className="text-sm font-medium" htmlFor={`setting-${key}`}>{label}</label>
                                <Input
                                    id={`setting-${key}`}
                                    value={values[key] ?? ''}
                                    onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))}
                                    placeholder={key}
                                />
                                <p className="text-xs text-muted-foreground">{help}</p>
                            </div>
                        ))}
                        {error && <p className="text-sm text-destructive">{error}</p>}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={save} disabled={saving || loading}>
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
```

Check `src/components/ui/dialog.jsx`'s actual exports first and adapt import names if they differ from the standard shadcn set.

- [ ] **Step 3: Render it in the header**

In `src/app/page.js`: add `import { SettingsDialog } from '@/components/SettingsDialog'` and render `<SettingsDialog />` immediately after `<ScanControls lastSyncTime={lastSyncTime} />` (line ~112), inside the same flex container.

- [ ] **Step 4: Verify in the browser**

Dev server + Playwright MCP or manual: gear opens dialog; values load from .env.local; set `IDE_COMMANDS=code,cursor,zed` and `TERMINAL_APPS=Terminal,Warp`; Save; `curl -s http://localhost:3089/api/open-with` now returns those lists (per-request read proven, no restart). Re-open dialog — values persisted.

- [ ] **Step 5: `npm run lint` (no new warnings), commit**

```bash
git add src/components/SettingsDialog.js src/app/api/settings/route.js src/app/page.js
git commit -m "feat: settings dialog in header (scan roots, base dir, IDE/terminal app lists)"
```

---

### Task 4: Split buttons in the details sheet

**Files:**
- Create: `src/components/SplitOpenButton.js`
- Modify: `src/components/ProjectDetailsSheet.js` (openWith signature ~line 183-197; buttons block ~line 250-273)

**Interfaces:**
- Consumes: `GET /api/open-with` lists (Task 2); `POST` with `app`.
- Produces: `SplitOpenButton({ icon, label, apps, storageKey, onOpen })`.

- [ ] **Step 1: Create `src/components/SplitOpenButton.js`**

```jsx
'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Split button: main segment opens with the last-used app (persisted per
 * browser in localStorage), chevron opens the picker. `apps` order comes
 * from settings; a stored value no longer configured falls back to apps[0].
 */
export function SplitOpenButton({ icon: Icon, label, apps, storageKey, onOpen }) {
    const [lastUsed, setLastUsed] = React.useState(null)

    React.useEffect(() => {
        try {
            const saved = localStorage.getItem(storageKey)
            if (saved) setLastUsed(saved)
        } catch {
            // localStorage unavailable — session-only behavior
        }
    }, [storageKey])

    if (!apps || apps.length === 0) return null
    const current = apps.includes(lastUsed) ? lastUsed : apps[0]

    const openApp = (app) => {
        try {
            localStorage.setItem(storageKey, app)
        } catch {}
        setLastUsed(app)
        onOpen(app)
    }

    return (
        <div className="flex">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        className={`h-8 w-8 ${apps.length > 1 ? 'rounded-r-none' : ''}`}
                        onClick={() => openApp(current)}
                    >
                        <Icon className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent><p>{label}: {current}</p></TooltipContent>
            </Tooltip>
            {apps.length > 1 && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" className="h-8 w-5 rounded-l-none border-l-0 px-0">
                            <ChevronDown className="h-3 w-3" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {apps.map(app => (
                            <DropdownMenuItem
                                key={app}
                                onClick={() => openApp(app)}
                                className={app === current ? 'font-medium' : ''}
                            >
                                {app}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    )
}
```

- [ ] **Step 2: Wire it into `ProjectDetailsSheet.js`**

1. Import: `import { SplitOpenButton } from '@/components/SplitOpenButton'`.
2. Add list state + fetch (near the other state, ~line 100):

```jsx
const [openWithApps, setOpenWithApps] = React.useState({ ide: [], terminal: [] })

React.useEffect(() => {
    fetch('/api/open-with')
        .then(r => r.json())
        .then(d => setOpenWithApps({ ide: d.ide || [], terminal: d.terminal || [] }))
        .catch(() => {})
}, [])
```

3. Change `openWith` to pass the app through (~line 183):

```jsx
const openWith = async (action, app) => {
    try {
        await fetch('/api/open-with', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directory: project.directory, action, app })
        })
    } catch (e) {
        console.error(`Failed to open with ${action}:`, e)
    }
}

const openInFinder = () => openWith('finder')
```

Delete `openInTerminal` and `openInVSCode` (their callers are replaced below).

4. Replace the IDE button block (the `Tooltip` wrapping the `Code` icon button, ~lines 250-257) with:

```jsx
<SplitOpenButton
    icon={Code}
    label="Open in IDE"
    apps={openWithApps.ide}
    storageKey="stow-dashboard-open-ide"
    onOpen={(app) => openWith('vscode', app)}
/>
```

5. Replace the Terminal button block (~lines 266-273) with:

```jsx
<SplitOpenButton
    icon={Terminal}
    label="Open in Terminal"
    apps={openWithApps.terminal}
    storageKey="stow-dashboard-open-terminal"
    onOpen={(app) => openWith('terminal', app)}
/>
```

Finder button stays as-is between them.

- [ ] **Step 3: Verify in the browser**

Dev server + Playwright MCP (or manual): open a project's sheet →
1. IDE split button shows; hover tooltip says "Open in IDE: code" (first configured).
2. Chevron lists all configured IDEs; pick a different one → tooltip/current changes; reload page + reopen sheet → choice persisted (localStorage).
3. Same for Terminal.
4. With a single-item list (temporarily set `TERMINAL_APPS=Terminal` via the settings dialog) the chevron disappears (plain button).
5. Actually launching: verify ONE combination end-to-end (e.g. pick `Terminal`) — a terminal window opens on the user's machine; that's expected and acceptable. Don't spam-open every app.
6. `npm run lint` — no new warnings; `npm test` — all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/SplitOpenButton.js src/components/ProjectDetailsSheet.js
git commit -m "feat: IDE/terminal split buttons with app picker and last-used default"
```

---

### Task 5: Docs + STATUS

**Files:**
- Modify: `CLAUDE.md`
- Modify: `STATUS.md`

- [ ] **Step 1: CLAUDE.md**

1. In "### Environment Variables", replace the `TERMINAL_APP`/`IDE_COMMAND` lines with:

```bash
IDE_COMMANDS=code,cursor,zed        # Comma-separated IDE CLI commands (first = default; legacy IDE_COMMAND still honored)
TERMINAL_APPS=Terminal,Warp,cmux    # Comma-separated terminal apps (first = default; legacy TERMINAL_APP still honored)
```

2. In Important Files, add after the `src/app/api/open-with/route.js` line:

```markdown
- `src/components/SettingsDialog.js` - Header settings dialog (.env.local editor)
- `src/components/SplitOpenButton.js` - Split button with app picker (IDE/terminal openers)
- `src/lib/open-with.mjs` - Open-with app lists, legacy fallback, allowlist validation
```

3. Update the `src/app/api/open-with/route.js` line's description to `- API for opening projects in IDE/Terminal/Finder (GET returns configured app lists; POST validates the app against them)`.

- [ ] **Step 2: STATUS.md**

Prepend to NEXT: "Open-with pickers + settings dialog SHIPPED (spec docs/superpowers/specs/2026-07-06-open-with-picker-settings-design.md). " — keep everything else, bump `updated:` if the date changed.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: open-with pickers + settings dialog (CLAUDE.md, STATUS)"
```
