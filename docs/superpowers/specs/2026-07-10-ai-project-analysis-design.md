# AI Project Analysis (Apple on-device model via apfel) — Design

**Date:** 2026-07-10
**Status:** Approved (pending pilot outcome)
**Goal:** Enrich every project in the JSONL with an AI-generated semantic layer — folder category, client, description, faceted classification (type, domain, tech, maturity, reusable assets), documentation score, placement advice — produced by the on-device Apple Foundation Model through the `apfel` CLI, and surface it in the dashboard (columns, faceted filters, tech cross-sections, AI Insights, reorganization report).

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
- **Code activity vs docs activity:** `status` derives from *code* activity, not raw `last_modified` — otherwise updating a README (a direct outcome of the doc audit) would "revive" a dead project and reshuffle the table. Code activity = last change excluding a **curated meta-doc list** (`README*`, `CHANGELOG*`, `LICENSE*`, `docs/`, `.github/`, `CLAUDE.md`, `STATUS.md`, `TASKS.md`, `AGENTS.md`) — deliberately *not* all `*.md`, because some projects' markdown IS the content (books, doc sites). Git projects: `git log -1 --format=%cI` with `:(exclude)` pathspecs (phase 0, computed in `gatherFacts`). Non-git projects: phase 1 adds scanner-computed `last_code_modified` (max mtime sans excludes, gathered during the existing size walk — zero extra I/O); until then they fall back to `last_modified`. Fallback when nothing non-doc exists (pure-doc projects): `last_modified`, so `content-docs` projects don't go falsely dead. `last_modified` itself stays untouched in JSONL and the UI "Modified" column, and the incremental-scan cache and `input_hash` still react to README changes — a README edit *should* trigger re-analysis (doc_score must update), it just must not change `status`.

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
- **`src/lib/tech-tags.mjs`** — deterministic tech extraction: dependency→tech mapping table, file-signal rules (`Dockerfile`, `*.ino`, `fly.toml`, …), synonym normalization table. Pure functions; also used to normalize the model's `tech_extra`.
- **`src/lib/analyzer.mjs`** — orchestrator: reads taxonomy from disk (`_*` dirs, `_Bizz/*` clients), generates the JSON Schema (category enum injected at runtime; facet enums from one config) and the system prompt (category legend + facet legends + doc-score anchors), iterates the JSONL, skips records whose `input_hash` matches, calls `apfel` serially (single local model; parallelism doesn't help), computes deterministic fields (status from dates, `suggested_path` from category+client, archive-candidate = dead ∧ no git remote ∧ total_code < 1000 lines, merged `tech`), writes results incrementally.
- **`scripts/analyze.mjs`** — CLI: full batch, `--force`, `--pilot <paths…>` (analyze listed projects and print a review table).
- **`POST /api/analyze`** — start batch from the UI (⋯ menu next to scan controls), progress reporting reusing the scan-progress mechanism; `{ project: <id> }` re-analyzes one project (details-sheet button).
- **UI (phase 2)** — table columns Category / Client / Type / Doc score, tech tag chips; faceted filtering (type × domain × tech × maturity combine); quick filters "Misplaced" and "Poor docs"; "Tech cross-section" view (technology list with counts → click → projects); AI Insights section in the details sheet (description, facets, doc gaps, reusable assets, suggested move); reorganization view listing suggested moves and archive candidates grouped by action.

## Data model

New `ai_analysis` key on each JSONL record:

```json
{
  "category": "_Learning",
  "client": "",                      // only for _Bizz; existing client or "new:<name>"
  "generated_description": "…",      // shown only when description is empty
  "project_type": "script-collection",
  "domain": "devtools",
  "maturity": "prototype",           // idea | prototype | mvp | production | abandoned-wip
  "tech_extra": ["chai"],            // model-suggested additions to the deterministic tech set
  "reusable_assets": [],             // free text, max 3, e.g. "ready-made Google OAuth flow"
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
  "status": "dead",                  // active ≤3mo | dormant ≤18mo | dead | archive-candidate — from CODE activity (meta-doc edits excluded)
  "placement_ok": false,
  "suggested_path": "/Users/ericsko/Projekty/_Learning/codewars",
  "tech": ["javascript", "chai"]     // merged: deterministic extraction ∪ normalized tech_extra
}
```

The model never composes filesystem paths; it only classifies.

## Facets (beyond folder category)

The folder category is only one axis; the analysis fills independent facets so the table supports cross-sections (type × domain × tech × maturity combine as filters):

- **`project_type`** — what the artifact is. Closed enum: `web-app`, `api-service`, `cli-tool`, `library`, `browser-extension`, `desktop-app`, `mobile-app`, `script-collection`, `infra-config`, `template-boilerplate`, `prototype-poc`, `fork`, `content-docs`.
- **`domain`** — what it is about. Closed enum (~12 values, extendable in one place): `e-commerce`, `communication-email`, `church-community`, `finance`, `education`, `devtools`, `iot-electronics`, `media`, `ai-ml`, `productivity`, `games`, `other`.
- **`tech`** — canonical technology tags for cross-sections ("everything using Prisma"). **Hybrid, deterministic-first:** Node extracts from manifests and file signals (dependency→tech mapping table, `Dockerfile`→`docker`, `*.ino`→`arduino`, `fly.toml`→`fly`, …) and picks primary techs out of raw `stack` noise; the model only supplies `tech_extra` for technologies visible in README/code but absent from manifests (non-npm projects). Node normalizes `tech_extra` through the same synonym table (`e-shop`/`eshop`→`e-commerce`-style dedup) before merging.
- **`maturity`** — how far it got, orthogonal to activity status: a production project may rightfully be dormant; `production` + `dead` is an alert (unmaintained client deployment?).
- **`reusable_assets`** — up to 3 free-text items naming what could be harvested ("ready-made Google OAuth flow", "Docker compose for Moodle", "Puppeteer scraper"). Turns the corpus into a building-block catalog, queryable via MCP.

**Tag-explosion guard:** everything the model chooses freely is either schema-constrained (enums) or normalized in Node; only `reusable_assets` (and later `notable`) stay free text, where variety is value rather than chaos. All facets fit in the single per-project model call — the schema grows, the distillate does not.

## Error handling

- **Exit 5 (model unavailable):** batch aborts with a clear message in UI/CLI; the feature is opt-in, nothing else breaks.
- **Exit 3 (guardrail):** record marked `ai_analysis: { "error": "refused" }`, batch continues. `--permissive` considered only if refusals are common.
- **Exit 4 (context overflow):** distillate builder retries with a smaller README excerpt; if still over, mark `"error": "too-large"` and continue.
- **Exit 6 (busy) / timeouts:** `--retry` handles backoff; after final failure, skip + log, continue.
- **Unsupported input language:** Apple's model rejects non-supported-language input (e.g. Slovak) with stderr `unsupported language` (exit 1), classified as `error: "unsupported-language"`. Recovery is staged: (1) a **lang-safe retry** re-runs apfel once with a distillate stripped of README/commits and the path leaf masked (the name still appears once); (2) if that is also rejected, a **local Ollama fallback** (`OLLAMA_URL`/`OLLAMA_MODEL`, default `llama3` on `localhost:11434`) re-analyzes the original Slovak-bearing distillate via `/api/chat` structured output — Ollama has no language guardrail, and the record's `model` becomes `ollama/<model>`; (3) if Ollama is unavailable or fails, a typed `unsupported-language` error record is written with `error_detail` (the stderr line, plus `; ollama fallback failed: …` when the fallback was attempted). All error records carry `error_detail` when the underlying error provides one. `input_hash` always stays the full-size cache key. `--retry-errors` re-runs only errored records.
- Batch writes incrementally — an interrupted run loses nothing; the next run resumes via `input_hash`.

## Phases

1. **Phase 0 — Pilot (gate):** `distill.mjs` + `tech-tags.mjs` + `analyzer.mjs --pilot` on ~20 known projects (client work, sandboxes, dead exercises, the `TRIVCALC` duplicate, `_Learning` items). Success criteria: **category correct ≥ 80 %, client correct ≥ 90 %** where applicable; `project_type` correct ≥ 80 % (facets are reviewed but only category/client/type gate). On failure the distillate + contract survive and another engine can be plugged in.
2. **Phase 1 — Batch pipeline:** full incremental batch, JSONL enrichment, `/api/analyze`, progress UI; scanner gains `last_code_modified` (non-git code-activity date, computed during the size walk).
3. **Phase 2 — UI:** columns, faceted filters, tech cross-section, AI Insights, reorganization report.
   Carry-over from phase-1 final review: (a) `input_hash` is time-varying — the distillate text embeds `last_modified` day and idle-months, so long-idle projects re-analyze when the month bucket ticks; hash a content-only projection instead. (b) A full scan running concurrently with a batch can revert just-written `ai_analysis` from its stale cache snapshot (self-heals on next batch; document "don't scan while analyzing" or serialize the two). (c) Phase-0 leftovers: tech junk filter may drop legit 3-segment tags; fakeExec argv-shape assertions; `new:` client sanitizer hardening; `--pilot` unknown-dir warning.
4. **Phase 3 — Extensions:** deeper doc audit, README draft generation, MCP tools (`list_misplaced_projects`, `list_undocumented_projects`, `find_reusable_assets(query)`, `search_projects` gains facet params), doc-score history, `notable` field (one interesting fact per project), deployment detection (CI/Vercel/Docker signals + model judgment), project-relations pass (similarity over generated descriptions + facets, computed in Node without the model — flags duplicates and "N attempts at the same thing").

## Testing

- Pilot expectations stored as a golden file (`test/fixtures/pilot-expectations.json`); rerunning after prompt/schema changes checks for classification regressions.
- `distill.mjs` and the deterministic derivations (status, suggested_path) are pure functions — unit-testable without the model.

## Dependencies / constraints

- macOS 26+, Apple Intelligence enabled, `apfel` ≥ 1.8 installed (Homebrew). Detected at runtime; absence disables the feature gracefully.
- 4096-token context — distillate must stay ≤ ~3k tokens (output reserve ~512).
- ~1.4 s/project → full first run over 1121 projects ≈ 30 min; incremental reruns touch only changed projects.
- Desktop shells (Deno/Tauri): analysis calls `apfel` from the bundled server process; if unavailable in that context, the batch stays a dev/CLI-side operation (same stance as full scan).
