# Deno Desktop Shell — Design

**Date:** 2026-07-04
**Status:** Approved
**Goal:** Build a Deno-based desktop shell (`deno desktop`, Deno 2.9+) alongside the existing Tauri shell, with full feature parity, to produce a grounded Tauri-vs-Deno comparison and an ADR recommendation.

## Context

The existing desktop app is **Tauri v2** (`src-tauri/`): a ~330-line Rust shell that

1. locates the **system Node.js** (`find_node()` with hardcoded path fallbacks),
2. spawns the Next.js standalone server (`.next/standalone/server.js`) on port **3088** with env from `.env.local`,
3. waits for the port, opens a webview window pointing at `http://localhost:3088`,
4. manages a tray icon (Show / Hide / Rescan / Quit), hide-on-close, and kills the server process group on exit.

Weaknesses: hard dependency on system Node, Rust toolchain required to build, window/tray logic in a second language.

**Deno 2.9** (released 2026-06-25) introduced the experimental `deno desktop` command: compiles a web project into a self-contained desktop binary with the Deno runtime bundled (no system Node needed), OS-native webview backend (~40–70 MB) or optional CEF (~310 MB), `Deno.BrowserWindow`, tray/menu/notification APIs, in-process webview↔Deno bindings, Next.js auto-detection, `--hmr` dev mode, and cross-compilation. Config lives in a `desktop` block in `deno.json`.

References:

- https://docs.deno.com/runtime/desktop/
- https://docs.deno.com/runtime/reference/cli/desktop/
- https://deno.com/blog/v2.9

## Decisions (user-confirmed)

- **Scope:** full parity with the Tauri shell (tray menu, hide-on-close, rescan, server lifecycle, .app/.dmg build).
- **Location:** this repo — `src-deno/` as a sibling of `src-tauri/`. Both shells share the same Next.js app; the comparison is shell-vs-shell.
- **Deliverables:** working build + comparison document (`docs/deno-vs-tauri.md`) + ADR with a recommendation (stay on Tauri / switch / wait).
- **Port:** Deno shell uses **3087** (Tauri prod 3088, dev 3089) so all can run simultaneously.
- Tauri stays untouched.

## Approach

Two phases:

**Phase 0 — Spike (gate).** Run plain `deno desktop` auto-detection against the Next.js project root. Purpose: verify Next.js 16 runs under Deno's Node compat at all, and exercise the risky server-side APIs. If the spike fails fundamentally, stop; the ADR becomes "wait for the feature to mature" with a precise account of what broke — still a valuable outcome.

**Phase 1 — Full shell.** Custom entrypoint mirroring `src-tauri/src/lib.rs` behavior in TypeScript.

Rejected alternatives: pure auto-detect as the final product (no tray/lifecycle control), and a Deno-native rewrite with Fresh (compares apps, not shells; out of scope).

## Architecture

```
src-deno/
  main.ts          # entrypoint: start server → wait for port → create BrowserWindow + tray
  server.ts        # spawn/run .next/standalone server on port 3087, env from .env.local, wait_for_server
  tray.ts          # tray icon + menu: Show Dashboard / Hide Dashboard / Rescan Projects / Quit
  deno.json        # desktop config block: productName, identifier, icons, output, backend: webview
scripts/prepare-deno.mjs   # analog of prepare-tauri.mjs: assemble standalone + static assets + data/ + .env.local
```

Behavior parity map (vs `lib.rs`):

| Tauri (Rust)                          | Deno shell                                    |
| ------------------------------------- | --------------------------------------------- |
| `find_node()` + spawn system Node     | not needed — bundled Deno runtime runs server via Node compat |
| `wait_for_server` TCP poll            | same, TCP/fetch poll in `server.ts`           |
| webview window → localhost:3088       | `Deno.BrowserWindow` → localhost:3087         |
| tray menu Show/Hide/Rescan/Quit       | same via Deno tray API                        |
| hide-on-close (`prevent_close`)       | same via window close event                   |
| rescan via `curl POST /api/scan`      | `fetch()` POST                                |
| kill process group on exit            | terminate in-process server / child on exit   |

npm scripts to add: `deno:dev` (HMR dev), `deno:build` (build → prepare → `deno desktop -o`). Icons reused from `src-tauri/icons/`.

**Note:** exact `Deno.BrowserWindow` / tray / bindings signatures come from summarized docs; the first implementation step is reading the full Desktop docs sections (backends, bindings, distribution) and adjusting details. The architecture above is the contract; API specifics may shift.

## Compatibility checklist (spike output)

Server-side code relies on Node APIs that must work under Deno Node compat. Each gets a works/fails entry in the comparison doc:

- `child_process`: `lsof` (process detection), `docker ps`/ops, `scc` (code stats), `nohup` script runner
- `simple-git` (live git status)
- fs: JSONL read, log capture in `/tmp/stow-scripts/`
- Next.js 16 standalone server itself (Turbopack build output)
- env loading (`.env.local`), `data/projects_metadata.jsonl` path resolution inside the bundle

## Comparison document + ADR

`docs/deno-vs-tauri.md` measures, for both shells: bundle size (.app/.dmg), cold start to window, RAM (shell + server processes), dev-loop DX, build time, Node API compatibility, runtime dependencies (system Node vs none).

ADR (in `docs/adr/`): recommendation among **stay on Tauri / switch to Deno / wait**, grounded in the measurements.

## Risks

- `deno desktop` is experimental and ~10 days old; breakage expected. Mitigated by the Phase-0 gate.
- Deno must be upgraded 2.8.3 → 2.9+ locally (Homebrew install → `brew upgrade deno`).
- Docs details unverified against real API surface — first implementation task is a full docs read.

## Testing

- Spike checklist above, executed manually against the running Deno app.
- Parity smoke test: both apps running side by side (3087 + 3088), verifying tray actions, hide-on-close, rescan, process kill on quit (no orphaned server after Quit).
- No automated test framework exists in the repo; this stays manual, recorded in the comparison doc.
