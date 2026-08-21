---
status: active
updated: 2026-08-21
---

NEXT: CC observability phase 1b SHIPPED on branch cc-observability (node:sqlite session store + `npm run cc:ingest` + /sessions viewer; plan docs/superpowers/plans/2026-08-21-stow-session-ingest.md). Next: merge cc-observability → main, then phase 2 (AI summaries, quality score, git/Jira work-context) per docs/superpowers/specs/2026-08-21-cc-observability-team-design.md; follow-ups: incremental ingest (size/mtime skip), wire cc:ingest into the refresh cycle, guard_hits for sessions without a transcript yet. Older candidates: fáza 3 AI analýzy, usage follow-upy (formatTokens, usage_* SSE, worktree sessions → unmatched), scanner UTF-16 chip.

## Links
- http://localhost:3089 — dev server
- http://localhost:3088 — prod web / Tauri fallback (Deno app uses a runtime-assigned port)
- https://github.com/erikmeliska/stow-dashboard — repo
- docs/superpowers/plans/2026-06-16-command-center-index.md — Command Center plan set

## Notes
Phase 01 (MCP foundation) shipped to main at 7fc053f: status/scripts/processes libs + 4 MCP tools + scc. Running MCP server must be reconnected to expose the new tools.
