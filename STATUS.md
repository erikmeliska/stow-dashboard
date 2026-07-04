---
status: active
updated: 2026-07-05
---

NEXT: Deno desktop comparison DONE (ADR 0001: stay on Tauri for shipping, keep Deno shell as a documented experiment — see docs/adr/0001-desktop-shell-deno-vs-tauri.md). Immediate remaining item: 60-second human smoke test of the Deno app tray (tray icon click-toggle, menu Show/Hide/Rescan/Quit, hide-on-close via red X — `dist/Stow Dashboard Deno.app`), since synthetic clicks crashed it 2/2 in automated testing. After that: remaining Command Center work — Phase 06 (browser tab triage [needs live browser], Obsidian Command Center mirror `stow mirror` [buildable], Cowork Dispatcher pattern), and the DEFERRED Phase-02 Task E (Innovis vendored rollout — needs your strategy choice). Triage bridge DONE (stow task add CLI + Raycast Triage Intake; _Sandbox excluded). User actions: reconnect stow MCP; `npm run dev` Raycast + set `intakeFile` pref + subscribe phone to ntfy.ixy.sk/claude.

## Links
- http://localhost:3089 — dev server
- http://localhost:3088 — prod/Tauri
- https://github.com/erikmeliska/stow-dashboard — repo
- docs/superpowers/plans/2026-06-16-command-center-index.md — Command Center plan set

## Notes
Phase 01 (MCP foundation) shipped to main at 7fc053f: status/scripts/processes libs + 4 MCP tools + scc. Running MCP server must be reconnected to expose the new tools.
