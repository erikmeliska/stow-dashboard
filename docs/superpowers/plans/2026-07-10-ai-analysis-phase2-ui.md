# AI Project Analysis — Phase 2 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the AI analysis in the dashboard: a resumable background analyze job with a poll-driven progress indicator, table columns + faceted filters (tech cross-section included), AI Insights + Re-analyze in the details sheet, and a reorganization report dialog.

**Architecture:** The analyze job moves from SSE-follow to POST-and-poll: `analyze-batch.mjs` keeps an in-memory status snapshot, `GET /api/analyze/status` exposes it, `POST /api/analyze` returns immediately, and ScanControls polls — so progress survives view switches and reloads. All table work plugs into existing seams in `project-table.js`: the manual `filteredProjects` useMemo (quick filters), the group-filter trio (facet template), the `columns` array, and the persisted-settings object. No new npm dependencies — facets use `DropdownMenu`+`DropdownMenuCheckboxItem`, badges use the repo's inline pill classes.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TanStack Table, existing shadcn/ui primitives only (button, dialog, dropdown-menu, separator, sheet, tooltip), `node --test` for lib-level tests.

**Spec:** `docs/superpowers/specs/2026-07-10-ai-project-analysis-design.md` (Phase 2 + Facets sections). Data already flows: `page.js` spreads whole JSONL records into `ProjectTable` props, so `record.ai_analysis` / `record.ai_derived` reach rows as-is.

## Global Constraints

