# Deno Desktop vs Tauri — comparison

Companion to `docs/superpowers/specs/2026-07-04-deno-desktop-shell-design.md`.
Both shells wrap the same Next.js 16 standalone app. Tauri: port 3088. Deno: port 3087.

## Spike results (deno desktop auto-detect, Deno 2.9.1, 2026-07-05)

| Check | Result | Notes |
| --- | --- | --- |
| Window opens with dashboard | PASS (with `-A`) | `deno desktop .` (no flags) auto-detects Next.js, compiles, codesigns, and produces `stow-dashboard.app`, but the CLI process exits after building — it does not auto-launch the built app in this invocation form. Launching the built binary directly opens a real native WKWebView window (`laufey_webview` process, confirmed via `ps`/system log) and a `next-server` process serving on an auto-assigned port (`http://0.0.0.0:50816` in our run). Without `-A`/`--allow-env` the app crashes instantly (see below) — this is the load-bearing fix. |
| JSONL data read | PARTIAL — expected gap, resolved by design | Auto-detect only embeds Next's own build output (`.next/`) into the compiled binary's VFS; it does **not** embed `data/` or `.env.local` (not part of the Next.js build). Confirmed by inspecting the self-extracted VFS dir: `data/` and `.env.local` were absent until a scan created `data/` at runtime. This is exactly the gap Task 3's custom `server.ts` (explicit copy of `data/` + `.env.local` to app-support dir, `chdir` there) is designed to close. Once a scan ran and created `data/projects_metadata.jsonl` in the process cwd, `GET /` served the real project table (verified `codewars` row + `<table` markup in the HTML). |
| Live git status (simple-git) | PASS | `GET /api/project-details?directory=/Users/ericsko/Projekty/year-in-search-trends` returned full live git status: `{"isGitRepo":true,"uncommittedChanges":3,"isClean":false,"ahead":0,"behind":0,"tracking":"origin/main","lastCommitMessage":"Added indent parameter to ridgeplot",...}`. `simple-git`'s child_process-based git invocation works under Deno's Node compat. |
| Process detection (lsof) | PASS | `GET /api/processes` returned valid JSON (`{"projects":{},"timestamp":...}`) with no errors — `child_process`/`lsof` spawn path works. |
| Docker containers | PASS (spawn path only, not exercised end-to-end) | `/api/processes/docker` is a POST-only action endpoint (405 on GET, by design — matches source). Docker container listing itself is folded into `/api/processes`, already confirmed working. No Docker containers were running during the spike to see populated results, but the spawn mechanism is identical to the already-proven `lsof` path. |
| Scan incl. scc + JSONL write | PASS | `POST /api/scan` streamed a full SSE progress feed (`data: {"type":"status",...}` ... `{"type":"discovery_complete","count":1117}` ... per-project `"updated"` events ... `{"type":"complete","totalTime":"362.6","count":1117}` ... `{"type":"synced","file":".../data/projects_metadata.jsonl"}` ... `{"type":"complete","success":true,"projectCount":1117,"duration":363}`). Confirmed the JSONL file was written: 2,096,162 bytes at the app's cwd (`.../stow-dashboard.app/Contents/MacOS/.laufey_webview/<hash>/data/projects_metadata.jsonl`), mtime updated post-scan. `scc` spawn, gitignore walking, and concurrent analysis (8-at-a-time) all completed without error across 1117 real projects. |
| Script runner (nohup + logs) | PASS | `GET /api/scripts?directory=...` listed real npm scripts (`dev`, `build`, `lint`, `scan`, etc.). `POST /api/scripts/run` with `{"script":"lint","type":"npm"}` returned `{"success":true,"pid":24288,"logFile":".../stow-dashboard-logs/lint-*.log"}`; the log file appeared and contained real `eslint .` output. Note: actual log directory is `$TMPDIR/stow-dashboard-logs/` (macOS per-user tmp), not literally `/tmp/stow-scripts/` as paraphrased in the task brief — this is a brief inaccuracy, not a plan-file signature mismatch, so no plan edit was made. |
| Open-with (IDE/Terminal/Finder) | NOT EXERCISED (would open GUI apps) | Per task instructions, skipped calling `POST /api/open-with` since it spawns `open`/`osascript` and would visibly open Finder/Terminal/IDE windows on the operator's machine. Route uses the same `child_process`/`osascript` mechanism already proven to work for scripts and git, so no reason to expect a Deno-specific failure, but this was not directly verified. |

