# AI Usage & Cost per Project — Design

**Date:** 2026-07-10
**Status:** Approved
**Goal:** Show per-project AI token consumption and estimated list-price cost (Claude Code + Codex CLI) in the dashboard — a sortable "AI $" table column and a detailed breakdown in the project details sheet — updated incrementally as part of the existing refresh cycle.

## Context

The extraction method is proven by `~/Projekty/_tools/session-usage/usage_report.py` (see its HANDOVER.md):

| Tool | Location | Token source |
|---|---|---|
| Claude Code | `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl` | `type=="assistant"` lines → `message.usage.{input_tokens, output_tokens, cache_read_input_tokens}` + `cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}` (fallback `cache_creation_input_tokens` → treat as 5m) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `payload.type=="token_count"` → `info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens}` — CUMULATIVE per session, take the LAST occurrence |

**Project mapping (improvement over the reference script):** do not reverse-engineer escaped directory names (ambiguous with dashes). Instead read the real `cwd`:
- Codex: first line is `session_meta` with exact `payload.cwd`.
- Claude: scan lines until one carries a top-level `cwd` key (assistant/user lines have it; some operation lines don't).
- Map `cwd` → the DEEPEST project whose `directory` is a prefix of it (nested projects get their own usage, not the parent's). Sessions with no matching project are counted into an `unmatched` bucket (reported in totals, not shown per project).

**Interpretation caveats (must be visible in the UI):** prices are list-price equivalents ("hodnota spotreby"), not an invoice — on Max/subscription the real bill is flat. Codex rates for gpt-5.x-codex variants are UNVERIFIED (GPT-5-tier estimate) — mark with ⚠️. Codex cumulative totals may slightly overcount resumed sessions.

## Decisions (user-confirmed)

- "AI $" column visible by default; sortable.
- Usage update runs with EVERY quick refresh (manual Refresh and 60s Auto) — viable because the update is incremental (~ms when nothing changed).
- Costs shown per project; details sheet breaks down by tool (Claude/Codex) and Claude model.

## Architecture

```
~/.claude/projects/**/*.jsonl  ─┐   (append-only transcripts)
~/.codex/sessions/**/*.jsonl   ─┤
                                 ▼
              src/lib/usage.mjs — incremental extractor
        data/usage-cache.json (per-file: offset + partial sums)
                                 ▼
              data/usage.json (per project-directory aggregate)
                                 ▼
   page.js joins into records → table column + details sheet section
```

Key property: **session transcripts are append-only.** The cache stores per file `{ size, mtimeMs, byteOffset, cwd, sums }`; an update stats every file, fully skips unchanged ones, and re-parses only the appended tail (`fs.createReadStream(start: byteOffset)` / read+slice). If a file SHRANK (rotated/rewritten), re-parse from zero. First run parses everything once; steady-state updates touch only the handful of sessions active since the last cycle.

## Components

- **`src/lib/usage-pricing.mjs`** — price tables as data: `CLAUDE_PRICE` (per-MTok in/out per model id, cache multipliers 0.1×/1.25×/2× for read/5m-write/1h-write) and `CODEX_PRICE` (GPT-5-tier in/cached-in/out + `verified: false` flag) — values copied from `usage_report.py`. `costForClaude(model, sums)`, `costForCodex(sums)` pure functions; unknown Claude models → cost `null` (counted in tokens, flagged "unpriced" — never silently $0).
- **`src/lib/usage.mjs`** — the extractor:
  - `updateUsage({ claudeDir, codexDir, cacheFile, outFile, projectDirs })` → parses changed files, updates cache, aggregates, atomically writes `usage.json` (temp+rename), returns `{ filesParsed, filesSkipped, durationMs }`.
  - Per-session extraction: Claude — sum usage per model across appended assistant lines; Codex — last cumulative `total_token_usage` (tail re-parse must handle this: the cache keeps the last-seen cumulative, a newer one REPLACES it, no summing).
  - Active-time: sum of gaps < 5 min between event timestamps (same heuristic as the reference script), maintained incrementally (store last timestamp per file).
  - Aggregation: session cwd → deepest matching project directory from `projectDirs` (sorted by length desc). Output per project: `{ sessions, activeMinutes, tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, codexInput, codexCachedInput, codexOutput }, costUsd, costUnverifiedUsd, byModel: { <model>: {tokens…, costUsd} }, lastActivity, sessionList: [ { file, tool: 'claude'|'codex', model?, startedAt, lastActivity, activeMinutes, costUsd, tokensIn, tokensOut } ] }` — `costUsd` = priced Claude models; `costUnverifiedUsd` = Codex estimate (kept separate so the UI can mark it ⚠️). `sessionList` is sorted by `lastActivity` desc (full list — corpus is ~150 sessions total, no cap needed; revisit if it ever grows past ~50/project).
  - **Direction of traversal (explicit):** the updater iterates the SESSION STORES only — it never probes projects. Projects are merely the join target of each session's `cwd`; a project with no sessions simply has no entry.
- **`data/usage-cache.json` + `data/usage.json`** — both gitignored (user data), both atomic writes. Deliberately SEPARATE from `data/projects_metadata.jsonl`: no interaction with scan/analyze write paths, no merge discipline needed, scanner untouched.
- **Integration — quick refresh:** `src/app/api/scan/quick/route.js` calls `updateUsage(...)` at the end of its cycle (after processes/git work; failures logged as an SSE event, never fatal). The full-scan route does the same. A `⋯ menu → Rebuild AI usage` entry POSTs `{ rebuildUsage: true }` → cache file deleted → full re-parse (recovery path).
- **Join at render:** `page.js` reads `data/usage.json` (readFile, `{}` on absence) and attaches `usage` to each record during the existing enrichment spread. Records without usage → no key (UI shows `—`).
- **UI:**
  - Table column `ai_cost` (visible by default, sortable desc-first): `$12.4` formatted (`<$0.01` → `<1¢`, absent → `—`); tooltip shows tokens + hours. Codex-only projects show the value with a `~` prefix (unverified).
  - Details sheet section **AI Usage** (detailed breakdown): summary row (sessions count, active hours, total cost); per-tool subtotals — Claude (with per-model rows: tokens in/out/cacheR/cacheW + cost) and Codex (⚠️ estimate); token breakdown; and a **recent sessions list** (from `sessionList`: date as TimeAgo, tool badge, duration, cost — most recent first, collapsible beyond the first 5) — plus the list-price disclaimer line ("hodnota spotreby, nie faktúra").
  - Search/facets unchanged (YAGNI).

## Error handling

- Missing `~/.claude/projects` or `~/.codex/sessions` → skip that source silently (machine without the tool).
- Unparseable JSONL lines → skip line (reference script behavior).
- A session file with no detectable cwd → `unmatched` bucket.
- Corrupt cache file → treated as absent (full re-parse), warning logged.
- `updateUsage` never throws out of the refresh cycle — catch, log, emit `usage_error` SSE event, continue.

## Performance

- First run: one full parse of ~120+ Claude sessions + ~30 Codex rollouts (some files are tens of MB — stream, don't readFile whole). Expected seconds to low tens of seconds; runs inside the refresh SSE like other phases.
- Steady state: stat() all files (~150 stats, ms) + tail-parse only grown files. Target < 200 ms when idle.
- `usage.json` size: ~1 entry per project with sessions (~dozens) — trivial.

## Testing

- Pricing: pure-function tests (known token counts → exact dollars; unknown model → null).
- Extractor: temp-dir fixtures — synthetic Claude session JSONL (2 models, cache fields, both ephemeral variants + legacy fallback), synthetic Codex rollout (3 cumulative token_counts → last wins), append-and-reparse test (write file, update, append lines, update again → sums equal full-parse-from-scratch; cache reports the file as tail-parsed), shrink test (truncate → full re-parse), cwd mapping test (nested project dirs → deepest match; unmatched bucket).
- No real `~/.claude`/`~/.codex` access in tests (paths injected).

## Phases

1. **Phase A:** pricing + extractor + cache + `usage.json` + CLI entry (`node scripts/usage.mjs` for manual runs and the first full parse).
2. **Phase B:** refresh-cycle integration + page.js join + table column + details sheet section + `Rebuild AI usage` menu item.

## Out of scope (possible later)

- Aider/Gemini sources; per-day/week cost trend charts; CSV export; per-model Codex pricing via `turn_context` deltas; showing unmatched-bucket sessions in the UI.