- No new npm dependencies. No new shadcn primitives that would require Radix/cmdk deps (Popover/Command/Checkbox/Select/Progress/Badge are NOT available — use DropdownMenu checkbox items and inline pill classes like `text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 dark:text-green-400`).
- Data shapes: `ai_analysis` = `{ category, client, generated_description, project_type, domain, maturity, tech_extra[], reusable_assets[], doc_score, doc_gaps[], confidence, analyzed_at, input_hash, version, model }` or `{ error, analyzed_at, input_hash, version }`. `ai_derived` = `{ status, tech[], placement_ok, suggested_path }`. **Both keys may be absent** (unanalyzed) — every cell/filter must handle `undefined` gracefully; error records (`ai_analysis.error`) count as unanalyzed for display purposes.
- Quick filters and facets hook into the manual `filteredProjects` useMemo in `project-table.js` (~L219-294) and its dependency array — NOT TanStack `columnFilters`. Every new filter resets `pageIndex` to 0 on change (existing `cycleFilter` pattern).
- New persisted UI state extends the existing `stow-dashboard-table-settings` object (`saveSettings`/`loadSettings` in project-table.js) — no new localStorage keys; `resetToDefaults` must clear the new state too.
- Column visibility: merge `{...defaultColumnVisibility, ...saved.columnVisibility}` when loading persisted settings so new columns get their intended defaults for existing users (today's code overwrites wholesale — fix it in Task 2).
- The analyze status endpoint reflects the module-level state in `analyze-batch.mjs` (in-memory, single server process — the desktop app and `next start` both run one process; acceptable; note it in code comments).
- The single-model contention rule stands: nothing in this plan may launch a full batch during verification. A batch is CURRENTLY RUNNING in the desktop app — verification steps must not call apfel at all (single-project Re-analyze verification is deferred to a controller step after the app batch finishes).
- Dev-server verification: `npm run dev` on port 3089 (reuse if already listening); repo JSONL will be pre-seeded with AI keys by the controller before UI tasks — do not run `npm run analyze` yourself.
- Slovak is the user's language but the UI copy is English (existing convention: "Full scan", "Force rescan", "Running", …). Keep new UI copy English.

---

### Task 1: Background analyze job — status snapshot, poll endpoint, resumable UI

**Files:**
- Modify: `src/lib/analyze-batch.mjs`
- Create: `src/app/api/analyze/status/route.js`
- Modify: `src/app/api/analyze/route.js`
- Modify: `src/components/ScanControls.js`
- Test: `src/lib/analyze-batch.test.mjs` (append)

**Interfaces:**
- Produces: `getAnalysisStatus(): { running: boolean, startedAt: string|null, current: number, total: number, analyzed: number, skipped: number, errors: number, lastProject: string|null, finishedAt: string|null, lastError: string|null }` — module-level snapshot updated by `runAnalysisBatch` (start: reset+running=true; each onProgress-worthy step: counters+lastProject; finally: running=false, finishedAt).
- Produces: `GET /api/analyze/status` → that object as JSON.
- Changes: `POST /api/analyze` no longer streams. It validates (unknown project id → 400 JSON; `isAnalysisRunning()` → 409 JSON `{error:'analysis already running'}`), then **starts the batch without awaiting** (`runAnalysisBatch(...).catch(err => console.error('[analyze]', err))`) and returns 202 JSON `{ started: true, total? }`. The internal `onProgress` callback now only feeds the status snapshot (pass a callback that calls an exported `updateAnalysisStatus(event)` — or better: move snapshot maintenance INTO `runAnalysisBatch` itself so every caller (CLI too) updates it; the CLI's own `onProgress` remains for console output).
- ScanControls: analyze menu items POST then poll `GET /api/analyze/status` every 2000 ms until `running === false`; progress area shows `AI analyzing… lastProject (current/total, analyzed ✓ / errors ✗)`. **Resume:** on component mount, fetch status once — if `running`, enter the same polling/display state (this is what survives view switches). On completion: stop polling, show summary line, `router.refresh()`.

- [ ] **Step 1: Status snapshot in analyze-batch (TDD)**

Append tests to `src/lib/analyze-batch.test.mjs` (reuse the existing `makeWorld`/`okExec` helpers):

```js
import { getAnalysisStatus } from './analyze-batch.mjs'

test('getAnalysisStatus tracks a batch lifecycle', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    const before = getAnalysisStatus()
    assert.equal(before.running, false)
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    const after = getAnalysisStatus()
    assert.equal(after.running, false)
    assert.equal(after.total, 1)
    assert.equal(after.analyzed, 1)
    assert.ok(after.startedAt)
    assert.ok(after.finishedAt)
    assert.equal(after.lastProject, 'proj1')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('getAnalysisStatus reports running=true mid-batch', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    let release
    const gate = new Promise(res => { release = res })
    const slowExec = async (cmd, args) => {
      if (!args.includes('--count-tokens')) await gate
      return { stdout: args.includes('--count-tokens') ? 'ok' : JSON.stringify(MODEL_OUT), stderr: '' }
    }
    const run = runAnalysisBatch({ dataFile, baseDir: base, execImpl: slowExec, force: true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(getAnalysisStatus().running, true)
    release()
    await run
    assert.equal(getAnalysisStatus().running, false)
  } finally { await rm(base, { recursive: true, force: true }) }
})
```

Implementation in `analyze-batch.mjs`: a module-level `status` object with the shape above; `runAnalysisBatch` resets it at entry (inside the `running = true` section: `startedAt = new Date().toISOString()`, zero counters, `finishedAt = null`), updates it alongside every existing `onProgress` call (`current/total/analyzed/skipped/errors/lastProject = record.project_name`), and stamps `finishedAt` + `lastError` (from a thrown unavailable error) in the `finally`. Export `getAnalysisStatus()` returning a shallow copy. The existing `onProgress` param behavior is unchanged (CLI keeps printing).

Run: `node --test src/lib/analyze-batch.test.mjs` → RED (missing export) → implement → GREEN (6 tests).

- [ ] **Step 2: Status route + non-streaming POST**

`src/app/api/analyze/status/route.js`:

```js
import { getAnalysisStatus } from '@/lib/analyze-batch.mjs'

export async function GET() {
  return Response.json(getAnalysisStatus())
}
```

Rewrite `src/app/api/analyze/route.js` POST per the Interfaces block above: keep the DATA_FILE/BASE_DIR + `readProjectsData` id-resolution logic, drop the ReadableStream entirely, fire `runAnalysisBatch({...}).catch(...)` un-awaited, return `Response.json({ started: true }, { status: 202 })`. Unknown id → `Response.json({ error: 'unknown project id: …' }, { status: 400 })`; already running → 409. `force: force || Boolean(project)` stays. ApfelError('unavailable') from the detached batch is caught by the `.catch` and lands in `getAnalysisStatus().lastError` (set it in the batch's finally via the caught error — implement by having runAnalysisBatch record the throw reason into the snapshot before rethrowing).

- [ ] **Step 3: ScanControls — poll + resume**

In `src/components/ScanControls.js`:
1. `handleScan('analyze' | 'analyze-force')` branches away from the SSE reader: POST `/api/analyze` with `{}` / `{force:true}`; on 202 start polling; on 409 show "analysis already running" and start polling anyway (attach to the existing run); on other errors show the error.
2. New `pollAnalysis()` using the existing interval idiom (see the 60s auto-refresh at ~L127-143): every 2000 ms fetch `/api/analyze/status`; map to the existing progress display state (`setProgress({ message: \`AI: ${s.lastProject ?? '…'} \` })`, `setScanStats({ current: s.current, total: s.total })`, keep `isScanning=true, scanType='analyze'`); when `running===false`: clear interval, `setProgress({ message: \`AI analysis done: ${s.analyzed} analyzed, ${s.skipped} cached, ${s.errors} errors\`, success: true })`, `setIsScanning(false)`, `router.refresh()`.
3. **Resume on mount:** a `useEffect` on mount fetches status once; if `running`, call the same enter-polling path. Guard against double intervals (keep the interval id in a ref; clear on unmount).
4. Remove the now-dead `analyzed/skipped/analyze_error` branches from `handleProgressEvent` and the `data.analyzed !== undefined` complete-branch (scan SSE events remain untouched).

- [ ] **Step 4: Full suite + lint**

Run: `npm test` → all green (existing + 2 new). `npx eslint src/components/ScanControls.js src/app/api/analyze src/lib/analyze-batch.mjs` → no new problems vs baseline.

- [ ] **Step 5: Live verification (NO apfel calls)**

Dev server (reuse port 3089 if listening, else start): `curl -s http://localhost:3089/api/analyze/status` → JSON with `running` (probably `false`, or `true` if the app batch's process were this one — it isn't; dev is a separate process so expect a fresh idle snapshot). POST with an unknown id → 400. DO NOT POST a real batch or single project. UI: menu items still render; mount-resume effect visible in React devtools/network tab (one status fetch on load).

- [ ] **Step 6: Commit**

```bash
git add src/lib/analyze-batch.mjs src/lib/analyze-batch.test.mjs src/app/api/analyze src/components/ScanControls.js
git commit -m "feat: analyze runs as background job with poll-driven resumable progress"
```

---

### Task 2: Table columns + search + visibility-merge fix

**Files:**
- Modify: `src/app/project-table.js`
- Modify: `src/lib/utils.js`

**Interfaces:**
- Consumes: `row.original.ai_analysis` / `row.original.ai_derived` (may be undefined).
- Produces columns (ids exactly): `ai_category` (visible by default), `ai_doc_score` (visible), `ai_type` (hidden), `ai_status` (hidden). Facet/quick-filter work (Task 3) does not depend on the columns, only on the same fields.
- Produces: `docScoreColor(score)` helper in `src/lib/utils.js`: `score >= 70 → 'green'`, `>= 40 → 'amber'`, `else → 'red'` (returns the color token string used in pill classes).

- [ ] **Step 1: utils helper**

Add to `src/lib/utils.js`:

```js
export function docScoreColor(score) {
  if (score >= 70) return 'green'
  if (score >= 40) return 'amber'
  return 'red'
}
```

(No test file exists for utils.js — add `src/lib/utils.test.mjs`? utils.js imports `clsx`/`tailwind-merge`/`date-fns` which work under node — yes, create the test file with 3 assertions for docScoreColor boundaries: 70→green, 40→amber, 39→red.)

- [ ] **Step 2: Columns**

In `project-table.js`, append before the `actions` column (~L719), following the existing sortable-header Button pattern:

1. **`ai_category`** — `id: 'ai_category'`, `accessorFn: row => row.ai_analysis?.category ?? ''`, header "Category" (sortable). Cell: unanalyzed/error → muted `—`; else a pill `bg-violet-500/20 text-violet-600 dark:text-violet-400` with `category.replace(/^_/, '')` and, when `ai_analysis.client`, append `/${client}`. Title attr = `generated_description` (hover reveals the AI description).
2. **`ai_doc_score`** — `accessorFn: row => row.ai_analysis?.doc_score ?? -1`, header "Docs" (sortable, `sortDescFirst: true`). Cell: `-1` → `—`; else number + a 40px inline bar: `<div className="h-1.5 w-10 rounded bg-muted"><div className={cn('h-1.5 rounded', \`bg-${color}-500\`)} style={{width: \`${score}%\`}}/></div>` — **Tailwind cannot see interpolated class names**: use a literal map `{green:'bg-green-500', amber:'bg-amber-500', red:'bg-red-500'}[docScoreColor(score)]`, never string interpolation.
3. **`ai_type`** — `accessorFn: row => row.ai_analysis?.project_type ?? ''`, header "Type", plain text cell (muted when empty).
4. **`ai_status`** — `accessorFn: row => row.ai_derived?.status ?? ''`, header "AI Status". Cell pill colors: `active` green, `dormant` amber, `dead` zinc/muted, `archive-candidate` red.

Update `defaultColumnVisibility` (~L95): add `ai_type: false, ai_status: false` (category + doc score default visible).

**Visibility-merge fix** (Global Constraints): in the settings-load effect (~L320-331), change the columnVisibility restore to `setColumnVisibility({ ...defaultColumnVisibility, ...saved.columnVisibility })` so new column defaults apply to users with persisted settings.

The Columns dropdown (~L910) renders raw `column.id` — the `ai_*` ids are acceptable labels (`ai_category` etc.); optionally map to clean labels via a small `COLUMN_LABELS` object if one already exists; do not build new infrastructure.

- [ ] **Step 3: Search over AI fields**

Add to BOTH search implementations (`matchesSearch` ~L185-197 AND `globalFilterFn` ~L788-806): `ai_analysis?.generated_description`, `ai_analysis?.category`, `ai_analysis?.client`, and `ai_derived?.tech?.join(' ')` — lowercase-includes like the existing fields.

- [ ] **Step 4: Verify + commit**

`npm test` green (utils test). Live: dev server, table shows Category + Docs columns; analyzed rows show pills/bars, unanalyzed show `—`; search for a known analyzed category (e.g. "learning") returns rows. Use preview tools (snapshot/screenshot) for evidence.

```bash
git add src/app/project-table.js src/lib/utils.js src/lib/utils.test.mjs
git commit -m "feat: AI analysis table columns (category, doc score, type, status) and search"
```

---

### Task 3: Facet filters + quick filters (tech cross-section)

**Files:**
- Modify: `src/app/project-table.js`

**Interfaces:**
- Consumes: same AI fields; the group-filter trio as template (`selectedGroups` state ~L110, `groupStats` memo ~L206-216, filter block ~L223-227, DropdownMenu UI ~L857-889, chips ~L983-1002, auto-prune ~L311-317).
- Produces: `aiFacets` state `{ category: [], type: [], domain: [], maturity: [], tech: [] }` (arrays of selected values); three new 3-state quick filters `analyzed`, `misplaced`, `poorDocs`; all persisted inside the existing settings object.

- [ ] **Step 1: Facet state + filtering**

1. State: `const [aiFacets, setAiFacets] = useState({ category: [], type: [], domain: [], maturity: [], tech: [] })`.
2. Value extraction per facet (single accessor map, module scope):

```js
const FACET_ACCESSORS = {
  category: p => p.ai_analysis?.category ? [p.ai_analysis.category] : [],
  type:     p => p.ai_analysis?.project_type ? [p.ai_analysis.project_type] : [],
  domain:   p => p.ai_analysis?.domain ? [p.ai_analysis.domain] : [],
  maturity: p => p.ai_analysis?.maturity ? [p.ai_analysis.maturity] : [],
  tech:     p => p.ai_derived?.tech ?? [],
}
```

3. `facetStats` useMemo over `searchFilteredProjects`: for each facet, a sorted `[{value, count}]` list (tech sorted by count desc — this IS the tech cross-section; others alphabetical).
4. In the `filteredProjects` useMemo: for each facet with selections, `result = result.filter(p => FACET_ACCESSORS[f](p).some(v => aiFacets[f].includes(v)))` (OR within a facet, AND across facets — same semantics as groups). Add `aiFacets` to the dependency array; reset `pageIndex` when facets change (wrap changes in a setter helper that also resets pagination, mirroring `cycleFilter`).
5. Auto-prune effect mirroring groups: drop selected facet values that no longer exist in `facetStats`.

- [ ] **Step 2: Quick filters**

Add to the `filters` init object, `clearAllFilters`, and the button array (all three spots, per the established pattern):
- `analyzed`: true → `p.ai_analysis && !p.ai_analysis.error`; false → the negation (unanalyzed OR error).
- `misplaced`: true → `p.ai_derived?.placement_ok === false`; false → `p.ai_derived?.placement_ok === true` (records without `ai_derived` match neither).
- `poorDocs`: true → `(p.ai_analysis?.doc_score ?? -1) >= 0 && p.ai_analysis.doc_score < 50`; false → `doc_score >= 50`.
Button labels: `{ key: 'analyzed', label: 'Analyzed', shortLabel: 'AI' }`, `{ key: 'misplaced', label: 'Misplaced', shortLabel: 'Mispl' }`, `{ key: 'poorDocs', label: 'Poor docs', shortLabel: 'Docs' }`. Corresponding filter blocks in the `filteredProjects` memo.

- [ ] **Step 3: Facet dropdown UI**

One "AI filters" `DropdownMenu` button in the toolbar next to the existing Groups dropdown (~L857). Check whether `src/components/ui/dropdown-menu.jsx` exports `DropdownMenuSub`/`DropdownMenuSubTrigger`/`DropdownMenuSubContent`; if yes, one dropdown with five submenus (Category, Type, Domain, Maturity, Tech), each listing `facetStats` values as `DropdownMenuCheckboxItem` with counts (`value (count)`), Tech submenu capped at top 30 by count with a muted "+N more" line. If Sub components are missing, fall back to two dropdown buttons ("AI facets" with category/type/domain/maturity as inline groups separated by `DropdownMenuSeparator` + label items, and "Tech" standalone). Selected values render as removable chips in the existing chips row (~L983), prefixed by facet (`tech: react ×`).

- [ ] **Step 4: Persistence**

Extend the persisted settings object (`saveSettings` call sites and the load effect) with `aiFacets` alongside `filters`; `resetToDefaults` resets facets to empty. The `filters` object gains the three new keys in the same places the existing nine live.

- [ ] **Step 5: Verify + commit**

`npm test` (no new unit surface — UI-only; the suite guards against accidental lib breakage). Live via preview tools: select a tech facet value → table filters; counts in the dropdown match visible reality; combine misplaced=true with category facet; chips removable; reload preserves selections; Reset filters clears them. Screenshot as evidence.

```bash
git add src/app/project-table.js
git commit -m "feat: AI facet filters with tech cross-section and analyzed/misplaced/poor-docs quick filters"
```

---

### Task 4: AI Insights section + Re-analyze (details sheet)

**Files:**
- Modify: `src/components/ProjectDetailsSheet.js`

**Interfaces:**
- Consumes: `project.ai_analysis` / `project.ai_derived` (whole record passed as prop — no plumbing needed); `POST /api/analyze` `{project: id}` (Task 1 contract: 202/409 JSON); `GET /api/analyze/status`.
- Produces: an "AI Insights" `Section` after the Description section (~L646), and a Re-analyze control.

- [ ] **Step 1: Section**

Using the local `Section`/`StatItem` primitives and inline pill classes:

- When `!project.ai_analysis`: Section shows muted "Not analyzed yet" + the Re-analyze button (label "Analyze").
- When `ai_analysis.error`: muted `Analysis failed: ${error}` + Re-analyze.
- Else render:
  - `generated_description` as a paragraph (only when `project.description` is empty — spec rule; when a real description exists show the AI one muted+titled "AI description").
  - StatItems: Category (pill, `category/client` like the table), Type, Domain, Maturity, Confidence, Analyzed (formatTimeAgo of `analyzed_at`).
  - Doc score with the same bar as the table + `doc_gaps` as a bulleted muted list.
  - `ai_derived.tech` as chips (stack-chip styling, ProjectDetailsSheet ~L654).
  - `reusable_assets` as a short list when non-empty.
  - Placement: when `placement_ok === false`, an amber row `Suggested: ${suggested_path}` with the local `CopyButton` copying `mv "${project.directory}" "${suggested_path}"`.

- [ ] **Step 2: Re-analyze button**

In the Section header row (small ghost Button, `RefreshCw` icon + "Re-analyze"): POST `/api/analyze` `{ project: project.id }`; on 202 set a local `reanalyzing` state and poll `GET /api/analyze/status` every 2000 ms (mirror the existing 3s process-poll effect ~L167-186) until `running === false`, then `router.refresh()` (import `useRouter` if the sheet lacks it — check; the table refresh propagates the updated record into the open sheet via props) and clear the state; on 409 show a muted "another analysis is running" note and do NOT poll-block the button forever (re-enable after the poll sees idle).

- [ ] **Step 3: Verify + commit**

`npm test` green. Live: open details of an analyzed project → section renders all fields; open an unanalyzed one → "Not analyzed yet". DO NOT click Re-analyze while the desktop-app batch runs (single model) — the 409 path can be verified live precisely BECAUSE the app batch is running only if dev shares the model… it does (same machine, apfel is one queue): clicking Re-analyze in dev during the app batch would enqueue/collide. Verify the 409/idle handling by code review only; the controller will do one live Re-analyze after the app batch finishes. Screenshot the section.

```bash
git add src/components/ProjectDetailsSheet.js
git commit -m "feat: AI Insights section with re-analyze in project details sheet"
```

---

### Task 5: Reorganization report dialog

**Files:**
- Create: `src/components/ReorgReportDialog.js`
- Modify: `src/app/project-table.js` (trigger button + render)

**Interfaces:**
- Consumes: the table's `filteredProjects`-independent full `projects` prop (report always covers ALL projects, not the filtered view); `ai_derived.placement_ok/suggested_path/status`, `ai_analysis.category/client/confidence`.
- Produces: `ReorgReportDialog({ open, onOpenChange, projects, onOpenProject })` — `onOpenProject(project)` lets a row's Eye button open the existing details sheet.

- [ ] **Step 1: Component**

Follow `ReadmeDialog`'s Dialog usage. Content (scrollable, `max-h-[70vh] overflow-y-auto`):

1. **Moves** — projects with `ai_derived && placement_ok === false`, grouped by target category (first path segment under BASE… derive group label from `ai_analysis.category` + optional client). Each group: header `→ _Learning (12)`, rows: project name, muted current path → suggested path, per-row buttons: Copy (`mv "current" "suggested"` via a local copy-to-clipboard button — replicate the CopyButton pattern from ProjectDetailsSheet, or export/move that tiny component into `src/components/CopyButton.js` and reuse in both places — prefer the extraction, it's two files touching one 12-line component) and Eye (`onOpenProject(project)`).
2. **Archive candidates** — `ai_derived?.status === 'archive-candidate'`, sorted by `scc.total_code ?? 0` ascending; rows: name, path, muted `${total_code ?? 0} lines, last activity ${formatTimeAgo(last_modified)}`.
3. Header summary: `X misplaced · Y archive candidates · Z unanalyzed` (unanalyzed = no `ai_analysis` or error).
4. Rows with `ai_analysis.confidence === 'low'` get a muted `low confidence` tag — the user should trust these less.
5. NO filesystem actions in this phase — the dialog only displays and copies commands (moving projects is phase-3 territory).

- [ ] **Step 2: Trigger**

In `project-table.js` toolbar Row 1 (~L840-934), next to the Columns dropdown: a ghost Button `FolderTree` icon (lucide) + "Reorg" (label hidden on small screens like other toolbar buttons) opening the dialog. Dialog rendered next to `ReadmeDialog`/details sheet (~L825-835) with `onOpenProject={(p) => setDetailsSheet({ open: true, project: p })}` (also closes itself).

- [ ] **Step 3: Verify + commit**

Live: open the report — groups render with counts matching a manual grep of the seeded JSONL; copy button puts a valid `mv` command on the clipboard; Eye opens the details sheet. Screenshot.

```bash
git add src/components/ReorgReportDialog.js src/components/CopyButton.js src/components/ProjectDetailsSheet.js src/app/project-table.js
git commit -m "feat: reorganization report dialog (moves + archive candidates)"
```

---

## Controller steps (not subagent tasks)

- **Before Task 2:** seed the repo JSONL with AI keys merged from the desktop app's data file (match on `directory`; copy `ai_analysis`+`ai_derived` only) so UI verification has real data without touching the model.
- **After the app batch finishes:** one live single-project Re-analyze from the dev UI (Task 4's deferred verification) + final whole-branch review + merge.

## Self-Review Notes

- Spec coverage: columns/facets/quick filters (Tasks 2-3), tech cross-section = tech facet with counts (Task 3), AI Insights + re-analyze (Task 4), reorg report (Task 5), background/resumable progress (Task 1 — the user-reported UX gap that motivated this phase). URL-persisted filters and file-moving actions intentionally out (YAGNI / phase 3).
- Type consistency: status endpoint shape defined once in Task 1 and consumed in Tasks 1/4; facet accessor map is the single source for both stats and filtering; column ids `ai_*` used consistently.
- Known risks: `project-table.js` grows further (~+200 lines) — acceptable per repo convention, extraction of columns is noted as optional and NOT mandated (YAGNI now, revisit if it passes ~1400 lines).
