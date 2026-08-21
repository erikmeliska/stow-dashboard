---
status: active
updated: 2026-08-21
---

NEXT: CC observability phase 2 SHIPPED on branch cc-phase2 (work context + tool-agnostic ticket id, quality score v1, on-demand claude -p summaries, richer /sessions; plan docs/superpowers/plans/2026-08-21-cc-phase2-eval-context.md). Next: merge cc-phase2 → main; then phase 3 (sync layer, egress policy, central project_dir → project_key config, team server) per docs/superpowers/specs/2026-08-21-cc-observability-team-design.md §7. Follow-ups: incremental ingest (size/mtime skip), wire cc:ingest into the refresh cycle, ticket/quality filters in the sessions table. Older candidates: fáza 3 AI analýzy, usage follow-upy (formatTokens, usage_* SSE, worktree sessions → unmatched), scanner UTF-16 chip.

## Links
- http://localhost:3089 — dev server
- http://localhost:3088 — prod web / Tauri fallback (Deno app uses a runtime-assigned port)
- https://github.com/erikmeliska/stow-dashboard — repo
- docs/superpowers/plans/2026-06-16-command-center-index.md — Command Center plan set

## Notes
Phase 01 (MCP foundation) shipped to main at 7fc053f: status/scripts/processes libs + 4 MCP tools + scc. Running MCP server must be reconnected to expose the new tools.
