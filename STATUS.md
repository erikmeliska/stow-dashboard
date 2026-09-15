---
status: active
updated: 2026-09-15
---

NEXT: Session families + filters/grouping/sorting SHIPPED on /sessions (subagents table, parent_session_id/kind/entrypoint, timing-based link of security-guidance reviews — src/lib/cc/session-link.mjs, session-tree.mjs, session-filters.mjs; verified in the browser). Next: watch a fresh session for mis-linked reviews (two parallel sessions in one repo finishing turns in the same second). Follow-up idea: forked/resumed sessions sharing a started_at (e.g. 087c0dbd/045728fd) could join the same family. Older: /analytics SHIPPED (tabs: Agentic sessions + Project portfolio, recharts, /api/analytics, lib in src/lib/cc/analytics.mjs) and the desktop app renamed to plain "Stow Dashboard" (rebuilt + reinstalled). Next: CC observability phase 3 (sync layer, egress policy, central project_dir → project_key config, team server) per docs/superpowers/specs/2026-08-21-cc-observability-team-design.md §7. Follow-ups: TRI-STOW-0003 usage double-count fix (scope to usage.mjs). Older candidates: fáza 3 AI analýzy, usage follow-upy (formatTokens, usage_* SSE, worktree sessions → unmatched), scanner UTF-16 chip.

## Links
- http://localhost:3089 — dev server
- http://localhost:3088 — prod web / Tauri fallback (Deno app uses a runtime-assigned port)
- https://github.com/erikmeliska/stow-dashboard — repo
- docs/superpowers/plans/2026-06-16-command-center-index.md — Command Center plan set

## Notes
Phase 01 (MCP foundation) shipped to main at 7fc053f: status/scripts/processes libs + 4 MCP tools + scc. Running MCP server must be reconnected to expose the new tools.
