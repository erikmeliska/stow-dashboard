# ADR 0002: Switch the desktop shell to Deno Desktop

Date: 2026-07-05
Status: Accepted
Supersedes: ADR 0001

## Context

ADR 0001 (Proposed) recommended staying on Tauri based on the measured
comparison in docs/deno-vs-tauri.md. Before ratification, the owner ran the
human smoke test it required. The test surfaced three real bugs in the Deno
shell — tray left-click crashed the app, red-X close quit the app instead of
hiding, and the tray icon rendered monochrome. All three were root-caused
(see docs/deno-vs-tauri.md, Task 4 findings):

- `win.hide()` on the app's only window makes the Deno 2.9.1 runtime exit —
  fixed by parking the window off-screen instead (restores position on Show).
- The tray left-click toggle was removed: a menu-bearing macOS status item
  opens its menu on click anyway, and the toggle's `hide()` was the crash path.
- The monochrome icon is a platform limitation: `Deno.Tray` has no
  `icon_as_template(false)` equivalent, so macOS template-renders the icon.
  Not fixable today.

With the fixes in place the owner re-tested the app by hand (click, menu
actions, hide-on-close) and everything passed. The owner then chose to
replace the Tauri app with the Deno app as the daily driver.

## Decision

Switch the shipped desktop app to the Deno shell (`npm run deno:build` →
`dist/Stow Dashboard Deno.app`, installed in /Applications). Keep the Tauri
shell (`src-tauri/`) in the repo, buildable, as a fallback.

## Rationale

- This is a single-user internal tool: the 525MB-vs-95MB disk-size gap that
  drove ADR 0001's recommendation matters little on one machine, while the
  DX gains are felt on every change — 11.82s vs 69.21s clean builds, one
  language (TypeScript) for shell and app, no Rust/Xcode toolchain.
- No system Node.js dependency at runtime: the Tauri shell silently depends
  on a Homebrew/system `node` at launch (`find_node()` fallback chain); the
  Deno shell embeds its runtime.
- Runtime characteristics are comparable (cold start ~0.45s both; RAM
  361.7MB vs 267.6MB, single-sample).
- The previously unverified tray-crash risk is now understood, fixed, and
  verified by a human test — the main blocker in ADR 0001's consequences.

## Accepted trade-offs

- 525MB on disk (compiler sweeps the repo's full `node_modules`; proven not
  trivially excludable — see docs/deno-vs-tauri.md follow-up experiment).
- Monochrome (template) tray icon until Deno exposes a non-template option.
- Runtime-assigned port in the compiled app (handled by `getActualBaseUrl()`;
  nothing external depended on the fixed port 3088 anyway — the MCP server
  and CLI read the JSONL directly).
- "Hide" is an off-screen park, so the hidden window stays in the window list
  (e.g. Mission Control) and keeps its webview alive.
- `deno desktop` is experimental: a Deno upgrade may break the shell.

## Consequences

- /Applications carries "Stow Dashboard Deno"; the Tauri .app is removed from
  /Applications (recoverable anytime: `npm run tauri:build`, or the existing
  DMG in `src-tauri/target/release/bundle/dmg/`).
- Release path for the desktop app is `npm run deno:build` + copy to
  /Applications. `npm run tauri:build` remains the fallback path.
- Fallback trigger: if a Deno upgrade breaks the shell and the fix isn't
  quick, rebuild and reinstall the Tauri app, and record the breakage in
  docs/deno-vs-tauri.md.
- Revisit the icon and port limitations when `deno desktop` leaves
  experimental status.
