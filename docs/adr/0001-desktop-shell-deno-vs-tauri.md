# ADR 0001: Desktop shell — Tauri vs Deno Desktop

Date: 2026-07-05
Status: Proposed

## Context

We ship the dashboard as a Tauri v2 app (Rust shell + system Node.js running
Next.js standalone, port 3088). Deno 2.9 introduced the experimental
`deno desktop` command; we built a parallel shell (`src-deno/`, port 3087 for
source runs, runtime-assigned port for the compiled app via
`DENO_SERVE_ADDRESS`) with full parity to compare. Evidence: docs/deno-vs-tauri.md.

## Decision

Stay on Tauri for the shipped desktop app; keep the Deno shell in the repo as
a documented, non-shipping experiment and revisit once `deno desktop` leaves
experimental status and the bundle-size gap is resolved.

## Rationale

- **Shipping size is not close.** Tauri produces a 95MB `.app` / 28.99MB DMG;
  Deno produces a 525MB `.app` / 176.8MB DMG — roughly 5.5x and 6x larger
  respectively. The gap is mechanistically explained (not noise): `deno
  compile`'s dependency scanner sweeps in the repo's full top-level
  `node_modules` (433MB of the 457.99MB embedded total), and a follow-up
  attempt to `--exclude node_modules` shrank the bundle to 146MB but broke
  `POST /api/scan` with a missing-module 500 error, so the bloat is not
  trivially removable today.
- **Tauri is mature; Deno required three non-default workarounds to reach
  parity.** Shipping the Deno shell meant discovering and fixing, one at a
  time: missing `-A` (env-read crash on first `process.env` access inside
  Next internals), missing `--unstable-detect-cjs` (standalone `server.js`
  isn't recognized as CommonJS), and a read-only compiled-app VFS that broke
  the original `Deno.chdir`-based writable-data design (fixed with a
  `process.chdir` no-op monkeypatch) plus an undocumented port-interception
  bug (`DENO_SERVE_ADDRESS` silently overriding the requested port, requiring
  a `getActualBaseUrl()` workaround). `deno desktop` itself is roughly 10
  days old as a feature at time of writing.
- **Deno wins clearly on developer experience.** Single-language shell (280
  lines TypeScript vs. 336 lines Rust) sharing a language with the app it
  hosts, no Rust/Cargo/Xcode-CLI-toolchain requirement, no system Node.js
  dependency at runtime (V8 + Deno statically embedded), and a much faster
  clean build (11.82s vs. 69.21s wall time). If we only weighed contributor
  ergonomics, Deno would win outright.
- **Runtime characteristics are close enough not to be the deciding factor.**
  Cold start is effectively tied (~0.45-0.48s Deno vs. ~0.41-0.47s Tauri) and
  RAM is a moderate, not disqualifying, gap (361.7MB Deno vs. 267.6MB Tauri,
  both single-sample measurements).
- **A real functional risk remains unverified.** Every attempt to interact
  with the Deno tray icon via macOS Accessibility crashed the app silently
  within ~1s (reproduced 2/2), with the tray icon also not visually
  confirmed in menu-bar screenshots — likely a synthetic-click artifact of
  an experimental API, but as shipped this is unproven, and tray/menu is a
  primary interaction surface for a system-tray desktop app.
- **Stable vs. runtime-assigned port matters operationally.** Tauri binds
  the fixed port 3088 we configure; the compiled Deno app ignores the
  requested port and rebinds to whatever `DENO_SERVE_ADDRESS` assigns at
  launch, which the shell code has to detect and route around — a fragility
  we don't need to accept for a production shipping artifact today.

## Consequences

- We keep shipping the Tauri `.app`/DMG as the only desktop artifact
  distributed to users; `npm run tauri:build` remains the release path.
- `src-deno/` and its `npm run deno:*` scripts stay in the repo as a working,
  documented comparison shell — not wired into any release or CI publish
  step — so the DX and measurement work isn't lost and re-running the
  comparison later is cheap.
- Before shipping Deno, the following must change: (1) the `.app` bundle size
  gap closed or accepted, (2) `deno desktop` graduates out of experimental
  status with a stable, documented port-binding contract, and (3) the tray
  crash is either explained as a synthetic-input artifact (via a real human
  click test) or fixed upstream.
- Revisit trigger: re-run this comparison when a new Deno release ships
  `deno desktop` as stable (non-experimental), or when someone finds a
  supported way to exclude the repo's top-level `node_modules` from the
  compiled bundle without breaking API routes — whichever comes first.
