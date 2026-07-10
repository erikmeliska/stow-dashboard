# AI Project Analysis (Apple on-device model via apfel) — Design

**Date:** 2026-07-10
**Status:** Approved (pending pilot outcome)
**Goal:** Enrich every project in the JSONL with an AI-generated semantic layer — category, client, description, documentation score, placement advice — produced by the on-device Apple Foundation Model through the `apfel` CLI, and surface it in the dashboard (columns, filters, AI Insights, reorganization report).

## Context

`data/projects_metadata.jsonl` holds 1121 projects with rich mechanical metadata (git, scc, sizes, stack, file types) but no semantic layer: many have empty `description`, there is no notion of *what kind* of project something is, and `~/Projekty` mixes a curated taxonomy (`_Bizz/<client>`, `_AI`, `_Learning`, `_Sandbox`, `_Archives`, …) with dozens of uncategorized projects in the root (including at least one duplicate: `TRIVCALC` in root and in `_Bizz/`).

The analysis engine is **apfel v1.8+** (installed via Homebrew) — a CLI wrapping Apple Foundation Models (macOS 26+, on-device, free, private):

- `--schema <file>` — output constrained to a JSON Schema, **guaranteed valid JSON**
- `--temperature 0` / `--seed` — deterministic output
- `--count-tokens --strict` — preflight budget check (context is 4096 tokens)
- `--retry` — built-in exponential backoff
- Meaningful exit codes: 3 = guardrail block, 4 = context overflow, 5 = model unavailable, 6 = busy

Verified working on this machine (macOS 26.5.1, model available, ~1.4 s per structured completion).

### Pilot findings (2026-07-10, codewars sample)

1. Bare enum categories misclassify (`_Testing` for kata exercises because of "test assertions"). **The system prompt must include a legend explaining what each folder category means.** With the legend the model classified correctly (`_Learning`).
2. **Status must not be asked of the model** — it guessed `dormant` for a 4-years-untouched project despite explicit rules. Status is deterministic from dates; compute it in Node.
3. Doc score responds well to anchoring ("0 = no docs at all, 100 = excellent README with setup/usage").

## Decisions (user-confirmed)

- **Goals:** all four — data enrichment (columns/filters), reorganization advisor, documentation audit, technical validation first.
- **Taxonomy = directory structure.** The model classifies into the existing `_*` folders (read from disk at runtime) and, for `_Bizz`, into the existing client subfolders. Closed classification, no invented categories.
- **Trigger:** separate batch (`npm run analyze` / dashboard ⋯ menu), incremental via input hash; plus per-project Re-analyze in the details sheet. Not part of the scan.
- **Stack:** Node `.mjs` end-to-end, same as the rest of stow. No Swift — `apfel` is the driver, called as a subprocess exactly like `scc`. All logic (distillate, prompt, schema, hashing, batching, retry) lives in Node; swapping engines later means calling a different command with the same contract.
- **Approach:** phased with a pilot gate (A), not all-in.

## Architecture

```
folder taxonomy (~/Projekty/_*, _Bizz/*)  ─┐
JSONL metadata + README + git             ─┤→ distillate (≤ ~3k tokens/project)
                                            │
                        apfel --schema <generated>.json --temperature 0
                                            │
                              ai_analysis → JSONL record
                                            │
              dashboard: columns / filters / AI Insights / reorg report
```

## Components

