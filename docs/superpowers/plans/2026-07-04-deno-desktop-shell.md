# Deno Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Deno-based desktop shell (`deno desktop`, Deno 2.9+) for the existing Next.js dashboard, with full parity to the Tauri shell, plus a measured Tauri-vs-Deno comparison doc and an ADR.

**Architecture:** Custom entrypoint `src-deno/main.ts` starts the Next.js standalone server **in-process** via Deno's Node compat (no system Node), waits for port 3087, then opens a `Deno.BrowserWindow` and a `Deno.Tray` mirroring the Tauri tray. Writable state (`data/`, `.env.local`) lives in `~/Library/Application Support/StowDashboardDeno` because the app reads them via `process.cwd()` and a compiled binary's embedded VFS may be read-only.

**Tech Stack:** Deno ≥ 2.9 (`deno desktop`, `Deno.BrowserWindow`, `Deno.Tray`), Next.js 16 standalone output, existing `src-tauri/icons/`.

**Spec:** `docs/superpowers/specs/2026-07-04-deno-desktop-shell-design.md`

## Global Constraints

- Deno **≥ 2.9.0** required (`deno desktop` is experimental; machine currently has 2.8.3 via Homebrew).
- Deno shell port: **3087**. Tauri prod: 3088. Dev server: 3089. Never reuse 3088/3089.
- **Tauri stays untouched** — no edits under `src-tauri/` or to `prepare-tauri.mjs`.
- App name `Stow Dashboard Deno`, identifier `com.trisoft.stow-dashboard-deno` (distinct from Tauri's `com.trisoft.stow-dashboard`).
- `deno desktop` API signatures in this plan come from https://docs.deno.com/runtime/desktop/ (fetched 2026-07-04). **Task 1 re-verifies them against live docs; if a signature differs, update the plan file first, then proceed.**
- Task 1 is a **GATE**: if Next.js 16 fundamentally cannot run under `deno desktop`, stop after Task 1 and jump to Task 7 (ADR = "wait"), skipping Tasks 2–6.
- No automated test framework exists for shell code; every task ends with exact manual verification commands + expected output, and results are recorded in `docs/deno-vs-tauri.md`.

---

### Task 1: Deno upgrade + spike gate (auto-detect run)

**Files:**
- Create: `docs/deno-vs-tauri.md` (skeleton + spike results)

**Interfaces:**
- Produces: a go/no-go decision recorded in `docs/deno-vs-tauri.md` § "Spike results"; verified API signatures for `Deno.BrowserWindow`, `Deno.Tray`, `deno.json` desktop block used by Tasks 2–4.

- [ ] **Step 1: Upgrade Deno**

```bash
brew upgrade deno
deno --version
```

Expected: `deno 2.9.x` (or newer). If Homebrew doesn't have 2.9 yet, use `deno upgrade` instead and note which binary wins in `PATH` (`which deno`).

- [ ] **Step 2: Verify plan's API assumptions against live docs**

Read these pages (browser or `curl`):
- https://docs.deno.com/runtime/desktop/windows/ — confirm `new Deno.BrowserWindow({title, width, height})`, `win.navigate(url)`, `win.show/hide/focus/isVisible`, `close` event with `e.preventDefault()`.
- https://docs.deno.com/runtime/desktop/tray_and_dock/ — confirm `new Deno.Tray()`, `tray.setIcon(bytes)`, `tray.setMenu([{item: {label, id, enabled}}])`, `menuclick` event with `e.detail.id`, `click` event.
- https://docs.deno.com/runtime/desktop/configuration/ — confirm `desktop.app.{name,identifier,icons}`, `desktop.backend`, `desktop.output` in `deno.json`.
- https://docs.deno.com/runtime/desktop/frameworks/ — confirm custom entrypoint (`deno desktop ./main.ts`) means "import and start the framework yourself".

If any signature differs from the code in Tasks 3–4, edit this plan file now to match reality, commit the plan change, then continue.

- [ ] **Step 3: Build Next.js and run the auto-detect spike**

```bash
npm run build
deno desktop -A .
```

Expected: a native window opens showing the dashboard (auto-detected Next.js, own port via `DENO_SERVE_ADDRESS`). If the command errors, capture the full error verbatim.

**Verified in this task's spike:** `-A` is required. Without it, Next.js crashes immediately on
startup (`NotCapable: Requires env access to "__NEXT_PRIVATE_CPU_PROFILE"`) before binding a port —
see `docs/deno-vs-tauri.md` for the verbatim error and rationale. Also note: `deno desktop .` (no
`-o`/`--output`) compiles and codesigns `./<package-name>.app` in the project root and then exits
without auto-launching it in this environment; launch the produced `.app` (or run its
`Contents/MacOS/<binary>` directly) to see the window.

- [ ] **Step 4: Exercise the compatibility checklist in the spike window**

In the running app, verify each item and note works/fails + error text:

1. Project table renders with data (JSONL read via `fs`)
2. Open a project's details sheet → live git status loads (`simple-git`)
3. Running column shows processes (`child_process` + `lsof`)
4. Docker containers listed if any run (`docker ps`)
5. Trigger scan from UI → completes, table refreshes (`scc` spawn, gitignore walker, JSONL **write**)
6. Script runner: list scripts on a project, run one, Attach (spawn + `nohup` + `/tmp/stow-scripts/` logs)
7. Open-with buttons (IDE/Terminal/Finder — `open`/`osascript` spawns)

- [ ] **Step 5: Create the comparison doc skeleton with spike results**

Create `docs/deno-vs-tauri.md`:

```markdown
# Deno Desktop vs Tauri — comparison

Companion to `docs/superpowers/specs/2026-07-04-deno-desktop-shell-design.md`.
Both shells wrap the same Next.js 16 standalone app. Tauri: port 3088. Deno: port 3087.

## Spike results (deno desktop auto-detect, Deno 2.9.x, YYYY-MM-DD)

| Check | Result | Notes |
| --- | --- | --- |
| Window opens with dashboard | | |
| JSONL data read | | |
| Live git status (simple-git) | | |
| Process detection (lsof) | | |
| Docker containers | | |
| Scan incl. scc + JSONL write | | |
| Script runner (nohup + logs) | | |
| Open-with (IDE/Terminal/Finder) | | |

**Gate verdict:** GO / NO-GO — <one sentence why>

## Node API compatibility notes

<anything that needed workarounds, error messages verbatim>

## Measurements

Filled in Task 6.

| Metric | Tauri | Deno (webview) |
| --- | --- | --- |
| Bundle size (.app) | | |
| DMG size | | |
| Cold start → window interactive | | |
| RAM total (shell + server procs) | | |
| Build time (clean) | | |
| Runtime dependency | system Node.js | none (bundled runtime) |
| Shell code | ~330 lines Rust | <fill> lines TypeScript |

## DX notes

Filled in Task 6.
```

Fill the spike table with Step 4 results and set the gate verdict.

- [ ] **Step 6: Commit**

```bash
git add docs/deno-vs-tauri.md
git commit -m "docs: deno desktop spike results + comparison skeleton"
```

**GATE:** If the verdict is NO-GO (window never opens, or Next.js server crashes under Node compat with no workaround), skip to Task 7 and write the ADR as "wait for maturity", citing the exact failures. Partial failures (e.g. one API route broken) are not a NO-GO — record them and continue.

---

### Task 2: deno.json, prepare script, tray icon, npm scripts

**Files:**
- Create: `deno.json`
- Create: `scripts/prepare-deno.mjs`
- Create: `src-deno/icons/tray.png` (generated)
- Modify: `package.json` (scripts block)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `src-deno/standalone/` populated with server.js + static + data + .env.local (consumed by Task 3's `server.ts`); `npm run deno:prepare`, `deno:run`, `deno:build` scripts; tray icon at `src-deno/icons/tray.png` (consumed by Task 4).

- [ ] **Step 1: Create `deno.json`**

```json
{
  "desktop": {
    "app": {
      "name": "Stow Dashboard Deno",
      "identifier": "com.trisoft.stow-dashboard-deno",
      "icons": {
        "macos": "./src-tauri/icons/icon.icns"
      }
    },
    "backend": "webview",
    "output": {
      "macos": "./dist/Stow Dashboard Deno.app"
    }
  }
}
```

- [ ] **Step 2: Create `scripts/prepare-deno.mjs`**

Mirrors `prepare-tauri.mjs` but assembles into `src-deno/standalone/` (Tauri's script is left untouched per Global Constraints):

```js
#!/usr/bin/env node
/**
 * Prepares the Next.js standalone build for the Deno desktop shell.
 * Assembles .next/standalone + static assets + data + .env.local
 * into src-deno/standalone/.
 */

import { cpSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SRC = join(ROOT, '.next', 'standalone');
const DEST = join(ROOT, 'src-deno', 'standalone');

console.log('Preparing standalone build for Deno desktop...');

if (!existsSync(SRC)) {
  console.error('Error: .next/standalone not found. Run "npm run build" first.');
  process.exit(1);
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const copies = [
  [join(ROOT, '.next', 'static'), join(DEST, '.next', 'static')],
  [join(ROOT, 'data'), join(DEST, 'data')],
  [join(ROOT, '.env.local'), join(DEST, '.env.local')],
];
for (const [from, to] of copies) {
  if (existsSync(from)) {
    console.log(`Copying ${from.replace(ROOT + '/', '')}...`);
    cpSync(from, to, { recursive: true });
  }
}

const toRemove = ['eslint.config.mjs', 'postcss.config.mjs', 'tailwind.config.js', 'LICENSE', 'src'];
for (const file of toRemove) {
  const path = join(DEST, file);
  if (existsSync(path)) rmSync(path, { recursive: true });
}

console.log('Done! src-deno/standalone ready.');
```

- [ ] **Step 3: Generate the tray icon (22×22 for macOS)**

```bash
mkdir -p src-deno/icons
sips -z 22 22 src-tauri/icons/32x32.png --out src-deno/icons/tray.png
```

Expected: `src-deno/icons/tray.png` exists (verify with `file src-deno/icons/tray.png` → PNG 22 x 22).

- [ ] **Step 4: Add npm scripts and gitignore entries**

In `package.json` scripts, after the `"tauri:build"` line, add:

```json
    "deno:prepare": "npm run build && node scripts/prepare-deno.mjs",
    "deno:run": "deno desktop -A src-deno/main.ts",
    "deno:build": "npm run deno:prepare && deno desktop -A --include src-deno/standalone --include src-deno/icons -o \"dist/Stow Dashboard Deno.app\" src-deno/main.ts",
```

**Verified in Task 1's spike:** `deno desktop` (and the compiled app) run under Deno's permission
system. Without `-A` (allow-all), Next.js crashes on startup — the first internal module that reads
`process.env` throws `NotCapable: Requires env access to "__NEXT_PRIVATE_CPU_PROFILE"` before the
server can bind a port. This app needs unrestricted env/read/write/net/run/sys access anyway (scans
the filesystem, spawns `scc`/`git`/`lsof`/`docker`/`osascript`, writes JSONL) — the same access it
already has for free under Tauri + system Node, which has no permission sandbox. See
`docs/deno-vs-tauri.md` § "Node API compatibility notes" for the verbatim error.

In `.gitignore`, after the `/build` line, add:

```
# Deno desktop shell (generated)
/src-deno/standalone/
/dist/
```

- [ ] **Step 5: Verify prepare script**

```bash
npm run deno:prepare
ls src-deno/standalone/server.js src-deno/standalone/.next/static src-deno/standalone/data src-deno/standalone/.env.local
```

Expected: all four paths listed, no errors. (`deno:run`/`deno:build` will only work after Tasks 3–4 — do not run them yet.)

- [ ] **Step 6: Commit**

```bash
git add deno.json scripts/prepare-deno.mjs src-deno/icons/tray.png package.json .gitignore
git commit -m "feat: deno desktop scaffolding (deno.json, prepare script, tray icon, scripts)"
```

---

### Task 3: server.ts — in-process Next.js standalone server on 3087

**Files:**
- Create: `src-deno/server.ts`

**Interfaces:**
- Consumes: `src-deno/standalone/` from Task 2.
- Produces: `export const PORT: number` (3087), `export const BASE_URL: string`, `export async function startServer(): Promise<void>`, `export async function waitForServer(url: string, timeoutMs: number): Promise<boolean>` — consumed by Task 4's `main.ts`.

- [ ] **Step 1: Write `src-deno/server.ts`**

```ts
/**
 * Starts the Next.js standalone server in-process (Deno Node compat) on PORT.
 *
 * The app resolves data/projects_metadata.jsonl and .env.local via
 * process.cwd() (see src/lib/projects.js), and the scan API writes back to
 * cwd. A compiled binary's embedded VFS may be read-only, so on startup we
 * sync writable state to ~/Library/Application Support/StowDashboardDeno
 * and chdir there.
 */

import { copy, exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

export const PORT = 3087;
export const BASE_URL = `http://localhost:${PORT}`;

const STANDALONE_DIR = new URL("./standalone/", import.meta.url).pathname;

function appDataDir(): string {
  const home = Deno.env.get("HOME") ?? ".";
  return join(home, "Library", "Application Support", "StowDashboardDeno");
}

function loadEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  let content: string;
  try {
    content = Deno.readTextFileSync(path);
  } catch {
    return vars;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pos = line.indexOf("=");
    if (pos === -1) continue;
    vars[line.slice(0, pos).trim()] = line.slice(pos + 1).trim();
  }
  return vars;
}

/** First run: seed writable state (data/, .env.local) from the bundle. */
async function prepareWritableCwd(): Promise<string> {
  const dir = appDataDir();
  await Deno.mkdir(dir, { recursive: true });
  if (!(await exists(join(dir, "data")))) {
    if (await exists(join(STANDALONE_DIR, "data"))) {
      await copy(join(STANDALONE_DIR, "data"), join(dir, "data"));
    } else {
      await Deno.mkdir(join(dir, "data"), { recursive: true });
    }
  }
  if (!(await exists(join(dir, ".env.local")))) {
    if (await exists(join(STANDALONE_DIR, ".env.local"))) {
      await copy(join(STANDALONE_DIR, ".env.local"), join(dir, ".env.local"));
    }
  }
  return dir;
}

export async function startServer(): Promise<void> {
  const cwd = await prepareWritableCwd();

  const env = loadEnvFile(join(cwd, ".env.local"));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  Deno.env.set("PORT", String(PORT));
  Deno.env.set("HOSTNAME", "localhost");

  Deno.chdir(cwd);
  console.error(`[Stow/Deno] cwd=${cwd}`);
  console.error(`[Stow/Deno] starting standalone server from ${STANDALONE_DIR}`);

  // Next.js standalone entrypoint; runs under Deno's Node compat layer.
  await import(join(STANDALONE_DIR, "server.js"));
}

export async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

if (import.meta.main) {
  await startServer();
  const ok = await waitForServer(BASE_URL, 15000);
  console.error(ok ? `[Stow/Deno] server ready at ${BASE_URL}` : "[Stow/Deno] server did not start");
}
```

**Known risk:** Next.js standalone `server.js` may serve `.next/static` relative to its own `__dirname` but read app data via `cwd` — exactly the split we want. If the server instead requires `cwd === STANDALONE_DIR` (symptom: 404 on static assets or "Could not find a production build"), fallback: `Deno.chdir(STANDALONE_DIR)` before the import and instead **symlink** `data` → app-data dir (`Deno.symlink(join(dir, "data"), join(STANDALONE_DIR, "data"))` after removing the bundled copy). Record whichever variant works in `docs/deno-vs-tauri.md`.

- [ ] **Step 2: Run the server standalone and verify it fails/succeeds honestly**

```bash
deno run -A src-deno/server.ts
```

Expected: `[Stow/Deno] server ready at http://localhost:3087`. In a second terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3087
curl -s -X POST http://localhost:3087/api/scan | head -c 200; echo
ls "$HOME/Library/Application Support/StowDashboardDeno/data/"
```

Expected: `200`; scan responds with JSON (not an error); `projects_metadata.jsonl` present in app-data dir and its mtime updates after the scan (proves the **write path** works outside the bundle). Stop the server with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add src-deno/server.ts
git commit -m "feat: deno shell server bootstrap (in-process Next standalone, port 3087, writable app-data cwd)"
```

---

### Task 4: main.ts + tray.ts — window and tray parity

**Files:**
- Create: `src-deno/main.ts`
- Create: `src-deno/tray.ts`

**Interfaces:**
- Consumes: `PORT`, `BASE_URL`, `startServer()`, `waitForServer()` from `src-deno/server.ts`; `src-deno/icons/tray.png` from Task 2.
- Produces: `setupTray(win: Deno.BrowserWindow, baseUrl: string): Promise<Deno.Tray>` in `tray.ts`; runnable app via `npm run deno:run`.

- [ ] **Step 1: Write `src-deno/tray.ts`**

Mirrors the Tauri tray (Show / Hide / Rescan / Quit + left-click toggle):

```ts
export async function setupTray(
  win: Deno.BrowserWindow,
  baseUrl: string,
): Promise<Deno.Tray> {
  const iconBytes = await Deno.readFile(new URL("./icons/tray.png", import.meta.url));

  const tray = new Deno.Tray();
  tray.setIcon(iconBytes);
  tray.setTooltip("Stow Dashboard (Deno)");
  tray.setMenu([
    { item: { label: "Show Dashboard", id: "show", enabled: true } },
    { item: { label: "Hide Dashboard", id: "hide", enabled: true } },
    { item: { label: "Rescan Projects", id: "rescan", enabled: true } },
    { item: { label: "Quit", id: "quit", enabled: true } },
  ]);

  tray.addEventListener("menuclick", (e) => {
    switch (e.detail.id) {
      case "show":
        win.show();
        win.focus();
        break;
      case "hide":
        win.hide();
        break;
      case "rescan":
        fetch(`${baseUrl}/api/scan`, { method: "POST" }).catch(() => {});
        break;
      case "quit":
        Deno.exit(0);
        break;
    }
  });

  tray.addEventListener("click", () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}
```

- [ ] **Step 2: Write `src-deno/main.ts`**

```ts
/**
 * Deno desktop shell entrypoint — parity with src-tauri/src/lib.rs:
 * start server -> wait for port -> window + tray, hide-on-close.
 */

import { BASE_URL, startServer, waitForServer } from "./server.ts";
import { setupTray } from "./tray.ts";

await startServer();

const ready = await waitForServer(BASE_URL, 15_000);
if (!ready) {
  console.error(`[Stow/Deno] server did not come up on ${BASE_URL} within 15s`);
  Deno.exit(1);
}

const win = new Deno.BrowserWindow({
  title: "Stow Dashboard (Deno)",
  width: 1400,
  height: 900,
});
win.navigate(BASE_URL);
win.show();
win.focus();

// Hide instead of closing when X is clicked (same as Tauri prevent_close).
win.addEventListener("close", (e) => {
  e.preventDefault();
  win.hide();
});

const tray = await setupTray(win, BASE_URL);
void tray; // keep alive for the app's lifetime
```

- [ ] **Step 3: Run and verify parity behaviors**

```bash
npm run deno:prepare   # refresh standalone if stale
npm run deno:run
```

Verify, in order:

1. Window opens at 1400×900 titled "Stow Dashboard (Deno)" showing the dashboard.
2. Tray icon appears; left-click toggles window visibility.
3. Tray → Hide Dashboard hides; Show Dashboard shows + focuses.
4. Closing the window (X) hides it instead of quitting; tray click brings it back.
5. Tray → Rescan Projects: `curl -s http://localhost:3087/api/scan` shows scan activity / table refreshes.
6. Tray → Quit: app exits AND `lsof -i :3087` shows nothing (in-process server dies with the process — no orphan check needed beyond this).

- [ ] **Step 4: Commit**

```bash
git add src-deno/main.ts src-deno/tray.ts
git commit -m "feat: deno desktop shell window + tray with Tauri parity"
```

---

### Task 5: Release build (.app) and side-by-side smoke test

**Files:**
- Modify: `docs/deno-vs-tauri.md` (bundle findings)

**Interfaces:**
- Consumes: `npm run deno:build` from Task 2, working app from Task 4.
- Produces: `dist/Stow Dashboard Deno.app` — measured in Task 6.

- [ ] **Step 1: Build the .app**

```bash
npm run deno:build
ls -la dist/
```

Expected: `dist/Stow Dashboard Deno.app` exists. If `--include` doesn't make `src-deno/standalone` reachable via `import.meta.url` paths inside the compiled binary (symptom: "module not found .../standalone/server.js" on launch), consult https://docs.deno.com/runtime/desktop/distribution/ for the VFS path convention and adjust `STANDALONE_DIR` in `server.ts` accordingly; record the fix in `docs/deno-vs-tauri.md`.

- [ ] **Step 2: Also produce a DMG (for size comparison with Tauri's DMG)**

```bash
deno desktop -A --include src-deno/standalone --include src-deno/icons -o "dist/Stow Dashboard Deno.dmg" src-deno/main.ts
ls -la dist/
```

Expected: `dist/Stow Dashboard Deno.dmg` (output format follows the extension). If DMG output isn't supported yet by the experimental CLI, note that in `docs/deno-vs-tauri.md` and compare .app sizes instead.

- [ ] **Step 3: Launch the bundle and re-run the parity checklist**

```bash
open "dist/Stow Dashboard Deno.app"
```

Re-verify Task 4 Step 3 items 1–6 against the compiled bundle, plus:

7. Scan from the bundled app updates `~/Library/Application Support/StowDashboardDeno/data/projects_metadata.jsonl` (writable-state design works compiled).
8. Quit and relaunch — data persists (no re-seed from bundle).

- [ ] **Step 4: Side-by-side run with Tauri**

With the Tauri app running (or `npm run tauri:dev` if no build installed) AND the Deno app running:

```bash
lsof -nP -i :3087 -i :3088 | grep LISTEN
```

Expected: two listeners, both dashboards usable simultaneously, no port fights.

- [ ] **Step 5: Commit**

```bash
git add docs/deno-vs-tauri.md
git commit -m "feat: deno desktop release build verified side-by-side with tauri"
```

---

### Task 6: Measurements → comparison doc

**Files:**
- Modify: `docs/deno-vs-tauri.md` (fill Measurements + DX notes)

**Interfaces:**
- Consumes: both built apps; the Tauri DMG can be rebuilt with `npm run tauri:build` if none exists.
- Produces: completed comparison tables — the ADR's evidence base.

- [ ] **Step 1: Measure bundle sizes**

```bash
du -sh "dist/Stow Dashboard Deno.app"
du -sh src-tauri/target/release/bundle/macos/*.app 2>/dev/null || echo "run: npm run tauri:build"
ls -la src-tauri/target/release/bundle/dmg/ 2>/dev/null
```

- [ ] **Step 2: Measure cold start**

For each app: quit it fully, then time from launch to dashboard interactive:

```bash
time (open "dist/Stow Dashboard Deno.app" && until curl -s -o /dev/null http://localhost:3087; do sleep 0.1; done)
time (open "/Applications/Stow Dashboard.app" && until curl -s -o /dev/null http://localhost:3088; do sleep 0.1; done)
```

(Adjust the Tauri .app path to wherever it's installed; server-ready is the proxy for "interactive", note any visible extra webview delay by hand.)

- [ ] **Step 3: Measure RAM (both apps running, dashboard open, after one scan)**

```bash
ps -eo rss,comm | grep -iE "stow|deno|node" | sort -rn
```

Sum shell + server processes per app; record MB in the table. Note the structural difference: Tauri = Rust shell + separate Node process; Deno = single process.

- [ ] **Step 4: Measure build time + count shell code**

```bash
time npm run deno:build
time npm run tauri:build   # skip if unchanged; note cached vs clean
wc -l src-deno/*.ts src-tauri/src/*.rs
```

- [ ] **Step 5: Write DX notes**

Fill `## DX notes` with observations from Tasks 1–5: language uniformity (TS vs Rust), toolchain (no Rust/Xcode needed?), error messages quality, docs maturity, experimental rough edges hit, cross-compile availability (`--target`), dev-loop options (`deno desktop --hmr .` vs our standalone-based `deno:run` — try `deno desktop --hmr .` once and note what it gives).

- [ ] **Step 6: Commit**

```bash
git add docs/deno-vs-tauri.md
git commit -m "docs: deno vs tauri measurements and DX notes"
```

---

### Task 7: ADR + project docs update

**Files:**
- Create: `docs/adr/0001-desktop-shell-deno-vs-tauri.md`
- Modify: `CLAUDE.md` (commands + architecture sections)
- Modify: `STATUS.md` (NEXT line)

**Interfaces:**
- Consumes: `docs/deno-vs-tauri.md` measurements (or spike NO-GO results if gated out at Task 1).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0001-desktop-shell-deno-vs-tauri.md`:

```markdown
# ADR 0001: Desktop shell — Tauri vs Deno Desktop

Date: <YYYY-MM-DD>
Status: Accepted

## Context

We ship the dashboard as a Tauri v2 app (Rust shell + system Node.js running
Next.js standalone, port 3088). Deno 2.9 introduced the experimental
`deno desktop` command; we built a parallel shell (`src-deno/`, port 3087)
with full parity to compare. Evidence: docs/deno-vs-tauri.md.

## Decision

<STAY ON TAURI | SWITCH TO DENO | WAIT — one sentence>

## Rationale

<3-6 bullets grounded in the measurements: bundle size, system-Node
dependency, single-language codebase, maturity/experimental risk, DX>

## Consequences

- <what we keep shipping / what gets removed or kept as experiment>
- <revisit trigger, e.g. "revisit when deno desktop leaves experimental">
```

Fill Decision/Rationale/Consequences from the actual measured results — do not pre-commit to an answer. If Task 1 gated NO-GO, Decision is WAIT and Rationale cites the exact spike failures.

- [ ] **Step 2: Update CLAUDE.md**

In the Commands section, after the Desktop App block, add:

```markdown
# Desktop App (Deno, experimental comparison shell — requires Deno >= 2.9)
npm run deno:prepare  # Build Next.js + assemble src-deno/standalone
npm run deno:run      # Run desktop shell from source
npm run deno:build    # Build dist/Stow Dashboard Deno.app
```

Update the Ports line to: `Dev uses 3089, Production/Tauri uses 3088, Deno shell uses 3087.`

After the "Tauri Desktop App" section, add:

```markdown
### Deno Desktop App (experimental)

A parallel shell built with `deno desktop` (Deno 2.9+) for comparison with Tauri:

- `src-deno/main.ts` - entrypoint (server start, window, hide-on-close)
- `src-deno/server.ts` - runs Next.js standalone in-process on port 3087; writable state in `~/Library/Application Support/StowDashboardDeno`
- `src-deno/tray.ts` - tray menu (Show/Hide/Rescan/Quit)
- Comparison: `docs/deno-vs-tauri.md`, decision: `docs/adr/0001-desktop-shell-deno-vs-tauri.md`
```

- [ ] **Step 3: Update STATUS.md NEXT line**

Set `NEXT:` to reflect the ADR outcome (e.g. "Deno desktop comparison DONE (ADR 0001: <decision>). Back to Command Center Phase 06 …" — preserve the existing Phase 06 items already listed there).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0001-desktop-shell-deno-vs-tauri.md CLAUDE.md STATUS.md
git commit -m "docs: ADR 0001 deno vs tauri decision + CLAUDE.md/STATUS updates"
```
