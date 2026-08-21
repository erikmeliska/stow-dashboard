# cc Observability Phase 2 — Eval, Summaries & Work Context — Design

Date: 2026-08-21
Status: Approved in chat (addendum to `2026-08-21-cc-observability-team-design.md` §6/§9)

## 1. Goal

Enrich each ingested Claude Code session (phase 1b store) with:

- **Work context**: git repo, branch, PR, and a tool-agnostic **ticket id**.
- **Quality score v1**: transparent heuristic with its components stored.
- **AI summary**: on-demand, via the local `claude -p` CLI (no API key).
- **Richer viewer**: context / quality / summary sections, Ticket + Q columns.

## 2. Decisions

- **Ticket is tool-agnostic**: columns `ticket_id` + `ticket_source`, not `jira_ticket`.
  Pattern from `CC_TICKET_PATTERN` (default `\b[A-Z][A-Z0-9]+-\d+\b`). Sources in priority
  order: `branch` (transcript `gitBranch`), `prompt` (first user prompt), `commit`
  (`git commit -m …` inside Bash tool_use). First match wins; source recorded.
- **Summary engine = `claude -p`** (subprocess, same pattern as apfel in `analyzer.mjs`), with
  `--output-format json --json-schema … --tools "" --no-session-persistence` — the last flag is
  mandatory so summaries don't create transcripts that we then ingest (self-feeding loop).
  Engine lives behind `summarize(distillate, { exec })` so a future API engine is a drop-in.
- **Summaries are on-demand** (detail-panel button, `npm run cc:eval -- --summaries [--limit N]`),
  never automatic on ingest: 250 sessions × a Claude call is real subscription usage.
- **Quality score is a heuristic** and labelled so in the UI; components are stored as JSON
  (`quality_detail`) so the number is explainable.
- Context + quality are **deterministic and cheap** → recomputed on every ingest (same pass as
  tokens). Summary is preserved across re-ingests (upsert must not null it).

## 3. Data model changes (`sessions`)

Rename `jira_ticket` → `ticket_id`; add `ticket_source`, `pr`, `quality_detail` (JSON text),
`summary_model`, `summarized_at`. The DB is local and new: `openStore()` migrates in place
(`ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`; `jira_ticket` is simply left unused
if present). `git_repo`, `git_branch`, `quality_score`, `summary` already exist.

Upsert semantics: `upsertSession` writes the ingest-owned columns only; `setSummary(db, id,
{summary, model})` writes the summary columns. This is what keeps summaries across re-ingests.

## 4. Components

- `src/lib/cc/context.mjs` — pure `extractContext(lines, { ticketPattern }) → { git_branch,
  git_repo, pr, ticket_id, ticket_source }`. Branch = most common non-`HEAD` `gitBranch`
  value (last non-HEAD seen wins on tie). Repo = `git remote`/`git push`/`gh` URLs or
  `github.com/...` seen in Bash commands or tool results; else null (phase 3 may ask the repo
  itself). PR = number from `gh pr create/view` output (`/pull/(\d+)`), else null.
- `src/lib/cc/quality.mjs` — pure `scoreSession(lines, { guardHits }) → { score, detail }`:
  | component | rule | points |
  |---|---|---|
  | `verified` | a Bash tool_use matching `CC_VERIFY_PATTERN` (default: `npm test|node --test|pytest|cargo test|go test|vitest|jest|playwright`) | 25 |
  | `clean_finish` | last assistant message has no `is_error` tool_result after it | 25 |
  | `error_rate` | share of tool_results with `is_error:true`: 0% → 25, linear to 0 at ≥20% | 0–25 |
  | `no_loops` | no 3+ consecutive identical `(tool, JSON(input))` tool_uses | 15 |
  | `guard_clean` | no `deny`/`override` guard hits | 10 |
  Score = sum (0–100). `detail` = `{ verified, clean_finish, error_rate_pct, loops, guard_hits }`.
- `src/lib/cc/summary.mjs` — `distill(lines, { maxChars = 30000 })` (user prompts, tool names
  + short Bash commands, assistant text tail) and `summarize(distillate, { exec })` returning
  `{ what, outcome: 'done'|'partial'|'abandoned', improvements: string[], followups: string[] }`
  via `claude -p` with a JSON schema. `exec` is injectable for tests (no real CLI in `npm test`).
- `scripts/cc-ingest.mjs` — calls `extractContext` + `scoreSession` per session (guard hits
  are known at that point) and stores them.
- `scripts/cc-eval.mjs` + `npm run cc:eval` — `--summaries [--limit N] [--id <sid>]`: summarise
  sessions lacking a summary, newest first.
- `POST /api/sessions/summarize` `{ id }` → runs `summarize` for one session and returns the
  updated detail. Reads the transcript from `raw_ref`.
- `src/app/sessions/page.js` — table gains `Ticket` and `Q` columns; detail panel gains
  Context, Quality (score + component list, "heuristic" label) and Summary (+ Generate
  button with loading state) sections.

## 5. Error handling

- No transcript at `raw_ref` → summarize returns 404-style error; UI shows it.
- `claude` CLI missing / non-zero exit / invalid JSON → error surfaced, nothing stored.
- Ticket/verify patterns invalid → fall back to defaults and log once.

## 6. Testing

Pure modules (`context`, `quality`, `summary.distill`, `summary.summarize` with fake exec,
store migration) get `node:test` unit tests with inline JSONL fixtures. The API route's
`handle` stays pure. One manual end-to-end: `npm run cc:ingest`, open `/sessions`, generate a
summary for one session.

## 7. Out of scope

Sync/egress (phase 3), lifecycle hooks, incremental ingest, editing summaries.