- **`src/lib/distill.mjs`** — builds the per-project distillate: path + "currently uncategorized in root" note, name, README excerpt (~1500 chars), top-level file tree, package.json description + scripts, stack, git remote URL, ~10 recent commit messages, dates, sizes. Deterministic; `input_hash` = hash of the distillate. Preflights with `apfel --count-tokens --strict` and trims the README excerpt on overflow.
- **`src/lib/analyzer.mjs`** — orchestrator: reads taxonomy from disk (`_*` dirs, `_Bizz/*` clients), generates the JSON Schema (enum injected at runtime) and the system prompt (category legend + doc-score anchors), iterates the JSONL, skips records whose `input_hash` matches, calls `apfel` serially (single local model; parallelism doesn't help), computes deterministic fields (status from dates, `suggested_path` from category+client, archive-candidate = dead ∧ no git remote ∧ total_code < 1000 lines), writes results incrementally.
- **`scripts/analyze.mjs`** — CLI: full batch, `--force`, `--pilot <paths…>` (analyze listed projects and print a review table).
- **`POST /api/analyze`** — start batch from the UI (⋯ menu next to scan controls), progress reporting reusing the scan-progress mechanism; `{ project: <id> }` re-analyzes one project (details-sheet button).
- **UI (phase 2)** — table columns Category / Client / Doc score; quick filters "Misplaced" and "Poor docs"; AI Insights section in the details sheet (description, doc gaps, suggested move); reorganization view listing suggested moves and archive candidates grouped by action.

## Data model

New `ai_analysis` key on each JSONL record:

```json
{
  "category": "_Learning",
  "client": "",                      // only for _Bizz; existing client or "new:<name>"
  "generated_description": "…",      // shown only when description is empty
  "doc_score": 0,                    // 0–100
  "doc_gaps": ["README"],
  "confidence": "medium",            // high | medium | low
  "analyzed_at": "2026-07-10T…",
  "input_hash": "…",
  "model": "apple-foundationmodel/apfel-1.8"
}
```

Deterministic fields computed in Node, stored alongside (not model output):

```json
{
  "status": "dead",                  // active ≤3mo | dormant ≤18mo | dead | archive-candidate
  "placement_ok": false,
  "suggested_path": "/Users/ericsko/Projekty/_Learning/codewars"
}
```

The model never composes filesystem paths; it only classifies.

## Error handling

- **Exit 5 (model unavailable):** batch aborts with a clear message in UI/CLI; the feature is opt-in, nothing else breaks.
- **Exit 3 (guardrail):** record marked `ai_analysis: { "error": "refused" }`, batch continues. `--permissive` considered only if refusals are common.
- **Exit 4 (context overflow):** distillate builder retries with a smaller README excerpt; if still over, mark `"error": "too-large"` and continue.
- **Exit 6 (busy) / timeouts:** `--retry` handles backoff; after final failure, skip + log, continue.
- Batch writes incrementally — an interrupted run loses nothing; the next run resumes via `input_hash`.

## Phases

1. **Phase 0 — Pilot (gate):** `distill.mjs` + `analyzer.mjs --pilot` on ~20 known projects (client work, sandboxes, dead exercises, the `TRIVCALC` duplicate, `_Learning` items). Success criteria: **category correct ≥ 80 %, client correct ≥ 90 %** where applicable. On failure the distillate + contract survive and another engine can be plugged in.
2. **Phase 1 — Batch pipeline:** full incremental batch, JSONL enrichment, `/api/analyze`, progress UI.
3. **Phase 2 — UI:** columns, quick filters, AI Insights, reorganization report.
4. **Phase 3 — Extensions:** deeper doc audit, README draft generation, MCP tools (`list_misplaced_projects`, `list_undocumented_projects`), doc-score history.

## Testing

- Pilot expectations stored as a golden file (`test/fixtures/pilot-expectations.json`); rerunning after prompt/schema changes checks for classification regressions.
- `distill.mjs` and the deterministic derivations (status, suggested_path) are pure functions — unit-testable without the model.

## Dependencies / constraints

- macOS 26+, Apple Intelligence enabled, `apfel` ≥ 1.8 installed (Homebrew). Detected at runtime; absence disables the feature gracefully.
- 4096-token context — distillate must stay ≤ ~3k tokens (output reserve ~512).
- ~1.4 s/project → full first run over 1121 projects ≈ 30 min; incremental reruns touch only changed projects.
- Desktop shells (Deno/Tauri): analysis calls `apfel` from the bundled server process; if unavailable in that context, the batch stays a dev/CLI-side operation (same stance as full scan).