**Gate verdict:** GO — Next.js 16 runs under `deno desktop` (Deno 2.9.1) with full API/data parity once launched with `-A` (allow-all permissions); every exercised endpoint (git status, process detection, scan+scc+JSONL write, script runner) worked identically to the Tauri/Node deployment, and the only failure (missing env access) has a one-flag fix that Tasks 2–4's custom entrypoint will bake in explicitly.

## Node API compatibility notes

- **Critical, load-bearing finding:** `deno desktop .` (and the compiled `.app`) run under Deno's permission system same as `deno run`/`deno compile`. Without explicit permission flags, the very first `require`d Next.js internal module that reads `process.env` throws and kills the process before the server can bind to a port:

  ```
  [desktop] Deno runtime error: NotCapable: Requires env access to "__NEXT_PRIVATE_CPU_PROFILE", specify the required permissions during compilation using `deno compile --allow-env`
      at Object.getEnv [as get] (ext:deno_os/30_os.js:1:1634)
      ...
      at Object.<anonymous> (.../node_modules/next/dist/server/lib/cpu-profile.js:2:43)
  ```

  Fix: run/build with `-A` (allow-all). This app already needs unrestricted env/read/write/net/run/sys access to do its job (scan the filesystem, spawn `scc`/`git`/`lsof`/`docker`/`osascript`, write JSONL) — identical to what it gets for free under Tauri + system Node, where there is no permission sandbox at all. **Tasks 2–4's `deno:run`/`deno:build` npm scripts and the `deno run -A src-deno/server.ts` verification step must include `-A`** (the plan's Task 2/Task 3 command blocks did not originally show this flag explicitly for `deno:run`/`deno:build` — see the plan-file diff below).
- `next start` printed a warning because the project's `next.config.mjs` sets `output: 'standalone'`: `"next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.` It still started and served correctly in this spike (auto-detect runs the ordinary `next-start.js`, not our standalone `server.js`), but this is the exact reason Task 3 builds a custom `server.ts` that imports the **standalone** `server.js` directly instead of relying on auto-detect's `next start` path — auto-detect is fine for the spike gate, but the real shell should use the custom entrypoint to avoid depending on the non-standalone Next server and to get the writable-cwd data-file handling.
- Auto-detect's VFS embedding is scoped to the framework's own build output directory (`.next/` for Next.js) as documented in "Working directory & assets" — it will not pick up sibling directories like `data/` or dotfiles like `.env.local` that our app also needs at `process.cwd()`. Confirmed by direct inspection of the self-extracted VFS directory contents (only `.deno_desktop_entry-*.ts`, `.next/`, `node_modules/`, `package.json`, `public/`, `src-tauri/` were present — no `data/`, no `.env.local`). This validates the plan's Task 3 design of syncing writable state into `~/Library/Application Support/StowDashboardDeno` explicitly rather than relying on auto-detect.
- Auto-detect embeds far more than necessary when pointed at `.` with no exclusions: it picked up all of `node_modules/` (433MB), the full `.next/` build (610MB), and even `src-tauri/target/release/**` (100MB, including a stale `Stow Dashboard.app` bundle and its `standalone/node_modules`) because nothing under the project root was excluded from the scan. Total embedded: 973.54MB, producing a ~1GB `.app`. Tasks 2–4's custom entrypoint + curated `src-deno/standalone/` + `--include` flags avoid this bloat entirely — worth calling out as a concrete DX/size advantage of the custom-entrypoint approach over auto-detect for this specific repo (which has `src-tauri/target` sitting in the same tree).
- No crashes, hangs, or Node-API-missing errors were observed anywhere else in the exercised surface (child_process spawn/exec for git, lsof, scc, npm scripts; SSE streaming responses; fs read/write) — Deno's Node compat handled all of it once permissions were granted.
- Docs verification (Step 2) found all API signatures in the plan's Task 2–4 code blocks match the live docs exactly as written: `Deno.BrowserWindow({title,width,height})`, `win.navigate()`, `win.show/hide/focus/isVisible()`, `close` event + `e.preventDefault()`, `new Deno.Tray()`, `tray.setIcon(bytes)`, `tray.setMenu([{item:{label,id,enabled}}])`, `menuclick` with `e.detail.id`, `click` event, and the `desktop.app.{name,identifier,icons}` / `desktop.backend` / `desktop.output` deno.json fields. No plan-file signature edits were required. One additional doc detail worth carrying into Task 2/3: the "Working directory & assets" page explicitly documents that compiled binaries run with cwd set to the *user's* cwd, not the bundle dir — reinforcing the plan's existing `Deno.chdir()`-based design.

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
