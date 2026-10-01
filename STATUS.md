---
status: active
updated: 2026-10-01
---

NEXT: F5 — .ics export of the session calendar + period report via MCP `list_sessions` (spec docs/superpowers/specs/2026-09-30-session-calendar-design.md).

## Links
- http://localhost:3089 — dev server
- http://localhost:3088 — prod web / Tauri fallback (Deno app uses a runtime-assigned port)
- https://github.com/erikmeliska/stow-dashboard — repo
- docs/superpowers/plans/2026-09-30-session-calendar.md — last shipped plan
- docs/superpowers/plans/2026-06-16-command-center-index.md — Command Center plan set

## Notes
- 2026-09-30 SHIPPED to main + pushed + desktop app rebuilt/reinstalled: Codex ingest, summary v2, cross-process batch summaries (API/CLI/MCP), week/month session calendar with fill-in banner. PoC import done (216 written).
- 2026-09-30 SHIPPED (pushed + app rebuilt): switchable "Color by" (outcome default, project, harness, kind, cost, quality) with a counted legend, shared by the calendar and the table. Candidate extra modes: model, has subagents/security review, ticket yes/no.
- 2026-10-01 SHIPPED (pushed + app rebuilt/reinstalled): summary harness choice in Settings — `CC_SUMMARY_HARNESS` claude|codex + single/batch model (empty = harness default). Codex via `codex exec --ephemeral --ignore-user-config`. Gemini CLI not added (headless auth fails here). MCP server picks the setting up only on restart.
- Open decision: LLM `kind_hint` has no `scheduled` value, so a summarised automated run can drop out of the default calendar as `agent-spawn`. Consider adding it.
- Small follow-ups: week header vs classic scrollbar width; banner shows failure counts only; ESLint config lacks browser globals (~6300 pre-existing lint errors).
- Backlog: CC observability phase 3 (sync layer, team server — spec 2026-08-21 §7); TRI-STOW-0003 usage double-count (scope usage.mjs); watch for mis-linked security reviews (two parallel sessions in one repo); forked sessions sharing started_at could join one family.
- MCP servers started before a merge must be reconnected to expose new tools.
