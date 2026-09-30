# Session Calendar, Summaries v2 & Codex Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the PoC "AI Sessions calendar" into Stow: Codex rollouts in the session store, a v2 session summary (title, outcome incl. exploration, kind), a cross-process batch summariser (API + CLI + MCP) and a week/month calendar view on `/sessions` that offers to fill in missing summaries for exactly what is on screen.

**Architecture:** Ingest gains a third source (`codex-ingest.mjs`) that reuses `usage.mjs`'s Codex token logic. The store gains `title`/`title_source`/`user_prompts` columns and a `summary_jobs` table; everything that decides *what a session is* (`effectiveKind`, `displayTitle`, `needsSummary`) lives in small pure modules that both server and client import. The batch runner keeps its state in SQLite so a job started by the MCP server (separate stdio process) is visible to the UI. The calendar is a client component over the same filtered family rows the table uses; its placement maths is a pure, tested module.

**Tech Stack:** Node ≥ 24 ESM, `node:sqlite`, `node:test` + `node:assert/strict`, Next.js 16 App Router (React 19), Tailwind, `date-fns` v4 (already a dependency), local `claude` CLI for summaries, MCP SDK (already used).

**Spec:** `docs/superpowers/specs/2026-09-30-session-calendar-design.md` (incl. the section "Rozhodnutia z revízie proti kódu").

## Global Constraints

- No new dependencies. No calendar library: CSS grid (Tailwind) + `date-fns`.
- Do not change `usage.mjs` behaviour (TRI-STOW-0003 in CLAUDE.md): only extract and export helpers; `npm test` for `usage*.test.mjs` must stay green unchanged.
- Never build `data/` paths by hand: `openStore()` / `dataFile(DB_NAME, STATE)` only; open the DB per request / per call, never at module eval.
- Summaries: `upsertSession` never writes `summary*` columns; `setSummary` is the only writer. Ingest never calls the model. `npm test` never spawns the real `claude` CLI (inject `exec` / `summarizeImpl`).
- Summary JSON v2: `{ "v": 2, "title", "what", "outcome": "done|partial|abandoned|exploration", "improvements" (≤5), "followups" (≤4), "kind_hint", "model", "ms" }`. v1 rows (no `v`) stay readable everywhere.
- Batch model: `CC_SUMMARY_BATCH_MODEL`, default `claude-sonnet-5-5`. Single-session Generate keeps `CC_SUMMARY_MODEL` (default `haiku`). Default batch concurrency 3.
- Estimate fallback when no history: 30 s/session for Sonnet (any non-haiku model), 10 s for haiku; otherwise `ceil(count / concurrency) × median(ms of last 50 summaries of that model)`.
- Sessions whose last write (`ended_at`, else `started_at`) is < 10 min old are never summarised by a batch.
- Calendar: local time, Monday first; week = 7 × 24 h grid; month = the calendar month `[1st, 1st of next)`; maximum view span one month. Default shows only `effectiveKind === 'work'`; a chip shows agent/scheduled/trivial muted.
- Event placement: `end = ended_at` if the span is ≤ 5 h, else `start + max(active_s, 30 min)`; minimum height 15 min.
- Display title priority: `custom` title > `summary.title` > `ai` title > first prompt.
- Codex subagents link to the **root** thread (`session_meta.payload.session_id`), flat families, shown only in the parent's rollup.
- UI copy is English (matches `/sessions`).
- Tests are colocated `<module>.test.mjs`; run one file with `node --disable-warning=ExperimentalWarning --test <file>`, all with `npm test`.

## Review Focus

1. **A session that crosses midnight or was left open overnight** — expect a ≤ 5 h real span drawn on both days (clipped at 00:00), and an overnight desktop session drawn as `max(active, 30 min)` from its start, never a 14-hour block. Pinned in Task 15.
2. **UI and MCP start a batch at the same time, or the process running a batch dies** — expect the second caller to get the running job (not a second job), and a job whose heartbeat is > 60 s old not to block new batches forever. Pinned in Task 9.
3. **Malformed or old data in the `summary` column** (v1 JSON, invalid JSON, `null`) — expect the table, calendar, `effectiveKind` and `displayTitle` to fall back quietly, never throw. Pinned in Task 2.
4. **A Codex rollout without `session_meta`, with a truncated last line, or with a token-count reset mid-file** — expect `null` for the first, a parsed row for the others, with tokens equal to the last cumulative (the same numbers the usage ledger reports). Pinned in Task 4.
5. **The session you are working in right now** — expect it never to be offered or included in the "fill in summaries" batch while it is less than 10 min since its last write. Pinned in Tasks 2 and 9.

---

## File Structure

**Create**
- `src/lib/cc/summary-view.mjs` — client-safe helpers over a session row's summary: `parseSummary`, `summaryVersion`, `displayTitle`, `needsSummary`, `OUTCOME_ICON`, `MIN_AGE_MS`.
- `src/lib/cc/codex-ingest.mjs` — Codex rollout → session row (+ prompt/text helpers reused by the distiller).
- `src/lib/cc/summary-batch.mjs` — selection, estimate, SQLite-backed job runner.
- `src/lib/cc/session-calendar.mjs` — pure calendar maths (periods, slots, day segments, column layout, colours, stats, missing ids, ETA text).
- `src/app/api/sessions/summarize-batch/route.js` (+ `route.test.mjs`) — GET status / POST start.
- `src/app/api/sessions/summarize-batch/estimate/route.js` (+ `route.test.mjs`) — POST `{ids}` → missing + estimate.
- `src/app/sessions/calendar-view.js` — week/month grids + period header.
- `src/app/sessions/summary-banner.js` — the "fill in summaries?" banner and progress.
- `scripts/cc-import-summaries.mjs` (+ `.test.mjs`) — one-off PoC import.

**Modify**
- `src/lib/cc/store.mjs` — columns `title`, `title_source`, `user_prompts`; `summary_jobs` table; `listSessions({since, until})`; `getSessionsByIds`; parent candidates incl. `scheduled`.
- `src/lib/cc/ingest.mjs` — title, `user_prompts`, `scheduled` kind; exports `humanPrompts`, `scheduledTaskName`, `promptTitle`.
- `src/lib/cc/session-link.mjs` — `codex-subagent` child kind, `LINKABLE_KIND_NAMES`, `effectiveKind`.
- `src/lib/usage.mjs` — export `listCodexFiles`, extract `codexBuckets`.
- `src/lib/cc/ingest-run.mjs` — Codex loop, `codexDir`, `loadProjectDirs`, link pass skips explicit-parent kinds.
- `src/lib/cc/session-filters.mjs` — `codex` source; search also matches the display title.
- `src/lib/cc/summary.mjs` — schema/prompt v2, metadata line, facts header, `distillCodex`, Codex branch, `ms`.
- `src/lib/cc/session-tree.mjs` — export `localDay`.
- `src/lib/cc/analytics.mjs` — `perDay` by local day.
- `src/app/api/sessions/route.js` — `since`/`until`.
- `scripts/cc-eval.mjs` — delegates to `summary-batch.mjs`; `--since/--until/--concurrency/--model/--force`.
- `src/mcp/server.mjs`, `src/mcp/server.smoke.mjs` — `list_sessions`, `summarize_sessions`.
- `src/app/sessions/page.js` — view toggle, URL state, range loading, SummaryBlock v2.
- `CLAUDE.md`, `STATUS.md`, `package.json` (script `cc:import-summaries`).

---

# Part A — Store columns, kinds and titles (foundation for F1 + F2)

### Task 1: Store columns + Claude title / human prompts / scheduled kind

**Files:**
- Modify: `src/lib/cc/store.mjs` (SCHEMA, `SESSION_COLS`, `MIGRATION_COLS`, `ensureColumns`, `listParentCandidates`)
- Modify: `src/lib/cc/ingest.mjs`
- Test: `src/lib/cc/ingest.test.mjs`, `src/lib/cc/store.test.mjs`

**Interfaces:**
- Produces: session rows gain `title: string|null`, `title_source: 'custom'|'ai'|'prompt'|null`, `user_prompts: number`; `kind` may be `'scheduled'`.
- Produces (exported from `ingest.mjs`): `humanPrompts(prompts: string[]): string[]`, `scheduledTaskName(prompt: string): string|null`, `promptTitle(prompt: string, max = 80): string|null`.

- [ ] **Step 1: Write the failing ingest tests** — append to `src/lib/cc/ingest.test.mjs`:

```js
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const u = (ts, content) => ({ type: 'user', sessionId: 's', timestamp: ts, cwd: '/p', message: { content } });

test('parseSessionText: custom-title beats ai-title; only human prompts count', () => {
  const r = parseSessionText(jl([
    u('2026-09-01T10:00:00Z', 'fix the login bug'),
    { type: 'ai-title', aiTitle: 'Login bug fix', sessionId: 's' },
    { type: 'custom-title', customTitle: 'My own name', sessionId: 's' },
    u('2026-09-01T10:01:00Z', '<local-command-stdout>ok</local-command-stdout>'),
  ]));
  assert.equal(r.title, 'My own name');
  assert.equal(r.title_source, 'custom');
  assert.equal(r.user_prompts, 1);
  assert.equal(r.kind, 'main');
});

test('parseSessionText: ai-title when no custom title; first human prompt otherwise', () => {
  const a = parseSessionText(jl([u('2026-09-01T10:00:00Z', 'x'), { type: 'ai-title', aiTitle: 'AI name', sessionId: 's' }]));
  assert.deepEqual([a.title, a.title_source], ['AI name', 'ai']);
  const long = 'a'.repeat(200);
  const b = parseSessionText(jl([u('2026-09-01T10:00:00Z', long)]));
  assert.equal(b.title_source, 'prompt');
  assert.equal(b.title.length, 80);
  assert.ok(b.title.endsWith('…'));
});

test('parseSessionText: a scheduled task nobody answered is kind scheduled, titled by task name', () => {
  const r = parseSessionText(jl([u('2026-09-01T05:00:00Z', '<scheduled-task name="yt-digest-daily" file="x">run</scheduled-task>')]));
  assert.equal(r.kind, 'scheduled');
  assert.equal(r.title, 'yt-digest-daily');
  assert.equal(r.user_prompts, 0);
});

test('parseSessionText: a scheduled task the human continued stays main', () => {
  const r = parseSessionText(jl([
    u('2026-09-01T05:00:00Z', '<scheduled-task name="yt-digest-daily">run</scheduled-task>'),
    u('2026-09-01T05:10:00Z', 'now also summarise the third video'),
  ]));
  assert.equal(r.kind, 'main');
  assert.equal(r.user_prompts, 1);
});

test('scheduledTaskName / humanPrompts / promptTitle', () => {
  assert.equal(scheduledTaskName('<scheduled-task file="a" name="n1">'), 'n1');
  assert.equal(scheduledTaskName('hello'), null);
  assert.deepEqual(humanPrompts(['<command-name>/x</command-name>', ' hi ']), [' hi ']);
  assert.equal(promptTitle('  a\n b  '), 'a b');
  assert.equal(promptTitle(''), null);
});
```

Update the import line of the test file to `import { parseSessionText, humanPrompts, scheduledTaskName, promptTitle } from './ingest.mjs';`.

- [ ] **Step 2: Write the failing store tests** — append to `src/lib/cc/store.test.mjs`:

```js
test('openStore migrates title/title_source/user_prompts and forces a re-parse', () => {
  const raw = new DatabaseSync(':memory:');
  // An older DB: has kind (phase 1b) but not the title columns. project_dir/started_at are needed by SCHEMA's indexes.
  raw.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_dir TEXT, started_at TEXT, kind TEXT, entrypoint TEXT, parent_session_id TEXT)");
  raw.exec("CREATE TABLE ingest_state (path TEXT PRIMARY KEY, session_id TEXT, signature TEXT, ingested_at TEXT)");
  raw.exec("INSERT INTO ingest_state VALUES ('/f', 's', 'sig', 'now')");
  const db = openStore(raw);
  const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  for (const c of ['title', 'title_source', 'user_prompts']) assert.ok(cols.has(c), c);
  assert.equal(db.prepare('SELECT count(*) n FROM ingest_state').get().n, 0);
});

test('upsertSession stores title columns; scheduled sessions are parent candidates', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'p', kind: 'scheduled', entrypoint: 'claude-desktop', started_at: '2026-09-01T05:00:00Z', ended_at: '2026-09-01T05:30:00Z', title: 'yt', title_source: 'prompt', user_prompts: 0 });
  assert.equal(getSession(db, 'p').session.title, 'yt');
  const c = listParentCandidates(db, { started_at: '2026-09-01T05:10:00Z' });
  assert.deepEqual(c.map((r) => r.session_id), ['p']);
});
```

Add `DatabaseSync` (from `node:sqlite`), `getSession`, `listParentCandidates` to the file's imports if missing.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest.test.mjs src/lib/cc/store.test.mjs`
Expected: FAIL — `humanPrompts is not a function` / missing columns / candidate list empty.

- [ ] **Step 4: Implement the store changes** in `src/lib/cc/store.mjs`:

```js
// SESSION_COLS: append after 'kind', 'entrypoint',
  'title', 'title_source', 'user_prompts',

// MIGRATION_COLS: add
  title: 'TEXT', title_source: 'TEXT', user_prompts: 'INTEGER',
```

Add the three columns to the `CREATE TABLE sessions` statement too (after `entrypoint TEXT`): `, title TEXT, title_source TEXT, user_prompts INTEGER`.

In `ensureColumns`, next to the existing `kind` reset:

```js
  // title/user_prompts only get filled by a re-parse as well.
  if (!have.has('title') && have.size > 0) db.exec('DELETE FROM ingest_state');
```

In `listParentCandidates` replace `WHERE kind = 'main'` with `WHERE kind IN ('main', 'scheduled')` and update its doc comment ("every Claude Code main or scheduled session …").

- [ ] **Step 5: Implement the parser changes** in `src/lib/cc/ingest.mjs` — add helpers above `parseSessionText`:

```js
/** Prompts a human typed. Harness/hook-injected ones start with a tag (`<scheduled-task`, `<command-name>`, `<local-command-stdout>`, …). */
export function humanPrompts(prompts) {
  return (prompts || []).filter((p) => !String(p).trimStart().startsWith('<'));
}

const SCHEDULED_RE = /^<scheduled-task\b[^>]*?\bname="([^"]+)"/;

/** `<scheduled-task name="yt-digest-daily" …>` → 'yt-digest-daily'; null for any other prompt. */
export function scheduledTaskName(prompt) {
  const m = SCHEDULED_RE.exec(String(prompt || '').trimStart());
  return m ? m[1] : null;
}

/** One-line title from a prompt, clipped to `max` characters. */
export function promptTitle(prompt, max = 80) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Claude Code metadata lines: the last `custom-title` (set by the user) wins over the last `ai-title`. */
function transcriptTitle(lines) {
  let custom = null, ai = null;
  for (const d of lines) {
    if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle.trim()) custom = d.customTitle.trim();
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) ai = d.aiTitle.trim();
  }
  if (custom) return { title: custom, title_source: 'custom' };
  if (ai) return { title: ai, title_source: 'ai' };
  return null;
}
```

Replace the `firstPrompt` / `kind` block in `parseSessionText` with:

```js
  // First prompt: hook-spawned SDK sessions and scheduled tasks announce themselves in it.
  const prompts = userPrompts(lines);
  const human = humanPrompts(prompts);
  const firstPrompt = prompts[0] || lines.find((d) => d.type === 'queue-operation' && typeof d.content === 'string')?.content || '';
  let kind = classifyKind({ entrypoint, firstPrompt });
  const taskName = scheduledTaskName(firstPrompt);
  // A scheduled run the human then continued is ordinary work (PoC rule).
  if (kind === 'main' && taskName && human.length === 0) kind = 'scheduled';
  const titled = transcriptTitle(lines)
    || (taskName ? { title: taskName, title_source: 'prompt' } : null)
    || (human[0] ? { title: promptTitle(human[0]), title_source: 'prompt' } : { title: null, title_source: null });
```

and add to the returned object (after `kind, entrypoint,`): `...titled, user_prompts: human.length,`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest.test.mjs src/lib/cc/store.test.mjs src/lib/cc/ingest-run.test.mjs`
Expected: PASS (ingest-run included to prove the old flows still work).

- [ ] **Step 7: Commit**

```bash
git add src/lib/cc/store.mjs src/lib/cc/ingest.mjs src/lib/cc/ingest.test.mjs src/lib/cc/store.test.mjs
git commit -m "feat(cc): session title, human prompt count and scheduled kind at ingest"
```

---

### Task 2: `summary-view.mjs` + `effectiveKind`

**Files:**
- Create: `src/lib/cc/summary-view.mjs`, `src/lib/cc/summary-view.test.mjs`
- Modify: `src/lib/cc/session-link.mjs`, `src/lib/cc/session-link.test.mjs`

**Interfaces:**
- Consumes: row fields from Task 1 (`title`, `title_source`, `user_prompts`, `kind`).
- Produces (`summary-view.mjs`, client-safe, no Node imports):
  - `MIN_AGE_MS = 600000`
  - `OUTCOME_ICON = { done: '✅', partial: '🟡', abandoned: '⛔', exploration: '🔍' }`
  - `parseSummary(row): object|null`
  - `summaryVersion(row): 0|1|2` (0 = none/unreadable, 1 = legacy, n = `summary.v`)
  - `displayTitle(row): string|null`
  - `needsSummary(row, { force?: false|true|'upgrade', now?: number }): boolean`
- Produces (`session-link.mjs`):
  - `CHILD_KINDS['codex-subagent'] = { label: 'codex subagent', explicitParent: true, test: () => false }`
  - `LINKABLE_KIND_NAMES: string[]` (child kinds without `explicitParent`)
  - `EFFECTIVE_KINDS = ['work', 'scheduled', 'agent-spawn', 'trivial']`
  - `effectiveKind(row): 'work'|'scheduled'|'agent-spawn'|'trivial'`

- [ ] **Step 1: Write the failing tests** — `src/lib/cc/summary-view.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary, summaryVersion, displayTitle, needsSummary, MIN_AGE_MS } from './summary-view.mjs';

const v2 = JSON.stringify({ v: 2, title: 'LLM title', what: 'w', outcome: 'done' });
const v1 = JSON.stringify({ what: 'w', outcome: 'done' });

test('parseSummary / summaryVersion tolerate null, v1 and broken JSON', () => {
  assert.equal(parseSummary({ summary: null }), null);
  assert.equal(parseSummary({ summary: '{nope' }), null);
  assert.equal(parseSummary({ summary: '"str"' }), null);
  assert.equal(summaryVersion({ summary: null }), 0);
  assert.equal(summaryVersion({ summary: '{nope' }), 0);
  assert.equal(summaryVersion({ summary: v1 }), 1);
  assert.equal(summaryVersion({ summary: v2 }), 2);
});

test('displayTitle: custom > summary > ai > prompt', () => {
  assert.equal(displayTitle({ title: 'Mine', title_source: 'custom', summary: v2 }), 'Mine');
  assert.equal(displayTitle({ title: 'AI', title_source: 'ai', summary: v2 }), 'LLM title');
  assert.equal(displayTitle({ title: 'AI', title_source: 'ai', summary: v1 }), 'AI');
  assert.equal(displayTitle({ title: 'first prompt', title_source: 'prompt', summary: '{bad' }), 'first prompt');
  assert.equal(displayTitle({}), null);
});

test('needsSummary skips fresh sessions, rows without transcript, and already summarised ones', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const old = { raw_ref: '/t', ended_at: '2026-09-30T11:00:00Z' };
  assert.equal(needsSummary(old, { now }), true);
  assert.equal(needsSummary({ ...old, raw_ref: null }, { now }), false);
  assert.equal(needsSummary({ raw_ref: '/t', ended_at: new Date(now - MIN_AGE_MS + 1000).toISOString() }, { now }), false);
  assert.equal(needsSummary({ raw_ref: '/t', ended_at: null, started_at: '2026-09-30T11:00:00Z' }, { now }), true);
  assert.equal(needsSummary({ ...old, summary: v1 }, { now }), false);
  assert.equal(needsSummary({ ...old, summary: v1 }, { now, force: 'upgrade' }), true);
  assert.equal(needsSummary({ ...old, summary: v2 }, { now, force: 'upgrade' }), false);
  assert.equal(needsSummary({ ...old, summary: v2 }, { now, force: true }), true);
});
```

Append to `src/lib/cc/session-link.test.mjs`:

```js
import { effectiveKind, LINKABLE_KIND_NAMES, CHILD_KINDS } from './session-link.mjs';

test('effectiveKind: structure first, then scheduled, sdk, LLM hint, default work', () => {
  assert.equal(effectiveKind({ parent_session_id: 'x' }), 'agent-spawn');
  assert.equal(effectiveKind({ kind: 'security-review' }), 'agent-spawn');
  assert.equal(effectiveKind({ kind: 'codex-subagent' }), 'agent-spawn');
  assert.equal(effectiveKind({ kind: 'scheduled' }), 'scheduled');
  assert.equal(effectiveKind({ kind: 'main', entrypoint: 'sdk-py', user_prompts: 1 }), 'agent-spawn');
  assert.equal(effectiveKind({ kind: 'main', entrypoint: 'sdk-py', user_prompts: 3 }), 'work');
  assert.equal(effectiveKind({ kind: 'main', summary: JSON.stringify({ v: 2, kind_hint: 'trivial' }) }), 'trivial');
  assert.equal(effectiveKind({ kind: 'main', summary: JSON.stringify({ v: 2, kind_hint: 'bogus' }) }), 'work');
  assert.equal(effectiveKind({ kind: 'main', summary: '{broken' }), 'work');
  assert.equal(effectiveKind({}), 'work');
});

test('codex-subagent is a child kind but never linked by timing', () => {
  assert.ok(CHILD_KINDS['codex-subagent'].explicitParent);
  assert.ok(!LINKABLE_KIND_NAMES.includes('codex-subagent'));
  assert.ok(LINKABLE_KIND_NAMES.includes('security-review'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary-view.test.mjs src/lib/cc/session-link.test.mjs`
Expected: FAIL — module not found / `effectiveKind` not exported.

- [ ] **Step 3: Create `src/lib/cc/summary-view.mjs`**

```js
/**
 * Read-side helpers over a session row's AI summary. Pure and client-safe (no
 * Node imports): the /sessions page, the calendar, the batch runner and the MCP
 * server all decide "has a summary / which title / should it be summarised"
 * with the same code.
 *
 * `summary` is a JSON string: v1 = { what, outcome, improvements, followups, model },
 * v2 adds { v: 2, title, kind_hint, ms } and the `exploration` outcome.
 */

/** A session written to in the last 10 minutes may still be running: never batch-summarise it. */
export const MIN_AGE_MS = 10 * 60 * 1000;

export const OUTCOME_ICON = { done: '✅', partial: '🟡', abandoned: '⛔', exploration: '🔍' };

export function parseSummary(row) {
  if (!row?.summary) return null;
  try {
    const v = JSON.parse(row.summary);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 0 = no (readable) summary, 1 = legacy v1, otherwise `summary.v`. */
export function summaryVersion(row) {
  const s = parseSummary(row);
  if (!s) return 0;
  return Number.isInteger(s.v) && s.v > 1 ? s.v : 1;
}

/** Title shown in lists and the calendar: the user's own name > the summary's > Claude's ai-title > first prompt. */
export function displayTitle(row) {
  if (!row) return null;
  if (row.title_source === 'custom' && row.title) return row.title;
  const t = parseSummary(row)?.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return row.title || null;
}

/**
 * Should a batch summarise this row?
 * @param {{force?: false|true|'upgrade', now?: number}} opts  `upgrade` re-does v1 summaries, `true` redoes all
 */
export function needsSummary(row, { force = false, now = Date.now() } = {}) {
  if (!row?.raw_ref) return false;
  const last = Date.parse(row.ended_at || row.started_at || '');
  if (!Number.isFinite(last) || now - last < MIN_AGE_MS) return false;
  const v = summaryVersion(row);
  if (force === true) return true;
  if (force === 'upgrade') return v < 2;
  return v === 0;
}
```

- [ ] **Step 4: Extend `src/lib/cc/session-link.mjs`**

Add to `CHILD_KINDS` (after `security-review`):

```js
  // Codex subagents name their parent in session_meta; ingest links them
  // directly (explicitParent), so the timing heuristic never looks at them.
  'codex-subagent': {
    label: 'codex subagent',
    explicitParent: true,
    test: () => false,
  },
```

Below `CHILD_KIND_NAMES`:

```js
/** Child kinds whose parent must be inferred by timing (see linkChildren in ingest-run.mjs). */
export const LINKABLE_KIND_NAMES = Object.entries(CHILD_KINDS).filter(([, d]) => !d.explicitParent).map(([k]) => k);

/** What a session *is* for the calendar and the batch summariser. */
export const EFFECTIVE_KINDS = ['work', 'scheduled', 'agent-spawn', 'trivial'];

/**
 * Structure beats heuristics: a linked or child session is an agent spawn, a
 * scheduled run nobody answered is scheduled, an SDK session with at most one
 * prompt is machine-driven; only then the summary's `kind_hint` (e.g. persona
 * reviews in Antigravity that nothing else distinguishes); default work.
 */
export function effectiveKind(row) {
  if (!row) return 'work';
  if (row.parent_session_id || CHILD_KINDS[row.kind]) return 'agent-spawn';
  if (row.kind === 'scheduled') return 'scheduled';
  if (/^sdk/.test(row.entrypoint || '') && (row.user_prompts ?? 0) <= 1) return 'agent-spawn';
  const hint = parseSummary(row)?.kind_hint;
  return EFFECTIVE_KINDS.includes(hint) ? hint : 'work';
}
```

and at the top: `import { parseSummary } from './summary-view.mjs';`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary-view.test.mjs src/lib/cc/session-link.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/cc/summary-view.mjs src/lib/cc/summary-view.test.mjs src/lib/cc/session-link.mjs src/lib/cc/session-link.test.mjs
git commit -m "feat(cc): effectiveKind, display title and summary helpers"
```

---

# Part B — F1 Codex ingest

### Task 3: Export Codex helpers from `usage.mjs`

**Files:**
- Modify: `src/lib/usage.mjs` (`listCodexFiles`, `addSession`)
- Test: `src/lib/usage.test.mjs` (append)

**Interfaces:**
- Produces: `export async function listCodexFiles(codexDir): Promise<string[]>` (unchanged body), `export function codexBuckets(st): Record<model, {input, cachedInput, output}>` — a **copy** of `st.codexByModel` plus an `unknown` bucket holding whatever the per-model buckets do not cover of `st.codex` (conservation guard).

- [ ] **Step 1: Write the failing test** — append to `src/lib/usage.test.mjs`:

```js
import { codexBuckets } from './usage.mjs';

test('codexBuckets copies per-model buckets and puts the uncovered remainder in unknown', () => {
  const st = { codex: { input: 100, cachedInput: 40, output: 10 }, codexByModel: { 'gpt-5.5': { input: 60, cachedInput: 40, output: 10 } } };
  const b = codexBuckets(st);
  assert.deepEqual(b['gpt-5.5'], { input: 60, cachedInput: 40, output: 10 });
  assert.deepEqual(b.unknown, { input: 40, cachedInput: 0, output: 0 });
  b['gpt-5.5'].input = 0;
  assert.equal(st.codexByModel['gpt-5.5'].input, 60, 'state must not be mutated');
  assert.deepEqual(codexBuckets({ codex: { input: 5, cachedInput: 0, output: 1 } }), { unknown: { input: 5, cachedInput: 0, output: 1 } });
  assert.deepEqual(codexBuckets({ codex: null }), {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/usage.test.mjs`
Expected: FAIL — `codexBuckets` is not exported.

- [ ] **Step 3: Implement** — in `src/lib/usage.mjs`: change `async function listCodexFiles(` to `export async function listCodexFiles(`. Add above `addSession`:

```js
// Per-model Codex buckets for one file state, as a COPY (`st` is the persisted
// cache state). Conservation guard: per-model deltas re-sum to the cumulative
// total in practice, but a legacy state carries no buckets at all, and a
// truncated or rewritten transcript could leave a gap. Anything the buckets
// don't cover goes to `unknown`, so the per-model view always re-sums to
// `st.codex` and no tokens are silently dropped. Shared with cc/codex-ingest.mjs.
export function codexBuckets(st) {
  if (!st?.codex) return {}
  const t = { input: st.codex.input || 0, cachedInput: st.codex.cachedInput || 0, output: st.codex.output || 0 }
  const buckets = {}
  const covered = { input: 0, cachedInput: 0, output: 0 }
  for (const [id, b] of Object.entries(st.codexByModel || {})) {
    const c = { input: b.input || 0, cachedInput: b.cachedInput || 0, output: b.output || 0 }
    buckets[id] = c
    covered.input += c.input; covered.cachedInput += c.cachedInput; covered.output += c.output
  }
  const rem = {
    input: Math.max(0, t.input - covered.input),
    cachedInput: Math.max(0, t.cachedInput - covered.cachedInput),
    output: Math.max(0, t.output - covered.output),
  }
  if (rem.input || rem.cachedInput || rem.output) {
    const u = buckets.unknown ??= { input: 0, cachedInput: 0, output: 0 }
    u.input += rem.input; u.cachedInput += rem.cachedInput; u.output += rem.output
  }
  return buckets
}
```

In `addSession`'s `else if (st.codex)` branch, replace everything from `// COPY the per-model buckets` down to (and including) the closing `}` of the `if (rem.input || …)` block with a single line `const buckets = codexBuckets(st)`. Keep the `t` totals and the pricing loop exactly as they are.

- [ ] **Step 4: Run all usage tests**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/usage*.test.mjs`
Expected: PASS (every pre-existing usage test unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage.mjs src/lib/usage.test.mjs
git commit -m "refactor(usage): export listCodexFiles and codexBuckets for the session store"
```

---

### Task 4: `codex-ingest.mjs` — rollout → session row

**Files:**
- Create: `src/lib/cc/codex-ingest.mjs`, `src/lib/cc/codex-ingest.test.mjs`

**Interfaces:**
- Consumes: `newFileState`, `parseCodexLines`, `codexBuckets` (usage.mjs, Task 3); `costForCodex(t, modelId)` (usage-pricing.mjs); `promptTitle` (ingest.mjs, Task 1); `DEFAULT_TICKET_RE` (context.mjs).
- Produces:
  - `normalizeOriginator(originator: string): 'cli'|'desktop'|'vscode'|'t3code'|'other'`
  - `deepestProject(dir: string, projectDirs: string[]): string|null`
  - `contentText(content): string` and `isInjectedPrompt(text): boolean` (reused by `distillCodex` in Task 7)
  - `codexUserPrompts(lines: object[]): string[]`
  - `parseCodexSession(text, { rawRef?, projectDirs?, ticketPattern? }): row|null` — a store `sessions` row plus `_tools`, `_skills` (`{}`), `_editedSkills` (`Set`), `_parent` (root thread id or `null`), `_lines`. `kind` is `'main'` or `'codex-subagent'`; `entrypoint` is `codex-<normalized originator>`; `quality_score` is `null`.

- [ ] **Step 1: Write the failing tests** — `src/lib/cc/codex-ingest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexSession, normalizeOriginator, deepestProject, codexUserPrompts } from './codex-ingest.mjs';
import { costForCodex } from '../usage-pricing.mjs';

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const meta = (payload) => ({ timestamp: '2026-09-09T10:00:00.000Z', type: 'session_meta', payload: { id: 'thr-1', session_id: 'thr-1', cwd: '/p/app/src', originator: 'codex_work_desktop', source: 'vscode', git: { branch: 'feat/TRI-12-login', repository_url: 'git@github.com:o/r.git' }, ...payload } });
const msg = (ts, role, text) => ({ timestamp: ts, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const tokens = (ts, input, cached, output) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
const ev = (ts, type, extra = {}) => ({ timestamp: ts, type: 'event_msg', payload: { type, ...extra } });

const main = jl([
  meta({}),
  msg('2026-09-09T10:00:01Z', 'user', '# AGENTS.md instructions for /p/app\n<INSTRUCTIONS>x</INSTRUCTIONS>'),
  msg('2026-09-09T10:00:01Z', 'user', '<environment_context>\n<cwd>/p/app</cwd>\n</environment_context>'),
  { timestamp: '2026-09-09T10:00:02Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
  ev('2026-09-09T10:00:02Z', 'task_started'),
  msg('2026-09-09T10:00:02Z', 'user', 'set the default dev port to 3371'),
  { timestamp: '2026-09-09T10:00:05Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg PORT"}' } },
  { timestamp: '2026-09-09T10:00:09Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /p/app/package.json\n*** End Patch' } },
  tokens('2026-09-09T10:00:10Z', 1000, 400, 50),
  ev('2026-09-09T10:00:11Z', 'task_complete', { last_agent_message: 'Port set to 3371.' }),
  msg('2026-09-09T10:02:00Z', 'user', 'and update the README'),
  tokens('2026-09-09T10:02:10Z', 1500, 900, 80),
  ev('2026-09-09T10:02:11Z', 'task_complete', { last_agent_message: 'README updated.' }),
]);

test('parseCodexSession: main desktop session', () => {
  const r = parseCodexSession(main, { rawRef: '/r.jsonl', projectDirs: ['/p', '/p/app'] });
  assert.equal(r.session_id, 'thr-1');
  assert.equal(r.kind, 'main');
  assert.equal(r._parent, null);
  assert.equal(r.entrypoint, 'codex-desktop');
  assert.equal(r.project_dir, '/p/app');
  assert.equal(r.cwd, '/p/app/src');
  assert.equal(r.git_branch, 'feat/TRI-12-login');
  assert.equal(r.git_repo, 'git@github.com:o/r.git');
  assert.deepEqual([r.ticket_id, r.ticket_source], ['TRI-12', 'branch']);
  assert.equal(r.model, 'gpt-5.5');
  assert.equal(r.turns, 2);
  assert.deepEqual(r._tools, { exec_command: 1, apply_patch: 1 });
  assert.equal(r.title, 'set the default dev port to 3371');
  assert.equal(r.title_source, 'prompt');
  assert.equal(r.user_prompts, 2);
  assert.equal(r.input_tokens, 1500 - 900);
  assert.equal(r.cache_read, 900);
  assert.equal(r.output_tokens, 80);
  assert.equal(r.cost_usd, costForCodex({ input: 1500, cachedInput: 900, output: 80 }, 'gpt-5.5'));
  assert.equal(r.started_at, '2026-09-09T10:00:00.000Z');
  assert.equal(r.ended_at, '2026-09-09T10:02:11Z');
  assert.equal(r.quality_score, null);
  assert.equal(r.raw_ref, '/r.jsonl');
});

test('parseCodexSession: subagents link to the root thread, not the direct parent', () => {
  const sub = jl([meta({ id: 'thr-3', session_id: 'thr-1', source: { subagent: { thread_spawn: { parent_thread_id: 'thr-2', depth: 2 } } } })]);
  const r = parseCodexSession(sub);
  assert.equal(r.kind, 'codex-subagent');
  assert.equal(r._parent, 'thr-1');
  const legacy = jl([meta({ id: 'thr-3', session_id: undefined, source: { subagent: { thread_spawn: { parent_thread_id: 'thr-2' } } } })]);
  assert.equal(parseCodexSession(legacy)._parent, 'thr-2');
});

test('parseCodexSession: token reset keeps the last cumulative; truncated tail is ignored', () => {
  const text = jl([meta({}), { timestamp: '2026-09-09T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    tokens('2026-09-09T10:00:02Z', 100, 0, 10), tokens('2026-09-09T10:00:03Z', 30, 0, 5)]) + '\n{"timestamp":"2026-09-09T10:00:04Z","type":"ev';
  const r = parseCodexSession(text);
  assert.equal(r.input_tokens, 30);
  assert.equal(r.output_tokens, 5);
});

test('parseCodexSession: no session_meta → null', () => {
  assert.equal(parseCodexSession(jl([msg('2026-09-09T10:00:00Z', 'user', 'hi')])), null);
  assert.equal(parseCodexSession(''), null);
});

test('normalizeOriginator / deepestProject / codexUserPrompts', () => {
  assert.equal(normalizeOriginator('codex_work_desktop'), 'desktop');
  assert.equal(normalizeOriginator('Codex Desktop'), 'desktop');
  assert.equal(normalizeOriginator('codex-tui'), 'cli');
  assert.equal(normalizeOriginator('codex_cli_rs'), 'cli');
  assert.equal(normalizeOriginator('t3code_desktop'), 't3code');
  assert.equal(normalizeOriginator(undefined), 'other');
  assert.equal(deepestProject('/p/app/src', ['/p', '/p/app']), '/p/app');
  assert.equal(deepestProject('/q', ['/p']), null);
  assert.equal(deepestProject('/p/appx', ['/p/app']), null);
  assert.deepEqual(codexUserPrompts([JSON.parse(JSON.stringify(msg('t', 'user', 'real')))]), ['real']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/codex-ingest.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/cc/codex-ingest.mjs`**

```js
/**
 * Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, written by the
 * Codex CLI, Codex desktop and t3code) → session-store rows.
 *
 * Tokens, model and active time come from usage.mjs (`parseCodexLines` +
 * `codexBuckets`) so the store reports exactly what the usage ledger reports,
 * including its handling of duplicate token events and mid-rollout resets.
 * Everything else is read from the rollout's own events:
 *   session_meta  → id, cwd, git branch/repo, originator, subagent parent
 *   task_complete → turns (fallback task_started)
 *   function_call / custom_tool_call → tool counts
 *   message(role=user), minus injected context → prompts / title
 *
 * Subagents carry their parent in `session_meta.source.subagent`; we link them
 * to the ROOT thread (`session_meta.session_id`) so families stay one level
 * deep (depth-2 subagents exist). No quality score yet (Claude-only heuristic).
 */
import { newFileState, parseCodexLines, codexBuckets } from '../usage.mjs';
import { costForCodex } from '../usage-pricing.mjs';
import { DEFAULT_TICKET_RE } from './context.mjs';
import { promptTitle } from './ingest.mjs';

/** Harness-injected "user" messages: AGENTS.md, <environment_context>, <permissions …>, … */
const INJECTED_RE = /^\s*(?:<|#\s*AGENTS\.md instructions)/;

export function isInjectedPrompt(text) {
  return INJECTED_RE.test(String(text || ''));
}

export function normalizeOriginator(originator) {
  const o = String(originator || '').toLowerCase();
  if (o.includes('t3code')) return 't3code';
  if (o.includes('desktop')) return 'desktop';
  if (o.includes('vscode')) return 'vscode';
  if (o.includes('tui') || o.includes('cli') || o.includes('exec')) return 'cli';
  return 'other';
}

/** The most specific known project containing `dir` (same rule as the Gemini ingest). */
export function deepestProject(dir, projectDirs = []) {
  if (!dir) return null;
  let best = null;
  for (const p of projectDirs || []) {
    if ((dir === p || dir.startsWith(p + '/')) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** Text of a response_item `content` array (input_text / output_text parts). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

export function codexUserPrompts(lines) {
  const out = [];
  for (const d of lines || []) {
    const p = d?.payload;
    if (d?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') continue;
    const t = contentText(p.content).trim();
    if (t && !isInjectedPrompt(t)) out.push(t);
  }
  return out;
}

function toSeconds(a, b) {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0;
}

/**
 * @param {string} text raw rollout JSONL
 * @param {{rawRef?: string|null, projectDirs?: string[], ticketPattern?: RegExp}} opts
 * @returns session row + `_tools`, `_skills`, `_editedSkills`, `_parent`, `_lines`; null without session_meta
 */
export function parseCodexSession(text, { rawRef = null, projectDirs = [], ticketPattern = DEFAULT_TICKET_RE } = {}) {
  const rawLines = String(text || '').split('\n').filter((l) => l.trim());
  const lines = [];
  for (const l of rawLines) {
    try { const d = JSON.parse(l); if (d && typeof d === 'object') lines.push(d); } catch { /* truncated tail */ }
  }
  const meta = lines.find((d) => d.type === 'session_meta')?.payload;
  if (!meta?.id) return null;

  const state = newFileState('codex');
  parseCodexLines(rawLines, state);
  const tok = { input: 0, cachedInput: 0, output: 0 };
  let cost = 0, priced = false, model = null, bestOut = -1;
  for (const [id, b] of Object.entries(codexBuckets(state))) {
    tok.input += b.input; tok.cachedInput += b.cachedInput; tok.output += b.output;
    const c = costForCodex(b, id);
    if (c != null) { cost += c; priced = true; }
    if (id !== 'unknown' && b.output > bestOut) { bestOut = b.output; model = id; }
  }

  const tools = {};
  let completes = 0, starts = 0;
  for (const d of lines) {
    const p = d.payload || {};
    if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) tools[p.name] = (tools[p.name] || 0) + 1;
    if (d.type === 'event_msg' && p.type === 'task_complete') completes++;
    if (d.type === 'event_msg' && p.type === 'task_started') starts++;
  }

  const sub = meta.source && typeof meta.source === 'object' ? meta.source.subagent : null;
  const parent = sub
    ? (meta.session_id && meta.session_id !== meta.id ? meta.session_id : sub.thread_spawn?.parent_thread_id ?? null)
    : null;
  const prompts = codexUserPrompts(lines);
  const branch = meta.git?.branch || null;
  const ticket = branch ? branch.match(ticketPattern)?.[0] ?? null : null;
  const started = meta.timestamp || state.firstTs || null;
  const ended = state.lastTs || null;

  return {
    session_id: meta.id,
    project_dir: deepestProject(meta.cwd, projectDirs) || meta.cwd || null,
    cwd: meta.cwd || null,
    model: model || state.codexModel || null,
    started_at: started, ended_at: ended,
    duration_s: started && ended ? toSeconds(started, ended) : 0,
    active_s: state.activeSeconds || 0,
    // Claude semantics: input_tokens excludes cache reads.
    input_tokens: Math.max(0, tok.input - tok.cachedInput), output_tokens: tok.output, cache_read: tok.cachedInput,
    cache_write_5m: 0, cache_write_1h: 0,
    cost_usd: priced ? cost : null,
    turns: completes || starts,
    status: ended ? 'done' : 'unknown',
    git_branch: branch, git_repo: meta.git?.repository_url || null, pr: null,
    ticket_id: ticket, ticket_source: ticket ? 'branch' : null,
    quality_score: null, quality_detail: null,
    kind: sub ? 'codex-subagent' : 'main',
    entrypoint: `codex-${normalizeOriginator(meta.originator)}`,
    title: promptTitle(prompts[0]), title_source: prompts[0] ? 'prompt' : null, user_prompts: prompts.length,
    raw_ref: rawRef, ingested_at: new Date().toISOString(),
    _tools: tools, _skills: {}, _editedSkills: new Set(), _parent: parent, _lines: lines,
  };
}
```

Note: `started_at` uses `session_meta.payload.timestamp` (when the thread was created — it precedes the first event line). The test fixture's payload has no `timestamp`, so it falls back to the first event's timestamp `2026-09-09T10:00:00.000Z`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/codex-ingest.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/codex-ingest.mjs src/lib/cc/codex-ingest.test.mjs
git commit -m "feat(cc): parse Codex rollouts into session rows"
```

---

### Task 5: Codex loop in `ingestAll` + `codex` source filter

**Files:**
- Modify: `src/lib/cc/ingest-run.mjs`, `src/lib/cc/session-filters.mjs`
- Test: `src/lib/cc/ingest-run.test.mjs`, `src/lib/cc/session-filters.test.mjs`

**Interfaces:**
- Consumes: `listCodexFiles` (Task 3), `parseCodexSession` (Task 4), `LINKABLE_KIND_NAMES` (Task 2), `setParent`.
- Produces: `defaultIngestPaths()` returns `codexDir` (`CC_CODEX_DIR`, default `~/.codex/sessions`); `ingestAll({ codexDir })`; `sourceOf(row) === 'codex'` for `codex-*` entrypoints; `SOURCE_FILTERS.codex = 'Codex'`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/cc/ingest-run.test.mjs`:

```js
async function codexFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccx-'));
  const day = join(root, 'sessions', '2026', '09', '09');
  await mkdir(day, { recursive: true });
  const line = (o) => JSON.stringify(o);
  const meta = (p) => ({ timestamp: '2026-09-09T10:00:00.000Z', type: 'session_meta', payload: { cwd: '/p/app', originator: 'codex-tui', source: 'cli', ...p } });
  await writeFile(join(day, 'rollout-a-root.jsonl'), [
    line(meta({ id: 'root', session_id: 'root' })),
    line({ timestamp: '2026-09-09T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] } }),
    line({ timestamp: '2026-09-09T10:00:09Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));
  await writeFile(join(day, 'rollout-b-sub.jsonl'), [
    line(meta({ id: 'sub', session_id: 'root', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } })),
    line({ timestamp: '2026-09-09T10:00:05Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));
  return join(root, 'sessions');
}

test('ingestAll ingests Codex rollouts and links subagents to their root thread', async () => {
  const codexDir = await codexFixture();
  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: null, codexDir, guardAudit: '/nope', db, projectDirs: ['/p/app'] });
  assert.equal(res.changed, 2);
  const got = getSession(db, 'root');
  assert.equal(got.session.entrypoint, 'codex-cli');
  assert.equal(got.session.project_dir, '/p/app');
  assert.deepEqual(got.children.map((c) => c.session_id), ['sub']);
  assert.deepEqual(listSessions(db).filter((s) => !s.parent_session_id).map((s) => s.session_id), ['root']);
  const again = await ingestAll({ claudeDir: null, codexDir, guardAudit: '/nope', db, projectDirs: ['/p/app'] });
  assert.equal(again.skipped, 2);
  assert.equal(getSession(db, 'sub').session.parent_session_id, 'root', 'link survives the incremental run');
});
```

Append to `src/lib/cc/session-filters.test.mjs`:

```js
test('sourceOf buckets Codex entrypoints', () => {
  assert.equal(sourceOf({ entrypoint: 'codex-desktop' }), 'codex');
  assert.equal(SOURCE_FILTERS.codex, 'Codex');
  assert.equal(filterSessions([{ entrypoint: 'codex-cli' }, { entrypoint: 'cli' }], { source: 'codex' }).length, 1);
});
```

(Add `sourceOf`, `SOURCE_FILTERS` to that file's import if missing.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest-run.test.mjs src/lib/cc/session-filters.test.mjs`
Expected: FAIL — `res.changed` 0 / `'other' !== 'codex'`.

- [ ] **Step 3: Implement in `src/lib/cc/ingest-run.mjs`**

Imports: add `import { listCodexFiles } from '../usage.mjs';`, `import { parseCodexSession } from './codex-ingest.mjs';`; change `import { CHILD_KIND_NAMES, pickParent, turnEndTimestamps }` to `import { LINKABLE_KIND_NAMES, pickParent, turnEndTimestamps }`, and in `linkChildren` use `listUnlinked(db, LINKABLE_KIND_NAMES, { since })`.

`defaultIngestPaths`: add `codexDir: env.CC_CODEX_DIR || join(homedir(), '.codex', 'sessions'),`.

Extract the ledger read out of the Gemini block into a helper (and use it there):

```js
/** Known project dirs (for mapping a cwd to its project): explicit list, else the scanned ledger. */
async function loadProjectDirs(projectDirs) {
  if (projectDirs) return projectDirs;
  const out = [];
  try {
    for (const line of (await readFile(ledgerFile(), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { const d = JSON.parse(line); if (d.directory) out.push(d.directory); } catch { /* skip */ }
    }
  } catch { /* ledger missing */ }
  return out;
}
```

In the Gemini block replace the inline `let projects = projectDirs; if (!projects) { … }` with `const projects = await loadProjectDirs(projectDirs);`.

Add `codexDir = null,` to `ingestAll`'s destructured params and, after the Gemini block and before `linkChildren`:

```js
  if (codexDir) {
    const files = await listCodexFiles(codexDir);
    const projects = files.length ? await loadProjectDirs(projectDirs) : [];
    for (const file of files) {
      let s;
      try { s = await stat(file); } catch { continue; }
      const signature = `${basename(file)}:${s.size}:${Math.floor(s.mtimeMs / 1000)}`;
      const prev = state.get(file);
      if (prev && prev.signature === signature && prev.session_id) { sessions++; skipped++; continue; }
      let text;
      try { text = await readFile(file, 'utf8'); } catch { continue; }
      const row = parseCodexSession(text, { rawRef: file, projectDirs: projects, ticketPattern });
      if (!row) continue;
      db.exec('BEGIN');
      try {
        upsertSession(db, row);
        replaceTools(db, row.session_id, row._tools);
        replaceSkills(db, row.session_id, row._skills, row._editedSkills);
        replaceGuardHits(db, row.session_id, []); // cc-guard only sees Claude Code
        // Explicit parent from session_meta: no timing heuristic (see session-link.mjs).
        if (row._parent) setParent(db, row.session_id, row._parent);
        setIngestState(db, file, row.session_id, signature);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      sessions++; changed++;
    }
  }
```

Update the module doc comment's first paragraph to mention Codex rollouts (`~/.codex/sessions`, `codex-ingest.mjs`) and the JSDoc of `ingestAll` to list `codexDir`.

- [ ] **Step 4: Implement in `src/lib/cc/session-filters.mjs`**

In `sourceOf`, first line after `const e = …`: `if (e.startsWith('codex')) return 'codex'`. In `SOURCE_FILTERS` add `codex: 'Codex',` before `other`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest-run.test.mjs src/lib/cc/session-filters.test.mjs`
Expected: PASS

- [ ] **Step 6: Smoke on real data** (read-only for anything but the store)

Run: `npm run cc:ingest && node --disable-warning=ExperimentalWarning -e "import('./src/lib/cc/store.mjs').then(({openStore})=>{const db=openStore();console.log(db.prepare(\"select entrypoint,kind,count(*) n,sum(parent_session_id is not null) linked from sessions where entrypoint like 'codex%' group by 1,2\").all())})"`
Expected: rows for `codex-desktop`, `codex-t3code`, `codex-cli`; every `codex-subagent` row has `linked` equal to its `n` (≈ 12 subagent rollouts on this machine).

- [ ] **Step 7: Commit**

```bash
git add src/lib/cc/ingest-run.mjs src/lib/cc/ingest-run.test.mjs src/lib/cc/session-filters.mjs src/lib/cc/session-filters.test.mjs
git commit -m "feat(cc): ingest Codex sessions into the session store"
```

---

# Part C — F2 + F3 Summaries v2 and the batch

### Task 6: Summary schema v2, metadata line and facts header

**Files:**
- Modify: `src/lib/cc/summary.mjs`
- Test: `src/lib/cc/summary.test.mjs`

**Interfaces:**
- Consumes: `bashCommands`, `toolUses`, `assistantTexts` (transcript.mjs).
- Produces:
  - `SUMMARY_VERSION = 2`, `OUTCOMES = ['done','partial','abandoned','exploration']`, `KIND_HINTS = ['work','agent-spawn','trivial']`, `SUMMARY_SCHEMA` (v2)
  - `sessionMeta(row): string` — metadata lines prepended to the prompt
  - `commitMessage(cmd: string): string|null`
  - `factsHeader({ edited, commits, finals }): string` (`''` when empty)
  - `claudeFacts(lines): { edited: string[], commits: string[], finals: string[] }`
  - `summarize(distillate, { meta?, exec?, model?, clock?, … })` → `{ v: 2, title: string|null, what, outcome, improvements, followups, kind_hint, model, ms }`
  - `summarizeSession(db, id, opts)` passes `meta: sessionMeta(row)`; `opts.model` overrides the model.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/cc/summary.test.mjs` (and add `sessionMeta, commitMessage, factsHeader, claudeFacts, SUMMARY_SCHEMA` to its import):

```js
test('summarize returns summary v2 with title, kind_hint and timing', async () => {
  let t = 1000;
  const r = await summarize('x', { exec: fakeExec({ title: 'Port change', what: 'Set port.', outcome: 'exploration', improvements: ['a', 'b', 'c', 'd', 'e', 'f'], followups: [], kind_hint: 'trivial' }), clock: () => (t += 1500), model: 'm' });
  assert.equal(r.v, 2);
  assert.equal(r.title, 'Port change');
  assert.equal(r.outcome, 'exploration');
  assert.equal(r.kind_hint, 'trivial');
  assert.equal(r.improvements.length, 5, 'clipped to 5');
  assert.equal(r.ms, 1500);
  assert.equal(r.model, 'm');
});

test('summarize tolerates model output without title/kind_hint', async () => {
  const r = await summarize('x', { exec: fakeExec(okResult) });
  assert.equal(r.title, null);
  assert.equal(r.kind_hint, 'work');
});

test('claudeArgs sends the v2 schema; the prompt starts with session metadata', async () => {
  let seen = null;
  const exec = async (_bin, args) => { seen = args; return { stdout: JSON.stringify({ structured_output: okResult }) }; };
  await summarize('TRANSCRIPT', { exec, meta: 'Project: app' });
  const schema = JSON.parse(seen[seen.indexOf('--json-schema') + 1]);
  assert.ok(schema.required.includes('kind_hint'));
  assert.ok(schema.properties.outcome.enum.includes('exploration'));
  assert.match(seen.at(-1), /^Project: app\n\nTranscript:\nTRANSCRIPT/);
});

test('sessionMeta / commitMessage / factsHeader / claudeFacts', () => {
  assert.match(sessionMeta({ project_dir: '/p/app', entrypoint: 'cli', active_s: 600, turns: 4, git_branch: 'main', started_at: '2026-09-09T10:00:00Z' }), /Project: app[\s\S]*active 10 min · 4 turns · branch main/);
  assert.equal(commitMessage('git commit -m "feat: x" && git push'), 'feat: x');
  assert.equal(commitMessage("git commit -m \"$(cat <<'EOF'\nfix: y\n\nbody\nEOF\n)\""), 'fix: y');
  assert.equal(commitMessage('git status'), null);
  assert.equal(factsHeader({}), '');
  assert.match(factsHeader({ edited: ['a/b.js', 'a/b.js'], commits: ['feat: x'], finals: ['1', '2', '3', '4'] }), /^FILES EDITED: a\/b\.js\nCOMMITS: feat: x\nFINAL ANSWER: 2\nFINAL ANSWER: 3\nFINAL ANSWER: 4\n---\n$/);
  const facts = claudeFacts([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/lib/x.mjs' } }, { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "feat: z"' } }, { type: 'text', text: 'Done.' }] } },
  ]);
  assert.deepEqual(facts, { edited: ['lib/x.mjs'], commits: ['feat: z'], finals: ['Done.'] });
});

test('distill prepends the facts header and still respects maxChars', () => {
  const withEdit = [...lines, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/r/a/b.md' } }] } }];
  assert.match(distill(withEdit), /^FILES EDITED: a\/b\.md\n/);
  assert.ok(distill(withEdit, { maxChars: 40 }).length <= 40);
});
```

Update the existing assertions that compare `summarize(...)`'s whole return value (if any `deepEqual` on the old 5-key shape) to check the individual fields `what`, `outcome`, `improvements`, `followups`, `model` instead.

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary.test.mjs`
Expected: FAIL — `sessionMeta` not exported, `r.v` undefined.

- [ ] **Step 3: Implement in `src/lib/cc/summary.mjs`**

Replace `SUMMARY_SCHEMA`, `SYSTEM_PROMPT` and `OUTCOMES`:

```js
export const SUMMARY_VERSION = 2;
export const OUTCOMES = ['done', 'partial', 'abandoned', 'exploration'];
export const KIND_HINTS = ['work', 'agent-spawn', 'trivial'];

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'at most 60 characters: what the session was about, without the project name' },
    what: { type: 'string', description: '2-4 concrete sentences: what was worked on and the result' },
    outcome: { type: 'string', enum: OUTCOMES },
    improvements: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'what concretely came out of it' },
    followups: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'what is left / the next step' },
    kind_hint: { type: 'string', enum: KIND_HINTS },
  },
  required: ['title', 'what', 'outcome', 'improvements', 'followups', 'kind_hint'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You summarise one AI coding session from a condensed transcript. Answer ONLY with JSON matching the schema.
The first lines give metadata (project, harness, time, size) and facts extracted from the transcript (files edited, commits, final answers). Use them; do not repeat them verbatim.
"title": at most 60 characters, what the session was about. Do not include the project name.
"what": 2-4 plain, concrete sentences on what was worked on and what the result was.
"outcome": done (the goal was reached) | partial (progress, work remains) | abandoned (dropped or failed) | exploration (research, questions or prototyping; no deliverable was intended).
"improvements": what actually came out of it (features, fixes, docs, skills, decisions), at most 5; empty if nothing.
"followups": open items or the next step, at most 4; empty if none.
"kind_hint": work (a human drove the session) | agent-spawn (the prompt is machine-generated: a dispatched task, a persona review, a security review) | trivial (fewer than two meaningful exchanges, nothing was produced).
Do not invent anything: if the result cannot be told from the transcript, say so cautiously.
Be concrete. No marketing language. Write in the language the user wrote in.`;
```

Add after `limitChars` (and harden `limitChars` for tiny budgets by adding `if (maxChars < 20) return text.slice(0, Math.max(0, maxChars));` as its first line):

```js
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Last two path segments: enough to recognise a file, short enough for the prompt. */
function shortPath(p) {
  return String(p || '').split('/').filter(Boolean).slice(-2).join('/');
}

/** Subject line of a `git commit` command (-m "…" or a heredoc); null when there is none. */
export function commitMessage(cmd) {
  const s = String(cmd || '');
  if (!/\bgit\s+commit\b/.test(s)) return null;
  const h = /<<\s*'?EOF'?\s*\n([^\n]+)/.exec(s);
  if (h) return h[1].trim() || null;
  const m = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(s);
  return m ? (m[1] ?? m[2]).split('\n')[0].trim() || null : null;
}

/** What helped the PoC most: files edited, commit subjects, the last three agent answers. */
export function factsHeader({ edited = [], commits = [], finals = [] } = {}) {
  const out = [];
  if (edited.length) out.push(`FILES EDITED: ${[...new Set(edited)].slice(0, 15).join(', ')}`);
  if (commits.length) out.push(`COMMITS: ${commits.slice(0, 5).map((c) => clip(c, 160)).join(' | ')}`);
  for (const f of finals.slice(-3)) out.push(`FINAL ANSWER: ${clip(f, 400)}`);
  return out.length ? out.join('\n') + '\n---\n' : '';
}

export function claudeFacts(lines) {
  const edited = toolUses(lines).filter((u) => EDIT_TOOLS.has(u.tool) && u.input.file_path).map((u) => shortPath(u.input.file_path));
  const commits = bashCommands(lines).map(commitMessage).filter(Boolean);
  return { edited, commits, finals: assistantTexts(lines).slice(-3) };
}

/** Header first, then the head/tail-limited body; the total never exceeds maxChars. */
function withHeader(header, body, maxChars) {
  const h = header.slice(0, maxChars);
  return h + limitChars(body, maxChars - h.length);
}

/** Metadata lines prepended to every summary prompt (the model must not guess these). */
export function sessionMeta(s) {
  const project = s?.project_dir ? s.project_dir.split('/').filter(Boolean).at(-1) : 'unknown';
  const mins = Math.round((s?.active_s || 0) / 60);
  return [
    `Project: ${project}`,
    `Harness: ${s?.entrypoint || 'unknown'}`,
    `Started: ${s?.started_at || '?'} · active ${mins} min · ${s?.turns ?? '?'} turns${s?.git_branch ? ` · branch ${s.git_branch}` : ''}`,
  ].join('\n');
}
```

Update the transcript import to `import { assistantTexts, bashCommands, parseLines, toolUses, userPrompts } from './transcript.mjs';`.

In `distill` (Claude branch) change the last line to `return withHeader(factsHeader(claudeFacts(lines)), parts.join('\n'), maxChars);`.

Replace `summarize`:

```js
/**
 * @param {string} distillate  output of distill()/distillCodex()/distillGemini()
 * @param {{meta?: string, exec?: Function, model?: string, timeout?: number, cwd?: string, bin?: string, clock?: () => number}} opts
 * @returns {Promise<{v: 2, title: string|null, what: string, outcome: string, improvements: string[], followups: string[], kind_hint: string, model: string, ms: number}>}
 */
export async function summarize(distillate, {
  meta = '',
  exec = execClosedStdin,
  model = process.env.CC_SUMMARY_MODEL || 'haiku',
  timeout = 120000,
  cwd = tmpdir(), // never the repo: a project CLAUDE.md would be pulled into context
  bin = resolveClaudeBin(),
  clock = Date.now,
} = {}) {
  const args = claudeArgs({ model, prompt: `${meta ? `${meta}\n\n` : ''}Transcript:\n${distillate}` });
  // (keep the existing PATH / exec / error mapping block unchanged)
  const t0 = clock();
  // … existing `let out; try { out = await exec(...) } catch …` …
  // … existing JSON parse / is_error handling …
  const s = parsed?.structured_output;
  if (!s || typeof s.what !== 'string' || !OUTCOMES.includes(s.outcome)) throw new SummaryError('bad-json', 'claude returned no structured_output');
  const list = (x, n) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string').slice(0, n) : []);
  return {
    v: SUMMARY_VERSION,
    title: typeof s.title === 'string' && s.title.trim() ? clip(s.title, 60) : null,
    what: s.what,
    outcome: s.outcome,
    improvements: list(s.improvements, 5),
    followups: list(s.followups, 4),
    kind_hint: KIND_HINTS.includes(s.kind_hint) ? s.kind_hint : 'work',
    model,
    ms: clock() - t0,
  };
}
```

(Place `const t0 = clock();` immediately before the `exec(...)` call; everything between is the current code.)

In `summarizeSession`, change `const result = await summarize(distillate, opts);` to `const result = await summarize(distillate, { ...opts, meta: sessionMeta(got.session) });`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/summary.mjs src/lib/cc/summary.test.mjs
git commit -m "feat(cc): summary schema v2 with title, exploration, kind hint and facts header"
```

---

### Task 7: `distillCodex` + Codex branch in `summarizeSession`

**Files:**
- Modify: `src/lib/cc/summary.mjs`
- Test: `src/lib/cc/summary.test.mjs`

**Interfaces:**
- Consumes: `contentText`, `isInjectedPrompt` (codex-ingest.mjs, Task 4); `factsHeader`, `commitMessage`, `withHeader` (Task 6).
- Produces: `codexFacts(lines)`, `distillCodex(lines, { maxChars })`; `summarizeSession` uses them when `entrypoint` starts with `codex`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/cc/summary.test.mjs` (import `distillCodex`, `codexFacts`):

```js
const codexLines = [
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'set port 3371' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git commit -m \\"chore: port\\""}' } },
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /r/app/package.json\n*** End Patch' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Port changed.' }] } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'All done.' } },
];

test('codexFacts and distillCodex', () => {
  assert.deepEqual(codexFacts(codexLines), { edited: ['app/package.json'], commits: ['chore: port'], finals: ['All done.'] });
  const d = distillCodex(codexLines);
  assert.match(d, /^FILES EDITED: app\/package\.json\nCOMMITS: chore: port\nFINAL ANSWER: All done\.\n---\n/);
  assert.match(d, /USER: set port 3371/);
  assert.doesNotMatch(d, /environment_context/);
  assert.match(d, /TOOL exec_command: git commit/);
  assert.match(d, /TOOL apply_patch: app\/package\.json/);
  assert.match(d, /ASSISTANT: Port changed\./);
});

test('summarizeSession reads Codex rollouts with distillCodex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sumx-'));
  const f = join(dir, 'rollout.jsonl');
  await writeFile(f, codexLines.map((l) => JSON.stringify(l)).join('\n'));
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'cx', entrypoint: 'codex-desktop', raw_ref: f, project_dir: '/r/app' });
  let prompt = null;
  const exec = async (_b, args) => { prompt = args.at(-1); return { stdout: JSON.stringify({ structured_output: okResult }) }; };
  await summarizeSession(db, 'cx', { exec });
  assert.match(prompt, /Harness: codex-desktop/);
  assert.match(prompt, /USER: set port 3371/);
});
```

(Ensure `mkdtemp`, `writeFile`, `tmpdir`, `join`, `openStore`, `upsertSession` are imported in the test file; most already are for the Gemini tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary.test.mjs`
Expected: FAIL — `distillCodex` is not exported.

- [ ] **Step 3: Implement in `src/lib/cc/summary.mjs`**

Import: `import { contentText, isInjectedPrompt } from './codex-ingest.mjs';`

```js
/** Shell command of a Codex function_call (exec_command {cmd} or shell {command: [...]}); null otherwise. */
function codexCommand(p) {
  try {
    const a = JSON.parse(p.arguments || '{}');
    if (Array.isArray(a.command)) return a.command.join(' ');
    return a.cmd || a.command || null;
  } catch {
    return null;
  }
}

const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

export function codexFacts(lines) {
  const edited = [], commits = [], finals = [];
  for (const d of lines || []) {
    const p = d?.payload || {};
    if (d.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string') {
      for (const m of p.input.matchAll(PATCH_FILE_RE)) edited.push(shortPath(m[1]));
    }
    if (d.type === 'response_item' && p.type === 'function_call') {
      const msg = commitMessage(codexCommand(p));
      if (msg) commits.push(msg);
    }
    if (d.type === 'event_msg' && p.type === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) finals.push(p.last_agent_message);
  }
  return { edited, commits, finals };
}

/** Condensed, ordered transcript for a Codex rollout (same USER/TOOL/ASSISTANT shape as distill()). */
export function distillCodex(lines, { maxChars = 30000 } = {}) {
  const parts = [];
  for (const d of lines || []) {
    const p = d?.payload || {};
    if (d?.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const t = contentText(p.content).trim();
      if (t && !isInjectedPrompt(t)) parts.push(`USER: ${clip(t, 1200)}`);
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = contentText(p.content).trim();
      if (t) parts.push(`ASSISTANT: ${clip(t, 600)}`);
    } else if (p.type === 'function_call' && p.name) {
      parts.push(`TOOL ${p.name}: ${clip(codexCommand(p) || cleanToolArg(p.arguments), 160)}`);
    } else if (p.type === 'custom_tool_call' && p.name) {
      const files = typeof p.input === 'string' ? [...p.input.matchAll(PATCH_FILE_RE)].map((m) => shortPath(m[1])) : [];
      parts.push(`TOOL ${p.name}: ${clip(files.length ? files.join(', ') : cleanToolArg(p.input), 160)}`);
    }
  }
  return withHeader(factsHeader(codexFacts(lines)), parts.join('\n'), maxChars);
}
```

In `summarizeSession`, before the `if (isGemini)` block add `const isCodex = String(got.session.entrypoint || '').startsWith('codex');` and turn the chain into:

```js
  if (isCodex) {
    let text;
    try { text = await readFile(rawRef, 'utf8'); } catch { throw new SummaryError('not-found', `transcript missing: ${rawRef}`); }
    distillate = distillCodex(parseLines(text), opts);
  } else if (isGemini) {
    // … unchanged …
  } else {
    // … unchanged Claude branch …
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/summary.mjs src/lib/cc/summary.test.mjs
git commit -m "feat(cc): summarise Codex sessions"
```

---

### Task 8: Store — `summary_jobs`, range queries, rows by id

**Files:**
- Modify: `src/lib/cc/store.mjs`, `src/app/api/sessions/route.js`
- Test: `src/lib/cc/store.test.mjs`, `src/app/api/sessions/route.test.mjs`

**Interfaces:**
- Produces: table `summary_jobs(job_id TEXT PK, status TEXT, model TEXT, concurrency INTEGER, total INTEGER, done INTEGER, failed TEXT, ids TEXT, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, error TEXT)`; `listSessions(db, { project?, limit?, since?, until? })` (range on top-level `started_at`, `[since, until)`, children still ride along); `getSessionsByIds(db, ids): row[]` ordered by `started_at`; `GET /api/sessions?since=&until=` (limit default 5000 when a range is given, cap 5000).

- [ ] **Step 1: Write the failing tests** — append to `src/lib/cc/store.test.mjs`:

```js
test('listSessions filters top-level sessions by [since, until) and keeps their children', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'a', started_at: '2026-09-01T10:00:00.000Z' });
  upsertSession(db, { session_id: 'b', started_at: '2026-09-08T10:00:00.000Z' });
  upsertSession(db, { session_id: 'c', started_at: '2026-09-15T10:00:00.000Z' });
  upsertSession(db, { session_id: 'b-kid', started_at: '2026-09-08T10:05:00.000Z' });
  setParent(db, 'b-kid', 'b');
  const got = listSessions(db, { since: '2026-09-08T00:00:00.000Z', until: '2026-09-15T10:00:00.000Z' }).map((s) => s.session_id);
  assert.deepEqual(got, ['b', 'b-kid']);
});

test('getSessionsByIds returns rows in start order and ignores unknown ids', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'x', started_at: '2026-09-02T00:00:00Z' });
  upsertSession(db, { session_id: 'y', started_at: '2026-09-01T00:00:00Z' });
  assert.deepEqual(getSessionsByIds(db, ['x', 'nope', 'y']).map((r) => r.session_id), ['y', 'x']);
  assert.deepEqual(getSessionsByIds(db, []), []);
});

test('summary_jobs table exists', () => {
  const db = openStore(':memory:');
  const cols = db.prepare('PRAGMA table_info(summary_jobs)').all().map((c) => c.name);
  assert.ok(cols.includes('heartbeat_at') && cols.includes('failed'));
});
```

(Add `setParent` and `getSessionsByIds` to the store test's import.)

Append to `src/app/api/sessions/route.test.mjs`:

```js
test('list honours since/until', () => {
  const res = handle(new URLSearchParams('since=2026-08-21T10:30:00Z&until=2026-08-22T00:00:00Z'), db1());
  assert.deepEqual(res.sessions.map((s) => s.session_id), ['s2']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/store.test.mjs src/app/api/sessions/route.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement in `src/lib/cc/store.mjs`**

Append to `SCHEMA` (before the index lines):

```sql
CREATE TABLE IF NOT EXISTS summary_jobs (
  job_id TEXT PRIMARY KEY, status TEXT, model TEXT, concurrency INTEGER,
  total INTEGER, done INTEGER, failed TEXT, ids TEXT,
  started_at TEXT, heartbeat_at TEXT, finished_at TEXT, error TEXT
);
```

Replace `listSessions`:

```js
/**
 * Newest-first session rows. `limit` applies to top-level sessions (no parent);
 * every linked child of a returned parent is included on top of that, so the
 * caller can always build complete families (see session-tree.mjs).
 * `since`/`until` (ISO, `[since, until)`) bound the top-level start time — the
 * calendar asks for exactly the period it shows.
 */
export function listSessions(db, { project, limit = 200, since = null, until = null } = {}) {
  // `guard_hits` (a count) rides along so the list can filter on it without a second query.
  const select = 'SELECT s.*, (SELECT count(*) FROM guard_hits g WHERE g.session_id = s.session_id) guard_hits FROM sessions s';
  const conds = ['s.parent_session_id IS NULL'];
  const args = [];
  if (project) { conds.push('s.project_dir = ?'); args.push(project); }
  if (since) { conds.push('s.started_at >= ?'); args.push(since); }
  if (until) { conds.push('s.started_at < ?'); args.push(until); }
  const parents = db.prepare(`${select} WHERE ${conds.join(' AND ')} ORDER BY s.started_at DESC LIMIT ?`).all(...args, limit);
  const ids = parents.map((p) => p.session_id);
  const children = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    children.push(...db.prepare(`${select} WHERE s.parent_session_id IN (${chunk.map(() => '?').join(',')}) ORDER BY s.started_at DESC`).all(...chunk));
  }
  return [...parents, ...children];
}

/** Rows for the given ids (unknown ids skipped), oldest first. */
export function getSessionsByIds(db, ids) {
  const out = [];
  for (let i = 0; i < (ids || []).length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...db.prepare(`SELECT * FROM sessions WHERE session_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return out.sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
}
```

- [ ] **Step 4: Implement in `src/app/api/sessions/route.js`** — in `handle`, replace the list branch:

```js
  const project = searchParams.get('project') || undefined
  const since = searchParams.get('since') || null
  const until = searchParams.get('until') || null
  const ranged = Boolean(since || until)
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || (ranged ? 5000 : 200), 1), ranged ? 5000 : 1000)
  const sessions = listSessions(db, { project, limit, since, until })
```

and add `(?since=<iso>&until=<iso> — top-level start in [since, until))` to the doc comment.

- [ ] **Step 5: Run to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/store.test.mjs src/app/api/sessions/route.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/cc/store.mjs src/lib/cc/store.test.mjs src/app/api/sessions/route.js src/app/api/sessions/route.test.mjs
git commit -m "feat(cc): session range queries and summary_jobs table"
```

---

### Task 9: `summary-batch.mjs` — selection, estimate, cross-process job runner

**Files:**
- Create: `src/lib/cc/summary-batch.mjs`, `src/lib/cc/summary-batch.test.mjs`

**Interfaces:**
- Consumes: `openStore`, `getSessionsByIds` (Task 8), `summarizeSession` (Tasks 6–7), `needsSummary`, `parseSummary` (Task 2), `effectiveKind` (Task 2).
- Produces:
  - `STALE_MS = 60000`, `HEARTBEAT_MS = 10000`, `DEFAULT_CONCURRENCY = 3`
  - `batchModel(env = process.env): string`
  - `selectMissing(db, { ids?, since?, until?, force?, kinds? = ['work'], now? }): string[]` — with `ids`, only `needsSummary` applies (the UI already applied visibility filters); with a range, top-level rows whose `effectiveKind` is in `kinds`.
  - `medianSummaryMs(db, model): number|null`
  - `estimateBatch(db, { count, concurrency?, model? }): { count, model, seconds }`
  - `readJob(db, jobId = null, now = Date.now()): Job|null` — latest job when `jobId` is null; `Job = { job_id, status: 'running'|'stale'|'done'|'stopped', model, concurrency, total, done, failed: {id, kind, message}[], ids: string[], started_at, heartbeat_at, finished_at, error, alive: boolean }`
  - `startBatch(db, { ids, model?, concurrency?, summarizeImpl?, openDb?, closeDb?, onProgress?, now? }): { job: Job, started: boolean, done: Promise<Job> }` — returns the live running job with `started: false` instead of starting a second one.

- [ ] **Step 1: Write the failing tests** — `src/lib/cc/summary-batch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, setParent, getSession } from './store.mjs';
import { selectMissing, estimateBatch, startBatch, readJob, batchModel, STALE_MS } from './summary-batch.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const row = (id, over = {}) => ({ session_id: id, raw_ref: `/t/${id}`, kind: 'main', started_at: '2026-09-10T10:00:00.000Z', ended_at: '2026-09-10T11:00:00.000Z', ...over });

function seeded() {
  const db = openStore(':memory:');
  upsertSession(db, row('w1'));
  upsertSession(db, row('w2', { started_at: '2026-09-11T10:00:00.000Z' }));
  upsertSession(db, row('sched', { kind: 'scheduled' }));
  upsertSession(db, row('kid'));
  setParent(db, 'kid', 'w1');
  upsertSession(db, row('fresh', { started_at: '2026-09-30T11:55:00.000Z', ended_at: '2026-09-30T11:58:00.000Z' }));
  upsertSession(db, row('done', { started_at: '2026-09-12T10:00:00.000Z' }));
  setSummary(db, 'done', { summary: JSON.stringify({ v: 2, what: 'x', outcome: 'done' }), model: 'claude-sonnet-5-5' });
  return db;
}

const okImpl = async (db, id) => { setSummary(db, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done', ms: 1000 }), model: 'm' }); };
const shared = (db) => ({ openDb: () => db, closeDb: () => {} });

test('selectMissing by range keeps top-level work sessions without a summary, skips fresh ones', () => {
  const db = seeded();
  assert.deepEqual(selectMissing(db, { since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z', now: NOW }), ['w1', 'w2']);
  assert.deepEqual(selectMissing(db, { since: '2026-09-01T00:00:00Z', kinds: ['work', 'scheduled'], now: NOW }).sort(), ['sched', 'w1', 'w2']);
});

test('selectMissing by ids trusts the caller for visibility but still skips fresh and summarised rows', () => {
  const db = seeded();
  assert.deepEqual(selectMissing(db, { ids: ['kid', 'fresh', 'done', 'sched', 'nope'], now: NOW }).sort(), ['kid', 'sched']);
});

test('estimateBatch uses fallback per model, then the median of recorded ms', () => {
  const db = seeded();
  assert.deepEqual(estimateBatch(db, { count: 7, concurrency: 3, model: 'claude-sonnet-5-5' }), { count: 7, model: 'claude-sonnet-5-5', seconds: 90 });
  assert.equal(estimateBatch(db, { count: 3, concurrency: 3, model: 'haiku' }).seconds, 10);
  for (const [id, ms] of [['w1', 4000], ['w2', 8000], ['sched', 6000]]) setSummary(db, id, { summary: JSON.stringify({ v: 2, what: '', outcome: 'done', ms }), model: 'claude-sonnet-5-5' });
  assert.equal(estimateBatch(db, { count: 4, concurrency: 2, model: 'claude-sonnet-5-5' }).seconds, 12);
  assert.equal(batchModel({}), 'claude-sonnet-5-5');
  assert.equal(batchModel({ CC_SUMMARY_BATCH_MODEL: 'haiku' }), 'haiku');
});

test('startBatch summarises every id, records failures and finishes', async () => {
  const db = seeded();
  const impl = async (d, id) => { if (id === 'w2') { const e = new Error('boom'); e.kind = 'cli-failed'; throw e; } return okImpl(d, id); };
  const { job, started, done } = startBatch(db, { ids: ['w1', 'w2', 'sched'], model: 'm', summarizeImpl: impl, ...shared(db), now: () => NOW });
  assert.equal(started, true);
  assert.equal(job.status, 'running');
  const fin = await done;
  assert.equal(fin.status, 'done');
  assert.equal(fin.done, 2);
  assert.deepEqual(fin.failed.map((f) => [f.id, f.kind]), [['w2', 'cli-failed']]);
  assert.equal(JSON.parse(getSession(db, 'w1').session.summary).what, 'w1');
});

test('cli-missing stops the job without touching the remaining ids', async () => {
  const db = seeded();
  const calls = [];
  const impl = async (_d, id) => { calls.push(id); const e = new Error('no cli'); e.kind = 'cli-missing'; throw e; };
  const fin = await startBatch(db, { ids: ['w1', 'w2', 'sched'], model: 'm', concurrency: 1, summarizeImpl: impl, ...shared(db), now: () => NOW }).done;
  assert.deepEqual(calls, ['w1']);
  assert.equal(fin.status, 'stopped');
  assert.equal(fin.error, 'no cli');
});

test('a second start while a live job runs returns that job; a stale job does not block', async () => {
  const db = seeded();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (d, id) => { await gate; return okImpl(d, id); };
  const first = startBatch(db, { ids: ['w1'], model: 'm', summarizeImpl: slow, ...shared(db), now: () => NOW });
  const second = startBatch(db, { ids: ['w2'], model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW });
  assert.equal(second.started, false);
  assert.equal(second.job.job_id, first.job.job_id);
  release();
  await first.done;

  db.prepare("INSERT INTO summary_jobs (job_id, status, model, total, done, failed, ids, started_at, heartbeat_at) VALUES ('dead', 'running', 'm', 5, 1, '[]', '[]', ?, ?)")
    .run(new Date(NOW - 10 * 60_000).toISOString(), new Date(NOW - STALE_MS - 1000).toISOString());
  assert.equal(readJob(db, 'dead', NOW).status, 'stale');
  const third = startBatch(db, { ids: ['w2'], model: 'm', summarizeImpl: okImpl, ...shared(db), now: () => NOW });
  assert.equal(third.started, true);
  await third.done;
});

test('startBatch with no ids records an already finished job', async () => {
  const db = seeded();
  const r = startBatch(db, { ids: [], model: 'm', ...shared(db), now: () => NOW });
  assert.equal(r.started, true);
  assert.equal((await r.done).status, 'done');
  assert.equal(readJob(db, null, NOW).total, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary-batch.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/cc/summary-batch.mjs`**

```js
/**
 * Batch AI summaries ("fill in what's missing"). One implementation behind the
 * /sessions calendar banner, `npm run cc:eval -- --summaries` and the MCP
 * `summarize_sessions` tool.
 *
 * Job state lives in the `summary_jobs` table, not in memory: the MCP server
 * is its own stdio process and the desktop app binds a runtime-assigned port,
 * so a job started from one must be visible to the other. The process that
 * started a job runs it and writes a heartbeat after every session and every
 * HEARTBEAT_MS; a running job whose heartbeat is older than STALE_MS belongs
 * to a process that died and no longer blocks new batches.
 */
import { randomUUID } from 'node:crypto';
import { openStore, getSessionsByIds } from './store.mjs';
import { summarizeSession } from './summary.mjs';
import { needsSummary, parseSummary } from './summary-view.mjs';
import { effectiveKind } from './session-link.mjs';

export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 3;

export function batchModel(env = process.env) {
  return env.CC_SUMMARY_BATCH_MODEL || 'claude-sonnet-5-5';
}

/**
 * Session ids a batch should summarise.
 * `ids`: exactly what the UI shows (it already applied kind/filters), so only
 * needsSummary is checked. Range (CLI/MCP): top-level rows started in
 * [since, until) whose effectiveKind is in `kinds`.
 */
export function selectMissing(db, { ids = null, since = null, until = null, force = false, kinds = ['work'], now = Date.now() } = {}) {
  let rows;
  if (ids) {
    rows = getSessionsByIds(db, ids);
  } else {
    const conds = ['parent_session_id IS NULL'];
    const args = [];
    if (since) { conds.push('started_at >= ?'); args.push(since); }
    if (until) { conds.push('started_at < ?'); args.push(until); }
    rows = db.prepare(`SELECT * FROM sessions WHERE ${conds.join(' AND ')} ORDER BY started_at`).all(...args)
      .filter((r) => kinds.includes(effectiveKind(r)));
  }
  return rows.filter((r) => needsSummary(r, { force, now })).map((r) => r.session_id);
}

/** Median CLI time of the last 50 summaries made with `model`; null without history. */
export function medianSummaryMs(db, model) {
  const ms = db.prepare('SELECT summary FROM sessions WHERE summary_model = ? AND summary IS NOT NULL ORDER BY summarized_at DESC LIMIT 50').all(model)
    .map((r) => parseSummary(r)?.ms)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!ms.length) return null;
  const mid = Math.floor(ms.length / 2);
  return ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
}

export function estimateBatch(db, { count, concurrency = DEFAULT_CONCURRENCY, model = batchModel() } = {}) {
  const per = medianSummaryMs(db, model) ?? (/haiku/i.test(model) ? 10_000 : 30_000);
  return { count, model, seconds: Math.ceil(count / Math.max(1, concurrency)) * per / 1000 };
}

function toJob(r, now) {
  if (!r) return null;
  const alive = r.status === 'running' && now - Date.parse(r.heartbeat_at || '') < STALE_MS;
  let failed = [], ids = [];
  try { failed = JSON.parse(r.failed || '[]'); } catch { /* keep [] */ }
  try { ids = JSON.parse(r.ids || '[]'); } catch { /* keep [] */ }
  return { ...r, status: r.status === 'running' && !alive ? 'stale' : r.status, failed, ids, alive };
}

/** One job by id, or the most recently started one. */
export function readJob(db, jobId = null, now = Date.now()) {
  const r = jobId
    ? db.prepare('SELECT * FROM summary_jobs WHERE job_id = ?').get(jobId)
    : db.prepare('SELECT * FROM summary_jobs ORDER BY started_at DESC LIMIT 1').get();
  return toJob(r, now);
}

function liveJob(db, now) {
  const r = db.prepare("SELECT * FROM summary_jobs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get();
  const job = toJob(r, now);
  return job?.alive ? job : null;
}

/**
 * Start a batch over `ids` (see selectMissing), or return the live one.
 * The worker opens its own connection (`openDb`) so the caller may close `db`
 * as soon as this returns (an API route does).
 */
export function startBatch(db, {
  ids,
  model = batchModel(),
  concurrency = DEFAULT_CONCURRENCY,
  summarizeImpl = summarizeSession,
  openDb = () => openStore(),
  closeDb = (d) => d.close(),
  onProgress = null,
  now = Date.now,
} = {}) {
  const list = [...new Set(ids || [])];
  let row;
  db.exec('BEGIN IMMEDIATE');
  try {
    const running = liveJob(db, now());
    if (running) {
      db.exec('COMMIT');
      return { job: running, started: false, done: Promise.resolve(running) };
    }
    const t = new Date(now()).toISOString();
    row = {
      job_id: randomUUID(), status: list.length ? 'running' : 'done', model, concurrency,
      total: list.length, done: 0, failed: '[]', ids: JSON.stringify(list),
      started_at: t, heartbeat_at: t, finished_at: list.length ? null : t, error: null,
    };
    db.prepare(`INSERT INTO summary_jobs (job_id, status, model, concurrency, total, done, failed, ids, started_at, heartbeat_at, finished_at, error)
      VALUES (@job_id, @status, @model, @concurrency, @total, @done, @failed, @ids, @started_at, @heartbeat_at, @finished_at, @error)`).run(row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const job = readJob(db, row.job_id, now());
  if (!list.length) return { job, started: true, done: Promise.resolve(job) };
  const done = runJob(row.job_id, list, { model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now });
  return { job, started: true, done };
}

async function runJob(jobId, ids, { model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now }) {
  const db = openDb();
  let done = 0;
  const failed = [];
  let stopError = null;
  let next = 0;
  const beat = () => db.prepare('UPDATE summary_jobs SET done = ?, failed = ?, heartbeat_at = ? WHERE job_id = ?')
    .run(done, JSON.stringify(failed), new Date(now()).toISOString(), jobId);
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  const worker = async () => {
    while (!stopError && next < ids.length) {
      const id = ids[next++];
      try {
        await summarizeImpl(db, id, { model });
        done++;
        onProgress?.({ id, ok: true });
      } catch (e) {
        failed.push({ id, kind: e?.kind || 'error', message: String(e?.message || e) });
        onProgress?.({ id, ok: false, error: e });
        // Without the CLI every remaining call fails the same way.
        if (e?.kind === 'cli-missing') stopError = String(e.message || 'claude CLI not found');
      }
      beat();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  } finally {
    clearInterval(timer);
    const t = new Date(now()).toISOString();
    db.prepare('UPDATE summary_jobs SET status = ?, done = ?, failed = ?, heartbeat_at = ?, finished_at = ?, error = ? WHERE job_id = ?')
      .run(stopError ? 'stopped' : 'done', done, JSON.stringify(failed), t, t, stopError, jobId);
  }
  const job = readJob(db, jobId, now());
  closeDb(db);
  return job;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/summary-batch.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/summary-batch.mjs src/lib/cc/summary-batch.test.mjs
git commit -m "feat(cc): batch summary runner with SQLite job state"
```

---

### Task 10: Batch API routes

**Files:**
- Create: `src/app/api/sessions/summarize-batch/route.js`, `src/app/api/sessions/summarize-batch/route.test.mjs`
- Create: `src/app/api/sessions/summarize-batch/estimate/route.js`, `src/app/api/sessions/summarize-batch/estimate/route.test.mjs`

**Interfaces:**
- Consumes: Task 9 exports.
- Produces:
  - `GET /api/sessions/summarize-batch` → `{ job: Job|null }`; with `?since=&until=` also `{ missing, estimateSeconds, model }`.
  - `POST /api/sessions/summarize-batch` body `{ ids?: string[], since?, until?, force?, model?, concurrency? }` → `{ job, started, total }`; 400 when neither `ids` nor a range is given.
  - `POST /api/sessions/summarize-batch/estimate` body `{ ids: string[] }` → `{ missing, ids, estimateSeconds, model, job }`.
  - Pure handlers for tests: `handleGet(searchParams, db, now)`, `handlePost(body, db, deps)`, `handleEstimate(body, db, now)`.

- [ ] **Step 1: Write the failing tests**

`src/app/api/sessions/summarize-batch/route.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary } from '../../../../lib/cc/store.mjs';
import { handleGet, handlePost } from './route.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
function db1() {
  const db = openStore(':memory:');
  for (const id of ['a', 'b']) upsertSession(db, { session_id: id, kind: 'main', raw_ref: `/t/${id}`, started_at: '2026-09-10T10:00:00.000Z', ended_at: '2026-09-10T11:00:00.000Z' });
  return db;
}
const deps = (db) => ({ openDb: () => db, closeDb: () => {}, now: () => NOW, summarizeImpl: async (d, id) => setSummary(d, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done' }), model: 'm' }) });

test('GET without a job; with a range it reports missing + estimate', () => {
  const db = db1();
  assert.deepEqual(handleGet(new URLSearchParams(''), db, NOW), { job: null });
  const r = handleGet(new URLSearchParams('since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z'), db, NOW);
  assert.equal(r.missing, 2);
  assert.equal(r.estimateSeconds, 30);
});

test('POST with ids starts a job over the ids that still need a summary', async () => {
  const db = db1();
  const r = handlePost({ ids: ['a', 'zzz'] }, db, deps(db));
  assert.equal(r.started, true);
  assert.equal(r.total, 1);
  assert.throws(() => handlePost({}, db, deps(db)), /ids or since\/until required/);
});
```

`src/app/api/sessions/summarize-batch/estimate/route.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession } from '../../../../../lib/cc/store.mjs';
import { handleEstimate } from './route.js';

test('estimate counts only ids that need a summary', () => {
  const db = openStore(':memory:');
  const now = Date.parse('2026-09-30T12:00:00Z');
  upsertSession(db, { session_id: 'old', raw_ref: '/t', started_at: '2026-09-10T10:00:00Z', ended_at: '2026-09-10T11:00:00Z' });
  upsertSession(db, { session_id: 'live', raw_ref: '/t', started_at: '2026-09-30T11:50:00Z', ended_at: '2026-09-30T11:59:00Z' });
  const r = handleEstimate({ ids: ['old', 'live'] }, db, now);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.ids, ['old']);
  assert.equal(r.estimateSeconds, 30);
  assert.equal(r.job, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test src/app/api/sessions/summarize-batch/route.test.mjs src/app/api/sessions/summarize-batch/estimate/route.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `src/app/api/sessions/summarize-batch/route.js`**

```js
import { openStore } from '../../../../lib/cc/store.mjs'
import { batchModel, DEFAULT_CONCURRENCY, estimateBatch, readJob, selectMissing, startBatch } from '../../../../lib/cc/summary-batch.mjs'

/**
 * GET  /api/sessions/summarize-batch                    → { job }   (latest job, any status; `alive` + `status: 'stale'` for a dead runner)
 * GET  /api/sessions/summarize-batch?since=&until=      → { job, missing, estimateSeconds, model }   (CLI/MCP-style range)
 * POST /api/sessions/summarize-batch { ids } | { since, until } (+ force, model, concurrency)
 *                                                       → { job, started, total }; a live job is returned with started=false
 * The job runs in this server process and keeps its state in summary_jobs
 * (see src/lib/cc/summary-batch.mjs), so a job started by the MCP server shows up here too.
 */
export function handleGet(searchParams, db, now = Date.now()) {
  const out = { job: readJob(db, null, now) }
  const since = searchParams.get('since')
  const until = searchParams.get('until')
  if (since || until) {
    const ids = selectMissing(db, { since, until, now })
    const e = estimateBatch(db, { count: ids.length })
    Object.assign(out, { missing: ids.length, estimateSeconds: e.seconds, model: e.model })
  }
  return out
}

export function handlePost(body, db, deps = {}) {
  const now = deps.now || Date.now
  const force = body?.force ?? false
  let ids
  if (Array.isArray(body?.ids)) ids = selectMissing(db, { ids: body.ids.map(String), force, now: now() })
  else if (body?.since || body?.until) ids = selectMissing(db, { since: body.since ?? null, until: body.until ?? null, force, now: now() })
  else throw Object.assign(new Error('ids or since/until required'), { status: 400 })
  const { job, started } = startBatch(db, {
    ids,
    model: body?.model || batchModel(),
    concurrency: Number(body?.concurrency) || DEFAULT_CONCURRENCY,
    ...deps,
  })
  return { job, started, total: job.total }
}

export async function GET(request) {
  const db = openStore()
  try {
    return Response.json(handleGet(new URL(request.url).searchParams, db))
  } finally {
    db.close()
  }
}

export async function POST(request) {
  let body = null
  try { body = await request.json() } catch { /* no body */ }
  const db = openStore()
  try {
    return Response.json(handlePost(body, db))
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: e?.status || 500 })
  } finally {
    db.close()
  }
}
```

- [ ] **Step 4: Create `src/app/api/sessions/summarize-batch/estimate/route.js`**

```js
import { openStore } from '../../../../../lib/cc/store.mjs'
import { estimateBatch, readJob, selectMissing } from '../../../../../lib/cc/summary-batch.mjs'

/**
 * POST /api/sessions/summarize-batch/estimate { ids } → { missing, ids, estimateSeconds, model, job }
 * `ids` are the sessions the calendar currently shows; the answer is exactly
 * what a POST to ../summarize-batch with the same ids would summarise.
 */
export function handleEstimate(body, db, now = Date.now()) {
  const ids = selectMissing(db, { ids: (Array.isArray(body?.ids) ? body.ids : []).map(String), now })
  const e = estimateBatch(db, { count: ids.length })
  return { missing: ids.length, ids, estimateSeconds: e.seconds, model: e.model, job: readJob(db, null, now) }
}

export async function POST(request) {
  let body = null
  try { body = await request.json() } catch { /* no body */ }
  const db = openStore()
  try {
    return Response.json(handleEstimate(body, db))
  } finally {
    db.close()
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test src/app/api/sessions/summarize-batch/route.test.mjs src/app/api/sessions/summarize-batch/estimate/route.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/sessions/summarize-batch
git commit -m "feat(cc): summarize-batch API (status, start, estimate)"
```

---

### Task 11: `cc-eval` on top of the batch runner

**Files:**
- Modify: `scripts/cc-eval.mjs`, `scripts/cc-eval.test.mjs`

**Interfaces:**
- Consumes: `selectMissing`, `startBatch`, `batchModel`, `DEFAULT_CONCURRENCY` (Task 9).
- Produces: `evalSummaries(db, { limit?, id?, since?, until?, force?, concurrency?, model?, log?, summarizeImpl?, now? }) → { ok, failed, total }`. CLI flags `--summaries [--since D] [--until D] [--concurrency N] [--model M] [--force|--upgrade] [--limit N] [--id SID]`.

- [ ] **Step 1: Replace the test file** `scripts/cc-eval.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary } from '../src/lib/cc/store.mjs';
import { evalSummaries } from './cc-eval.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
function db1() {
  const db = openStore(':memory:');
  for (const [id, day] of [['a', '01'], ['b', '02'], ['c', '03']]) upsertSession(db, { session_id: id, kind: 'main', raw_ref: `/t/${id}`, started_at: `2026-09-${day}T10:00:00.000Z`, ended_at: `2026-09-${day}T11:00:00.000Z` });
  setSummary(db, 'b', { summary: JSON.stringify({ what: 'old', outcome: 'done' }), model: 'haiku' });
  return db;
}
const ok = async (db, id) => setSummary(db, id, { summary: JSON.stringify({ v: 2, what: id, outcome: 'done' }), model: 'm' });

test('evalSummaries without a range takes the newest `limit` missing sessions', async () => {
  const db = db1();
  const r = await evalSummaries(db, { limit: 1, log: () => {}, summarizeImpl: ok, now: NOW });
  assert.deepEqual(r, { ok: 1, failed: 0, total: 1 });
  assert.equal(JSON.parse(db.prepare("SELECT summary FROM sessions WHERE session_id = 'c'").get().summary).what, 'c');
});

test('evalSummaries with a range and --upgrade redoes v1 summaries too', async () => {
  const db = db1();
  const r = await evalSummaries(db, { since: '2026-09-01', until: '2026-10-01', force: 'upgrade', log: () => {}, summarizeImpl: ok, now: NOW });
  assert.equal(r.total, 3);
});

test('evalSummaries --id runs one session and reports cli-missing', async () => {
  const db = db1();
  const r = await evalSummaries(db, { id: 'a', log: () => {}, summarizeImpl: async () => { const e = new Error('x'); e.kind = 'cli-missing'; throw e; }, now: NOW });
  assert.deepEqual(r, { ok: 0, failed: 1, total: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cc-eval.test.mjs`
Expected: FAIL (range/force options unknown, old query ignores `now`).

- [ ] **Step 3: Rewrite `scripts/cc-eval.mjs`**

```js
#!/usr/bin/env node
/**
 * cc-eval — AI summaries for stored sessions (uses your local `claude` CLI).
 *
 *   npm run cc:eval -- --summaries                                   # newest 5 work sessions without a summary
 *   npm run cc:eval -- --summaries --since 2026-09-01 --until 2026-10-01 --concurrency 3
 *   npm run cc:eval -- --summaries --since 2026-09-01 --upgrade      # also redo v1 summaries
 *   npm run cc:eval -- --summaries --id <session_id>
 *
 * Batches go through src/lib/cc/summary-batch.mjs (same code as the calendar
 * banner and the MCP tool; model CC_SUMMARY_BATCH_MODEL, default Sonnet 5.5).
 * Never runs from ingest: each summary is a real Claude call.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/lib/cc/store.mjs';
import { summarizeSession } from '../src/lib/cc/summary.mjs';
import { batchModel, DEFAULT_CONCURRENCY, selectMissing, startBatch } from '../src/lib/cc/summary-batch.mjs';

const iso = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toISOString() : d || null);

export async function evalSummaries(db, {
  limit = 5, id = null, since = null, until = null, force = false,
  concurrency = DEFAULT_CONCURRENCY, model = undefined,
  log = console.log, summarizeImpl = summarizeSession, now = Date.now(),
} = {}) {
  if (id) {
    try {
      const r = await summarizeImpl(db, id, model ? { model } : {});
      const s = r?.session?.summary ? JSON.parse(r.session.summary) : null;
      log(`✓ ${id.slice(0, 8)} ${s ? `${s.outcome}: ${s.title || s.what}` : ''}`);
      return { ok: 1, failed: 0, total: 1 };
    } catch (e) {
      log(`✗ ${id.slice(0, 8)} ${e.kind || 'error'}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
      return { ok: 0, failed: 1, total: 1 };
    }
  }
  let ids = selectMissing(db, { since: iso(since), until: iso(until), force, now });
  if (!since && !until) ids = ids.slice(-limit); // oldest-first → newest `limit`
  const { job, started, done } = startBatch(db, {
    ids, model: model || batchModel(), concurrency, summarizeImpl,
    openDb: () => db, closeDb: () => {}, now: () => now,
    onProgress: ({ id: sid, ok, error }) => log(ok ? `✓ ${sid.slice(0, 8)}` : `✗ ${sid.slice(0, 8)} ${error?.kind || 'error'}: ${error?.message}`),
  });
  if (!started) {
    log(`a batch is already running (${job.done}/${job.total}, started ${job.started_at}) — not starting another`);
    return { ok: 0, failed: 0, total: 0 };
  }
  const fin = await done;
  if (fin.error) log(`stopped: ${fin.error}`);
  return { ok: fin.done, failed: fin.failed.length, total: fin.total };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      summaries: { type: 'boolean' }, limit: { type: 'string' }, id: { type: 'string' },
      since: { type: 'string' }, until: { type: 'string' }, concurrency: { type: 'string' },
      model: { type: 'string' }, force: { type: 'boolean' }, upgrade: { type: 'boolean' },
    },
  });
  if (!values.summaries) {
    console.error('usage: cc-eval --summaries [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--concurrency N] [--model M] [--force|--upgrade] [--limit N] [--id SESSION_ID]');
    process.exit(2);
  }
  const db = openStore();
  const r = await evalSummaries(db, {
    limit: Number(values.limit) || 5, id: values.id || null,
    since: values.since || null, until: values.until || null,
    force: values.force ? true : values.upgrade ? 'upgrade' : false,
    concurrency: Number(values.concurrency) || DEFAULT_CONCURRENCY, model: values.model,
  });
  db.close();
  console.log(`cc-eval: ${r.ok} summarised, ${r.failed} failed of ${r.total}`);
}
```

Note: `--id` keeps `CC_SUMMARY_MODEL` (default haiku) unless `--model` is given — it is the CLI twin of the Generate button.

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cc-eval.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cc-eval.mjs scripts/cc-eval.test.mjs
git commit -m "feat(cc): cc:eval batches through summary-batch (range, concurrency, upgrade)"
```

---

### Task 12: MCP tools `list_sessions` and `summarize_sessions`

**Files:**
- Modify: `src/mcp/server.mjs`, `src/mcp/server.smoke.mjs`, `CLAUDE.md` (MCP tool list: 21 → 23)

**Interfaces:**
- Consumes: `openStore`, `DB_NAME`, `listSessions`, `listSubagents` (store); `buildSessionTree` (session-tree); `effectiveKind` (session-link); `displayTitle`, `parseSummary` (summary-view); `selectMissing`, `startBatch`, `estimateBatch`, `batchModel`, `readJob` (summary-batch); `dataFile` (state-dir).
- Produces MCP tools:
  - `list_sessions { since, until, project?, kind?: 'work'|'scheduled'|'agent-spawn'|'trivial'|'all' (default 'work'), limit? (default 500) }` → JSON array of `{ session_id, started_at, ended_at, project, project_dir, harness, model, active_min, turns, cost_usd (family rollup), sub_sessions, git_branch, ticket_id, kind, title, summary: {what, outcome, improvements, followups}|null }`.
  - `summarize_sessions { since, until, force?: boolean|'upgrade' }` → `{ started, job: {job_id, status, done, total, failed}, estimateSeconds, note }`; calling it again while running returns progress.

- [ ] **Step 1: Extend the smoke test** — in `src/mcp/server.smoke.mjs` add `'list_sessions', 'summarize_sessions'` to `required`.

- [ ] **Step 2: Run to verify it fails**

Run: `node src/mcp/server.smoke.mjs`
Expected: `MISSING TOOLS: [ 'list_sessions', 'summarize_sessions' ]`, exit 1.

- [ ] **Step 3: Implement in `src/mcp/server.mjs`**

Imports (next to the existing state-dir import, change it to also import `dataFile`):

```js
import { ledgerFile, envFile, dataFile } from '../lib/state-dir.mjs'
import { openStore, DB_NAME, listSessions, listSubagents } from '../lib/cc/store.mjs'
import { buildSessionTree } from '../lib/cc/session-tree.mjs'
import { effectiveKind } from '../lib/cc/session-link.mjs'
import { displayTitle, parseSummary } from '../lib/cc/summary-view.mjs'
import { batchModel, estimateBatch, selectMissing, startBatch } from '../lib/cc/summary-batch.mjs'
```

Helper near the other helpers:

```js
// Opened per call: the state dir is resolved against the repo root (STATE), like the ledger.
const openSessionStore = () => openStore(dataFile(DB_NAME, STATE))
const dayIso = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toISOString() : d || null)
```

Tool definitions (append to the `tools` array):

```js
            {
                name: 'list_sessions',
                description: 'List AI coding sessions (Claude Code, Codex, Antigravity) started in a period, with their AI summary. Use for "what did I work on" reports. Subagent/linked sessions are rolled into their parent.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        since: { type: 'string', description: 'Start (YYYY-MM-DD local, or ISO)' },
                        until: { type: 'string', description: 'End, exclusive (YYYY-MM-DD local, or ISO)' },
                        project: { type: 'string', description: 'Exact project directory (optional)' },
                        kind: { type: 'string', enum: ['work', 'scheduled', 'agent-spawn', 'trivial', 'all'], description: 'Default work' },
                        limit: { type: 'number', description: 'Maximum sessions (default 500)' },
                    },
                    required: ['since', 'until'],
                },
            },
            {
                name: 'summarize_sessions',
                description: 'Generate missing AI summaries for work sessions in a period (runs the local claude CLI in the background, Sonnet by default). Call again to see progress.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        since: { type: 'string', description: 'Start (YYYY-MM-DD local, or ISO)' },
                        until: { type: 'string', description: 'End, exclusive (YYYY-MM-DD local, or ISO)' },
                        force: { description: "true = redo all, 'upgrade' = redo old v1 summaries" },
                    },
                    required: ['since', 'until'],
                },
            },
```

Handlers (before `default:`):

```js
        case 'list_sessions': {
            const db = openSessionStore()
            try {
                const rows = listSessions(db, { since: dayIso(args.since), until: dayIso(args.until), project: args.project || undefined, limit: 5000 })
                const fams = buildSessionTree(rows, listSubagents(db, rows.map((r) => r.session_id)))
                const want = args.kind || 'work'
                const out = fams
                    .filter((f) => want === 'all' || effectiveKind(f) === want)
                    .slice(0, args.limit || 500)
                    .map((f) => {
                        const s = parseSummary(f)
                        return {
                            session_id: f.session_id, started_at: f.started_at, ended_at: f.ended_at,
                            project: f.project_dir ? path.basename(f.project_dir) : null, project_dir: f.project_dir,
                            harness: f.entrypoint, model: f.model,
                            active_min: Math.round((f.rollup.active_s || 0) / 60), turns: f.rollup.turns,
                            cost_usd: Number((f.rollup.cost_usd || 0).toFixed(2)), sub_sessions: f.sub_count,
                            git_branch: f.git_branch, ticket_id: f.ticket_id,
                            kind: effectiveKind(f), title: displayTitle(f),
                            summary: s ? { what: s.what, outcome: s.outcome, improvements: s.improvements || [], followups: s.followups || [] } : null,
                        }
                    })
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
            } finally {
                db.close()
            }
        }

        case 'summarize_sessions': {
            const db = openSessionStore()
            try {
                const ids = selectMissing(db, { since: dayIso(args.since), until: dayIso(args.until), force: args.force ?? false })
                const { job, started } = startBatch(db, { ids, model: batchModel(), openDb: openSessionStore })
                const estimateSeconds = estimateBatch(db, { count: job.total - job.done - job.failed.length }).seconds
                const note = started
                    ? `Started: ${job.total} sessions. Call summarize_sessions again to see progress.`
                    : `A batch is already running (${job.done}/${job.total}); this call did not start another.`
                return { content: [{ type: 'text', text: JSON.stringify({ started, job: { job_id: job.job_id, status: job.status, done: job.done, total: job.total, failed: job.failed }, estimateSeconds, note }, null, 2) }] }
            } finally {
                db.close()
            }
        }
```

(`path` is already imported in server.mjs; if not, add `import path from 'path'`.) The batch keeps running in the MCP process after the tool returns; its worker uses its own connection from `openSessionStore`.

- [ ] **Step 4: Run the smoke test**

Run: `node src/mcp/server.smoke.mjs`
Expected: `OK: new MCP tools present: …, list_sessions, summarize_sessions`

- [ ] **Step 5: Update `CLAUDE.md`** — MCP Server section: "Tools (23)", add a bullet line `- \`list_sessions\` (period + kind filter, rollup numbers, summary), \`summarize_sessions\` (background batch, cross-process job state)`.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.mjs src/mcp/server.smoke.mjs CLAUDE.md
git commit -m "feat(mcp): list_sessions and summarize_sessions tools"
```

---

### Task 13: One-off PoC summary import

**Files:**
- Create: `scripts/cc-import-summaries.mjs`, `scripts/cc-import-summaries.test.mjs`
- Modify: `package.json` (script `"cc:import-summaries": "node --disable-warning=ExperimentalWarning scripts/cc-import-summaries.mjs"`)

**Interfaces:**
- Consumes: `setSummary`, `openStore` (store), `summaryVersion` (summary-view), `OUTCOMES` (summary.mjs).
- Produces: `pocToSummary(entry, model): object` (summary v2), `importSummaries(db, entries, { model = 'sonnet-poc', dryRun = false }): { written, kept, missing }` — writes where the row exists and `summaryVersion(row) < 2`.

- [ ] **Step 1: Write the failing test** — `scripts/cc-import-summaries.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, getSession } from '../src/lib/cc/store.mjs';
import { importSummaries, pocToSummary } from './cc-import-summaries.mjs';

const entry = (id, over = {}) => ({ session_id: id, title: 'T', what: 'W', outcome: 'exploration', improvements: ['a'], followups: [], kind: 'agent-spawn', skip_reason: 'x', ...over });

test('importSummaries fills missing and v1 summaries, keeps v2, counts unknown ids', () => {
  const db = openStore(':memory:');
  for (const id of ['none', 'v1', 'v2']) upsertSession(db, { session_id: id });
  setSummary(db, 'v1', { summary: JSON.stringify({ what: 'old', outcome: 'done' }), model: 'haiku' });
  setSummary(db, 'v2', { summary: JSON.stringify({ v: 2, what: 'keep', outcome: 'done' }), model: 'claude-sonnet-5-5' });
  const r = importSummaries(db, [entry('none'), entry('v1'), entry('v2'), entry('ghost')]);
  assert.deepEqual(r, { written: 2, kept: 1, missing: 1 });
  const s = JSON.parse(getSession(db, 'v1').session.summary);
  assert.deepEqual([s.v, s.title, s.outcome, s.kind_hint, s.model], [2, 'T', 'exploration', 'agent-spawn', 'sonnet-poc']);
  assert.equal(getSession(db, 'v1').session.summary_model, 'sonnet-poc');
  assert.equal(JSON.parse(getSession(db, 'v2').session.summary).what, 'keep');
});

test('pocToSummary normalises odd values', () => {
  const s = pocToSummary(entry('x', { outcome: 'weird', kind: 'nope', improvements: 'str', followups: [1, 'b'] }), 'm');
  assert.equal(s.outcome, 'partial');
  assert.equal(s.kind_hint, 'work');
  assert.deepEqual(s.improvements, []);
  assert.deepEqual(s.followups, ['b']);
});

test('dryRun writes nothing', () => {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 'none' });
  assert.equal(importSummaries(db, [entry('none')], { dryRun: true }).written, 1);
  assert.equal(getSession(db, 'none').session.summary, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cc-import-summaries.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/cc-import-summaries.mjs`**

```js
#!/usr/bin/env node
/**
 * One-off: import the PoC's hand-checked session descriptions (vault
 * 99-Meta/ai-sessions/2026-09/sessions.json) as summary v2, so September is
 * filled in without re-generating it. Writes only where a session has no
 * summary or an old v1 one; v2 summaries are never touched.
 *
 *   npm run cc:import-summaries -- <sessions.json> [--dry-run]
 *
 * Run after `npm run cc:ingest` (Codex sessions must be in the store first).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openStore, setSummary } from '../src/lib/cc/store.mjs';
import { summaryVersion } from '../src/lib/cc/summary-view.mjs';
import { OUTCOMES } from '../src/lib/cc/summary.mjs';

const HINTS = ['work', 'scheduled', 'agent-spawn', 'trivial'];
const strings = (x, n) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string').slice(0, n) : []);

export function pocToSummary(e, model) {
  return {
    v: 2,
    title: typeof e.title === 'string' && e.title.trim() ? e.title.trim() : null,
    what: typeof e.what === 'string' ? e.what : '',
    outcome: OUTCOMES.includes(e.outcome) ? e.outcome : 'partial',
    improvements: strings(e.improvements, 5),
    followups: strings(e.followups, 4),
    kind_hint: HINTS.includes(e.kind) ? e.kind : 'work',
    model,
  };
}

export function importSummaries(db, entries, { model = 'sonnet-poc', dryRun = false } = {}) {
  const res = { written: 0, kept: 0, missing: 0 };
  const get = db.prepare('SELECT session_id, summary FROM sessions WHERE session_id = ?');
  for (const e of entries || []) {
    const row = e?.session_id ? get.get(e.session_id) : null;
    if (!row) { res.missing++; continue; }
    if (summaryVersion(row) >= 2) { res.kept++; continue; }
    if (!dryRun) setSummary(db, e.session_id, { summary: JSON.stringify(pocToSummary(e, model)), model });
    res.written++;
  }
  return res;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
  if (!positionals[0]) { console.error('usage: cc-import-summaries <sessions.json> [--dry-run]'); process.exit(2); }
  const entries = JSON.parse(await readFile(positionals[0], 'utf8'));
  const db = openStore();
  const r = importSummaries(db, entries, { dryRun: values['dry-run'] });
  db.close();
  console.log(`cc-import-summaries: ${r.written} written, ${r.kept} kept (already v2), ${r.missing} not in store${values['dry-run'] ? ' (dry run)' : ''}`);
}
```

Add the npm script to `package.json`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cc-import-summaries.test.mjs`
Expected: PASS

- [ ] **Step 5: Dry run on the real PoC file**

Run: `npm run cc:import-summaries -- "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Erickov mind/99-Meta/ai-sessions/2026-09/sessions.json" --dry-run`
Expected: `217 written, 0 kept, 0 not in store (dry run)` (after Task 5 ingested the 2 Codex sessions; before that, `missing` is 2). Do **not** run it without `--dry-run` here — the real import is Task 20's step.

- [ ] **Step 6: Commit**

```bash
git add scripts/cc-import-summaries.mjs scripts/cc-import-summaries.test.mjs package.json
git commit -m "feat(cc): one-off import of PoC session descriptions as summary v2"
```

---

# Part D — F4 Calendar

### Task 14: Analytics `perDay` by local day

**Files:**
- Modify: `src/lib/cc/session-tree.mjs` (export `localDay`), `src/lib/cc/analytics.mjs`
- Test: `src/lib/cc/analytics.test.mjs`

**Interfaces:**
- Produces: `export function localDay(d: Date): 'YYYY-MM-DD'` from session-tree.mjs; `sessionAnalytics().perDay` keyed by local day (same row shape `{day, sessions, cost_usd, tokens}`).

- [ ] **Step 1: Write the failing test** — append to `src/lib/cc/analytics.test.mjs` (import `localDay` from `./session-tree.mjs`):

```js
test('sessionAnalytics perDay buckets by local day, like /sessions', () => {
  const db = openStore(':memory:')
  // 23:30 local on Sep 1 — UTC may already be Sep 2 (or still Sep 1 west of UTC).
  const late = new Date(2026, 8, 1, 23, 30)
  upsertSession(db, { session_id: 'a', started_at: late.toISOString(), cost_usd: 2, input_tokens: 1, output_tokens: 1 })
  upsertSession(db, { session_id: 'k', started_at: late.toISOString(), cost_usd: 1, input_tokens: 0, output_tokens: 0 })
  setParent(db, 'k', 'a')
  const a = sessionAnalytics(db)
  assert.deepEqual(a.perDay.map((d) => [d.day, d.sessions, d.cost_usd, d.tokens]), [[localDay(late), 1, 3, 2]])
  db.close()
})
```

(Import `setParent` from store if missing.)

- [ ] **Step 2: Run to verify it fails** — force a zone west of UTC, where 23:30 local is already the next UTC day (in CEST the two days coincide at 23:30 and the bug would not show):

Run: `TZ=America/Los_Angeles node --disable-warning=ExperimentalWarning --test src/lib/cc/analytics.test.mjs`
Expected: FAIL — `perDay` has day `2026-09-02` (UTC) instead of `2026-09-01` (local).

- [ ] **Step 3: Implement**

`src/lib/cc/session-tree.mjs`: change `function localDay(d)` to `export function localDay(d)`.

`src/lib/cc/analytics.mjs`: `import { localDay } from './session-tree.mjs'` and replace the `perDayRaw` SQL with:

```js
  // Local calendar days (the server runs on the user's machine), matching the
  // /sessions table and calendar; SQL substr() would bucket by UTC day.
  const perDayMap = new Map()
  for (const r of all(`SELECT s.started_at, s.parent_session_id, s.cost_usd, s.input_tokens, s.output_tokens FROM sessions s ${where}`)) {
    const t = Date.parse(r.started_at || '')
    if (!Number.isFinite(t)) continue
    const day = localDay(new Date(t))
    const d = perDayMap.get(day) || { day, sessions: 0, cost_usd: 0, tokens: 0 }
    if (!r.parent_session_id) d.sessions++
    d.cost_usd += r.cost_usd || 0
    d.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
    perDayMap.set(day, d)
  }
  const perDayRaw = [...perDayMap.values()].sort((a, b) => a.day.localeCompare(b.day))
```

(`fillDays` stays: it walks calendar dates, which is timezone-independent.)

- [ ] **Step 4: Run to verify it passes in two time zones**

Run: `TZ=America/Los_Angeles node --disable-warning=ExperimentalWarning --test src/lib/cc/analytics.test.mjs && TZ=Europe/Bratislava node --disable-warning=ExperimentalWarning --test src/lib/cc/analytics.test.mjs`
Expected: PASS twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/session-tree.mjs src/lib/cc/analytics.mjs src/lib/cc/analytics.test.mjs
git commit -m "fix(cc): analytics perDay uses local days"
```

---

### Task 15: `session-calendar.mjs` — pure calendar maths

**Files:**
- Create: `src/lib/cc/session-calendar.mjs`, `src/lib/cc/session-calendar.test.mjs`

**Interfaces:**
- Consumes: `effectiveKind` (Task 2), `summaryVersion`, `parseSummary`, `needsSummary` (Task 2), `sourceOf` (session-filters).
- Produces (all pure, client-safe):
  - `periodRange(date: Date, span: 'week'|'month'): { span, since: Date, until: Date, days: Date[] }` — week: Monday 00:00 + 7 days; month: 1st 00:00 → 1st of next month, `days` = full Monday-first weeks covering the month.
  - `shiftPeriod(date, span, dir: -1|1): Date`, `periodLabel(range): string`
  - `calendarSlot(row): { start: Date, end: Date } | null`
  - `daySegment(slot, day: Date): { top: number, height: number, continued: boolean, continues: boolean } | null` — minutes from local midnight, clipped to the day, `top + height ≤ 1440`.
  - `layoutDay(items: {id, start: number, end: number}[]): Map<id, {col, cols}>`
  - `projectColor(dir): string` (`var(--viz-1..6)`), `harnessBadge(row): { letter: 'C'|'G'|'X', label: string }`
  - `calendarFamilies(families, { showAll }): Array<family & { ek: string, muted: boolean }>`
  - `missingSummaryIds(events, now = Date.now()): string[]`
  - `periodStats(events): { sessions, active_s, cost_usd, done, partial, described }`
  - `formatEta(seconds): string`

- [ ] **Step 1: Write the failing tests** — `src/lib/cc/session-calendar.test.mjs` (dates built with the local `Date` constructor so the tests pass in any time zone):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodRange, shiftPeriod, calendarSlot, daySegment, layoutDay, projectColor, harnessBadge,
  calendarFamilies, missingSummaryIds, periodStats, formatEta,
} from './session-calendar.mjs';

const L = (d, h = 0, m = 0) => new Date(2026, 8, d, h, m); // September 2026, local
const iso = (d) => d.toISOString();

test('periodRange: week starts Monday even for a Sunday; month covers full weeks', () => {
  const w = periodRange(L(13, 15), 'week'); // Sunday 13 Sep
  assert.equal(+w.since, +L(7));
  assert.equal(+w.until, +L(14));
  assert.equal(w.days.length, 7);
  const m = periodRange(L(9), 'month');
  assert.equal(+m.since, +L(1));
  assert.equal(+m.until, +new Date(2026, 9, 1));
  assert.equal(+m.days[0], +new Date(2026, 7, 31)); // Mon 31 Aug
  assert.equal(m.days.length % 7, 0);
  assert.equal(+shiftPeriod(L(9), 'week', 1), +L(16));
  assert.equal(shiftPeriod(L(9), 'month', -1).getMonth(), 7);
});

test('calendarSlot: real end up to 5 h, else max(active, 30 min); at least 15 min', () => {
  const s = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 12)), active_s: 600 });
  assert.equal(+s.end, +L(9, 12));
  const overnight = calendarSlot({ started_at: iso(L(9, 18)), ended_at: iso(L(10, 9)), active_s: 3600 });
  assert.equal(+overnight.end, +L(9, 19));
  const idle = calendarSlot({ started_at: iso(L(9, 18)), ended_at: iso(L(10, 9)), active_s: 60 });
  assert.equal(+idle.end, +L(9, 18, 30));
  const tiny = calendarSlot({ started_at: iso(L(9, 10)), ended_at: iso(L(9, 10, 2)) });
  assert.equal(+tiny.end, +L(9, 10, 15));
  const open = calendarSlot({ started_at: iso(L(9, 10)), ended_at: null, active_s: 0 });
  assert.equal(+open.end, +L(9, 10, 30));
  assert.equal(calendarSlot({ started_at: null }), null);
});

test('daySegment clips a session that crosses midnight onto both days', () => {
  const slot = calendarSlot({ started_at: iso(L(9, 23)), ended_at: iso(L(10, 1)) });
  assert.deepEqual(daySegment(slot, L(9)), { top: 23 * 60, height: 60, continued: false, continues: true });
  assert.deepEqual(daySegment(slot, L(10)), { top: 0, height: 60, continued: true, continues: false });
  assert.equal(daySegment(slot, L(11)), null);
  const edge = daySegment({ start: L(9, 23, 55), end: L(10, 0, 0) }, L(9));
  assert.equal(edge.top + edge.height, 1440, 'min height never spills past midnight');
});

test('layoutDay puts overlapping events side by side, separate clusters full width', () => {
  const lay = layoutDay([
    { id: 'a', start: 60, end: 180 }, { id: 'b', start: 120, end: 150 }, { id: 'c', start: 130, end: 200 },
    { id: 'd', start: 300, end: 360 },
  ]);
  assert.deepEqual(lay.get('a'), { col: 0, cols: 3 });
  assert.deepEqual(lay.get('b'), { col: 1, cols: 3 });
  assert.deepEqual(lay.get('c'), { col: 2, cols: 3 });
  assert.deepEqual(lay.get('d'), { col: 0, cols: 1 });
});

test('projectColor is stable; harnessBadge maps sources', () => {
  assert.equal(projectColor('/p/app'), projectColor('/p/app'));
  assert.match(projectColor('/p/app'), /^var\(--viz-[1-6]\)$/);
  assert.match(projectColor(null), /^var\(--viz-[1-6]\)$/);
  assert.equal(harnessBadge({ entrypoint: 'codex-desktop' }).letter, 'X');
  assert.equal(harnessBadge({ entrypoint: 'antigravity' }).letter, 'G');
  assert.equal(harnessBadge({ entrypoint: 'claude-desktop' }).letter, 'C');
});

test('calendarFamilies hides non-work unless showAll, then mutes it', () => {
  const fams = [{ session_id: 'w', kind: 'main' }, { session_id: 's', kind: 'scheduled' }];
  assert.deepEqual(calendarFamilies(fams, { showAll: false }).map((f) => f.session_id), ['w']);
  const all = calendarFamilies(fams, { showAll: true });
  assert.deepEqual(all.map((f) => [f.session_id, f.ek, f.muted]), [['w', 'work', false], ['s', 'scheduled', true]]);
});

test('missingSummaryIds skips described and still-running sessions; periodStats sums rollups', () => {
  const now = +L(30, 12);
  const ev = [
    { session_id: 'a', raw_ref: '/t', ended_at: iso(L(9, 11)), rollup: { active_s: 600, cost_usd: 1 } },
    { session_id: 'b', raw_ref: '/t', ended_at: iso(L(9, 11)), summary: JSON.stringify({ v: 2, outcome: 'done' }), rollup: { active_s: 1200, cost_usd: 2 } },
    { session_id: 'c', raw_ref: '/t', ended_at: new Date(now - 60_000).toISOString(), rollup: { active_s: 0, cost_usd: 0 } },
    { session_id: 'd', raw_ref: '/t', ended_at: iso(L(9, 11)), summary: JSON.stringify({ outcome: 'partial' }), rollup: { active_s: 0, cost_usd: 0.5 } },
  ];
  assert.deepEqual(missingSummaryIds(ev, now), ['a']);
  assert.deepEqual(periodStats(ev), { sessions: 4, active_s: 1800, cost_usd: 3.5, done: 1, partial: 1, described: 2 });
});

test('formatEta', () => {
  assert.equal(formatEta(20), '<1 min');
  assert.equal(formatEta(240), '~4 min');
  assert.equal(formatEta(5400), '~1.5 h');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/session-calendar.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/cc/session-calendar.mjs`**

```js
/**
 * Calendar maths for /sessions (week and month views). Pure and client-safe;
 * all day boundaries are LOCAL time, weeks start on Monday.
 *
 * Placement (spec F4): a session is drawn from `started_at` to `ended_at` when
 * that span is at most 5 h; longer spans are desktop sessions left open (often
 * overnight), drawn as start + max(active time, 30 min). Minimum height 15 min.
 */
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format,
  startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { effectiveKind } from './session-link.mjs';
import { needsSummary, parseSummary, summaryVersion } from './summary-view.mjs';
import { sourceOf } from './session-filters.mjs';

const WEEK = { weekStartsOn: 1 };
export const MAX_SPAN_MS = 5 * 3600_000;
export const FALLBACK_MS = 30 * 60_000;
export const MIN_MS = 15 * 60_000;
const DAY_MIN = 24 * 60;
const MIN_HEIGHT = 15;

export function periodRange(date, span = 'week') {
  if (span === 'month') {
    const since = startOfMonth(date);
    const days = eachDayOfInterval({ start: startOfWeek(since, WEEK), end: endOfWeek(endOfMonth(since), WEEK) });
    return { span: 'month', since, until: addMonths(since, 1), days };
  }
  const since = startOfWeek(date, WEEK);
  return { span: 'week', since, until: addDays(since, 7), days: eachDayOfInterval({ start: since, end: addDays(since, 6) }) };
}

export function shiftPeriod(date, span, dir) {
  return span === 'month' ? addMonths(date, dir) : addWeeks(date, dir);
}

export function periodLabel(range) {
  if (range.span === 'month') return format(range.since, 'LLLL yyyy');
  return `${format(range.since, 'd MMM')} – ${format(addDays(range.since, 6), 'd MMM yyyy')}`;
}

export function calendarSlot(s) {
  const start = Date.parse(s?.started_at || '');
  if (!Number.isFinite(start)) return null;
  const endRaw = Date.parse(s.ended_at || '');
  let end = Number.isFinite(endRaw) && endRaw > start && endRaw - start <= MAX_SPAN_MS
    ? endRaw
    : start + Math.max((s.active_s || 0) * 1000, FALLBACK_MS);
  if (end - start < MIN_MS) end = start + MIN_MS;
  return { start: new Date(start), end: new Date(end) };
}

/** The part of `slot` on local `day`, in minutes from midnight; null when they don't meet. */
export function daySegment(slot, day) {
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  const a = Math.max(slot.start.getTime(), d0);
  const b = Math.min(slot.end.getTime(), d1);
  if (b <= a) return null;
  const height = Math.min(Math.max((b - a) / 60000, MIN_HEIGHT), DAY_MIN);
  const top = Math.min((a - d0) / 60000, DAY_MIN - height);
  return { top, height, continued: slot.start.getTime() < d0, continues: slot.end.getTime() > d1 };
}

/** Greedy column layout for overlapping items of one day; `cols` is the width of the item's overlap cluster. */
export function layoutDay(items) {
  const sorted = [...items].sort((x, y) => x.start - y.start || y.end - x.end);
  const out = new Map();
  let cluster = [], colsEnd = [], clusterEnd = -Infinity;
  const flush = () => {
    for (const id of cluster) out.get(id).cols = colsEnd.length;
    cluster = []; colsEnd = []; clusterEnd = -Infinity;
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) flush();
    let col = colsEnd.findIndex((e) => e <= it.start);
    if (col === -1) { col = colsEnd.length; colsEnd.push(it.end); } else colsEnd[col] = it.end;
    out.set(it.id, { col, cols: 0 });
    cluster.push(it.id);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/** Deterministic project colour from the dataviz palette. */
export function projectColor(dir) {
  let h = 5381;
  for (const ch of String(dir || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `var(--viz-${1 + (h % 6)})`;
}

export function harnessBadge(s) {
  const src = sourceOf(s);
  if (src === 'codex') return { letter: 'X', label: 'Codex' };
  if (src === 'antigravity') return { letter: 'G', label: 'Antigravity' };
  return { letter: 'C', label: 'Claude Code' };
}

/** Families to draw: work always, the rest only with showAll (muted). */
export function calendarFamilies(families, { showAll = false } = {}) {
  const out = [];
  for (const f of families || []) {
    const ek = effectiveKind(f);
    if (ek !== 'work' && !showAll) continue;
    out.push({ ...f, ek, muted: ek !== 'work' });
  }
  return out;
}

/** Shown events with no summary at all that a batch may process (not written to in the last 10 min). */
export function missingSummaryIds(events, now = Date.now()) {
  return (events || []).filter((e) => needsSummary(e, { now })).map((e) => e.session_id);
}

export function periodStats(events) {
  const out = { sessions: 0, active_s: 0, cost_usd: 0, done: 0, partial: 0, described: 0 };
  for (const e of events || []) {
    const r = e.rollup || e;
    out.sessions++;
    out.active_s += r.active_s || 0;
    out.cost_usd += r.cost_usd || 0;
    if (summaryVersion(e) > 0) out.described++;
    const o = parseSummary(e)?.outcome;
    if (o === 'done') out.done++;
    if (o === 'partial') out.partial++;
  }
  return out;
}

export function formatEta(seconds) {
  if (seconds < 60) return '<1 min';
  if (seconds >= 90 * 60) return `~${(seconds / 3600).toFixed(1)} h`;
  return `~${Math.round(seconds / 60)} min`;
}
```

- [ ] **Step 4: Run to verify it passes (twice, two time zones)**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/session-calendar.test.mjs && TZ=America/Los_Angeles node --disable-warning=ExperimentalWarning --test src/lib/cc/session-calendar.test.mjs`
Expected: PASS twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/session-calendar.mjs src/lib/cc/session-calendar.test.mjs
git commit -m "feat(cc): calendar placement and layout maths"
```

---

### Task 16: `/sessions` — view toggle, URL state, range loading, SummaryBlock v2, title search

**Files:**
- Modify: `src/app/sessions/page.js`, `src/lib/cc/session-filters.mjs`, `src/lib/cc/session-filters.test.mjs`

**Interfaces:**
- Consumes: `periodRange`, `shiftPeriod` (Task 15); `displayTitle`, `parseSummary`, `summaryVersion`, `OUTCOME_ICON` (Task 2); `effectiveKind` (Task 2); `GET /api/sessions?since&until` (Task 8).
- Produces: URL `?view=calendar&span=week|month&date=YYYY-MM-DD` (+ existing `project`); `load({ ingest })`; the `CalendarView` mount point (Task 17 fills it); search matches the display title.

- [ ] **Step 1: Write the failing filter test** — append to `src/lib/cc/session-filters.test.mjs`:

```js
test('search also matches the display title', () => {
  const rows = [{ session_id: 'a', title: 'Fix login redirect', title_source: 'prompt' }, { session_id: 'b', summary: JSON.stringify({ v: 2, title: 'Pricing sync' }) }];
  assert.deepEqual(filterSessions(rows, { search: 'login' }).map((r) => r.session_id), ['a']);
  assert.deepEqual(filterSessions(rows, { search: 'pricing' }).map((r) => r.session_id), ['b']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/session-filters.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement the filter** — in `session-filters.mjs` import `displayTitle` from `./summary-view.mjs` and in `filterSessions`' needle block add `const matchTitle = (displayTitle(s) || '').toLowerCase().includes(needle)` and include it in the `if (!… && !matchTitle) return false` condition. Run the test → PASS.

- [ ] **Step 4: Page state and loading** — in `src/app/sessions/page.js`:

Imports: add `import { format, parse, isValid } from 'date-fns'`, `import { periodRange } from '@/lib/cc/session-calendar.mjs'`, `import { displayTitle, parseSummary, summaryVersion, OUTCOME_ICON } from '@/lib/cc/summary-view.mjs'`, `import { effectiveKind } from '@/lib/cc/session-link.mjs'` (merge with the existing `CHILD_KINDS` import), `import { CalendarView } from './calendar-view'`, and `CalendarDays, Table2` from `lucide-react`.

At the top of `SessionsView`, after `project`:

```js
  const view = searchParams.get('view') === 'calendar' ? 'calendar' : 'table'
  const span = searchParams.get('span') === 'month' ? 'month' : 'week'
  const dateParam = searchParams.get('date') || ''
  const date = useMemo(() => {
    const d = dateParam ? parse(dateParam, 'yyyy-MM-dd', new Date()) : new Date()
    return isValid(d) ? d : new Date()
  }, [dateParam])
  const range = useMemo(() => periodRange(date, span), [date, span])
  const rangeKey = `${range.since.toISOString()}|${range.until.toISOString()}`

  /** Merge into the current query string (null deletes) and replace the URL. */
  function setParams(patch) {
    const qs = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) (v == null ? qs.delete(k) : qs.set(k, v))
    const s = qs.toString() // not qs.size: older WebKit (desktop shell) lacks it
    router.replace(`/sessions${s ? `?${s}` : ''}`)
  }
```

Replace `load` and its effect:

```js
  async function load({ ingest = true } = {}) {
    setLoading(true)
    try {
      // Bring the store up to date first (incremental: ~0.1 s when nothing changed).
      if (ingest) await fetch('/api/sessions/ingest', { method: 'POST' }).catch(() => {})
      const qs = new URLSearchParams(project ? { project } : {})
      if (view === 'calendar') { qs.set('since', range.since.toISOString()); qs.set('until', range.until.toISOString()) }
      else qs.set('limit', '1000')
      const r = await fetch(`/api/sessions?${qs}`)
      const d = await r.json()
      setSessions(d.sessions || [])
      setAgents(d.agents || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [project, view, rangeKey]) // eslint-disable-line react-hooks/exhaustive-deps
```

Change the Reload button to `onClick={() => load()}`. Change the `project` chip and `onFilterProject` to keep the other params: `setParams({ project: null })` and `(dir) => setParams({ project: dir || null })`.

- [ ] **Step 5: Header toggle and body switch** — in the header's left group, right after `<h1>`:

```jsx
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="View">
              {[['table', Table2, 'Table'], ['calendar', CalendarDays, 'Calendar']].map(([v, Icon, label]) => (
                <button key={v} role="tab" aria-selected={view === v}
                  onClick={() => setParams({ view: v === 'table' ? null : v })}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${view === v ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
```

Render the Group `<select>` only when `view === 'table'`. In the body, wrap the existing `<table>` and its empty-state paragraphs in `{view === 'table' && (<> … </>)}` and add:

```jsx
          {view === 'calendar' && (
            <CalendarView
              families={filtered}
              range={range}
              selected={selected}
              onOpen={open}
              onNavigate={(d) => setParams({ date: format(d, 'yyyy-MM-dd') })}
              onSpan={(s) => setParams({ span: s === 'week' ? null : s })}
              onRefresh={() => load({ ingest: false })}
            />
          )}
```

Also in `summarize(id)` after the successful response, update the row with the whole fresh session (so title/summary both refresh): `setSessions((prev) => prev.map((s) => (s.session_id === id ? { ...s, ...d.session } : s)))`.

- [ ] **Step 6: SummaryBlock v2** — replace `SummaryBlock` with:

```jsx
function SummaryBlock({ s, onSummarize, summarizing, error }) {
  const sum = parseSummary(s)
  const v = summaryVersion(s)
  const title = displayTitle(s)
  const kind = effectiveKind(s)
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium">Summary</h3>
        <Button variant="outline" size="sm" onClick={() => onSummarize(s.session_id)} disabled={summarizing}>
          <Sparkles className={`h-3.5 w-3.5 mr-1 ${summarizing ? 'animate-pulse' : ''}`} /> {summarizing ? 'Working…' : sum ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
      {title && <p className="text-sm font-medium mb-1">{title}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!sum && !error && <p className="text-xs text-muted-foreground">No summary yet — uses your local <code>claude</code> CLI (~1k tokens).</p>}
      {sum && (
        <div className="space-y-1 text-xs">
          <p>{sum.what}</p>
          <Row label="Outcome" value={sum.outcome ? `${OUTCOME_ICON[sum.outcome] || ''} ${sum.outcome}` : '—'} />
          <Row label="Kind" value={kind} />
          {sum.improvements?.length > 0 && <div><span className="text-muted-foreground">Improvements:</span><ul className="list-disc pl-4">{sum.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {sum.followups?.length > 0 && <div><span className="text-muted-foreground">Follow-ups:</span><ul className="list-disc pl-4">{sum.followups.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          <p className="text-muted-foreground">{s.summary_model} · {fmtStart(s.summarized_at)}{v === 1 ? ' · older format, Regenerate to add a title' : ''}</p>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Temporary placeholder so the page builds before Task 17** — create `src/app/sessions/calendar-view.js`:

```jsx
'use client'

export function CalendarView() {
  return <p className="text-sm text-muted-foreground py-6">Calendar coming up.</p>
}
```

- [ ] **Step 8: Verify in the browser** — `preview_start` the dev server (`npm run dev`, port 3089; add a `.claude/launch.json` entry `{ "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3089 }` if missing), open `/sessions`: the table works as before, the toggle switches to the placeholder and back, the URL carries `view=calendar`, Reload works, the detail panel shows title/kind for a summarised session. Check `read_console_messages` for errors.

- [ ] **Step 9: Run lint and tests, commit**

Run: `npm run lint && npm test`
Expected: no new lint errors; all tests PASS.

```bash
git add src/app/sessions/page.js src/app/sessions/calendar-view.js src/lib/cc/session-filters.mjs src/lib/cc/session-filters.test.mjs
git commit -m "feat(sessions): table/calendar toggle, URL state and summary v2 block"
```

---

### Task 17: Week grid

**Files:**
- Modify: `src/app/sessions/calendar-view.js` (replace the placeholder)

**Interfaces:**
- Consumes: Task 15 exports; `displayTitle`, `parseSummary`, `OUTCOME_ICON` (Task 2).
- Produces: `CalendarView({ families, range, selected, onOpen, onNavigate, onSpan, onRefresh })` (the props Task 16 passes); internal `PeriodHeader`, `WeekGrid`, `EventBlock`, `HarnessBadge`; `MonthGrid` and `SummaryBanner` are wired in Tasks 18–19.

- [ ] **Step 1: Write the component** — `src/app/sessions/calendar-view.js`:

```jsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isToday } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  calendarFamilies, calendarSlot, daySegment, harnessBadge, layoutDay, periodLabel, periodStats,
  projectColor, shiftPeriod,
} from '@/lib/cc/session-calendar.mjs'
import { displayTitle, OUTCOME_ICON, parseSummary } from '@/lib/cc/summary-view.mjs'

const HOUR_PX = 44
const projectName = (dir) => (dir ? dir.split('/').filter(Boolean).at(-1) : '—')
const fmtCost = (c) => `$${(c || 0).toFixed(2)}`
const fmtHours = (s) => `${(s / 3600).toFixed(1)} h`

export function CalendarView({ families, range, selected, onOpen, onNavigate, onSpan, onRefresh }) {
  const [showAll, setShowAll] = useState(false)
  const events = useMemo(() => calendarFamilies(families, { showAll }), [families, showAll])
  const stats = periodStats(events.filter((e) => !e.muted))
  return (
    <div className="flex h-full flex-col">
      <PeriodHeader range={range} stats={stats} showAll={showAll} onShowAll={setShowAll} onNavigate={onNavigate} onSpan={onSpan} />
      {range.span === 'week'
        ? <WeekGrid days={range.days} events={events} selected={selected} onOpen={onOpen} />
        : <p className="py-6 text-sm text-muted-foreground">Month view coming up.</p>}
    </div>
  )
}

function PeriodHeader({ range, stats, showAll, onShowAll, onNavigate, onSpan }) {
  const doneShare = stats.described ? Math.round((stats.done / stats.described) * 100) : null
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" aria-label="Previous" onClick={() => onNavigate(shiftPeriod(range.since, range.span, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="sm" onClick={() => onNavigate(new Date())}>Today</Button>
        <Button variant="outline" size="sm" aria-label="Next" onClick={() => onNavigate(shiftPeriod(range.since, range.span, 1))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
      <h2 className="text-sm font-semibold">{periodLabel(range)}</h2>
      <div className="inline-flex rounded-md border p-0.5">
        {['week', 'month'].map((s) => (
          <button key={s} onClick={() => onSpan(s)} aria-pressed={range.span === s}
            className={`rounded px-2 py-0.5 text-xs capitalize ${range.span === s ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{s}</button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {stats.sessions} sessions · {fmtHours(stats.active_s)} active · {fmtCost(stats.cost_usd)}
        {doneShare != null && ` · ${doneShare}% done, ${stats.partial} partial`}
      </span>
      <button onClick={() => onShowAll(!showAll)} aria-pressed={showAll}
        className={`ml-auto rounded-full border px-2 py-0.5 text-xs ${showAll ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title="Also show agent spawns, scheduled runs and trivial sessions (muted)">+ agent/scheduled</button>
    </div>
  )
}

function WeekGrid({ days, events, selected, onOpen }) {
  const scroller = useRef(null)
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX }, [])
  const perDay = useMemo(() => days.map((day) => {
    const segs = []
    for (const e of events) {
      const slot = calendarSlot(e)
      const seg = slot && daySegment(slot, day)
      if (seg) segs.push({ ...seg, e })
    }
    const lay = layoutDay(segs.map((s) => ({ id: s.e.session_id, start: s.top, end: s.top + s.height })))
    return segs.map((s) => ({ ...s, ...lay.get(s.e.session_id) }))
  }), [days, events])

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border">
      <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b text-xs">
        <div />
        {days.map((d) => (
          <div key={+d} className={`px-1 py-1 text-center ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'EEE d.M.')}</div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ top: h * HOUR_PX }}>{h ? `${h}:00` : ''}</div>
            ))}
          </div>
          {perDay.map((segs, i) => (
            <div key={+days[i]} className={`relative border-l ${isToday(days[i]) ? 'bg-muted/30' : ''}`}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-border/50" style={{ top: h * HOUR_PX }} />)}
              {segs.map((s) => (
                <EventBlock key={s.e.session_id} e={s.e} selected={selected === s.e.session_id} onOpen={onOpen}
                  style={{ top: (s.top / 60) * HOUR_PX, height: Math.max((s.height / 60) * HOUR_PX - 1, 14), left: `calc(${(s.col / s.cols) * 100}% + 1px)`, width: `calc(${100 / s.cols}% - 2px)` }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function HarnessBadge({ e }) {
  const b = harnessBadge(e)
  return <span title={b.label} className="inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm bg-foreground/10 text-[9px] font-bold">{b.letter}</span>
}

function OutcomeMark({ e }) {
  const sum = parseSummary(e)
  if (!sum) return <span title="No summary" className="inline-block h-1.5 w-1.5 flex-none rounded-full bg-muted-foreground" />
  return <span title={sum.outcome} className="flex-none">{OUTCOME_ICON[sum.outcome] || ''}</span>
}

export function EventBlock({ e, style, selected, onOpen, compact = false }) {
  const title = displayTitle(e) || 'Untitled session'
  const color = projectColor(e.project_dir)
  const r = e.rollup || e
  const mins = Math.round((r.active_s || 0) / 60)
  const tip = `${title}\n${projectName(e.project_dir)} · ${format(new Date(e.started_at), 'HH:mm')} · ${mins} min active · ${fmtCost(r.cost_usd)}${e.sub_count ? ` · +${e.sub_count} sub` : ''}`
  return (
    <button onClick={() => onOpen(e.session_id)} title={tip}
      className={`${compact ? 'relative w-full' : 'absolute'} overflow-hidden rounded-sm border-l-4 px-1 py-0.5 text-left text-[11px] leading-tight hover:z-10 hover:shadow ${e.muted ? 'opacity-50' : ''} ${selected ? 'ring-2 ring-ring' : ''}`}
      style={{ ...style, borderLeftColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
      <div className="flex items-center gap-1 font-medium">
        <HarnessBadge e={e} />
        <span className="truncate">{title}</span>
        <OutcomeMark e={e} />
      </div>
      {!compact && <div className="truncate text-muted-foreground">{projectName(e.project_dir)} · {mins} min · {fmtCost(r.cost_usd)}</div>}
    </button>
  )
}
```

Note: the block tint mixes the hex `--viz-*` colour with `transparent`, not with `var(--background)` — shadcn's `--background` holds bare HSL components, which would make the whole `color-mix()` invalid.

- [ ] **Step 2: Verify in the browser** — dev server, `/sessions?view=calendar&date=2026-09-09`:
  - `read_page` shows 7 day headers Mon 7.9.–Sun 13.9. and event buttons with titles;
  - click an event → the right panel shows that session (title, summary);
  - `+ agent/scheduled` adds muted blocks; the stats line changes only by work sessions;
  - ‹ / › / Today move by a week and update `date` in the URL;
  - `resize_window` dark mode: blocks readable; `read_console_messages` has no errors.
  Take a screenshot as proof.

- [ ] **Step 3: Lint, test, commit**

Run: `npm run lint && npm test`
Expected: PASS

```bash
git add src/app/sessions/calendar-view.js
git commit -m "feat(sessions): week calendar view"
```

---

### Task 18: Month grid

**Files:**
- Modify: `src/app/sessions/calendar-view.js`

**Interfaces:**
- Consumes: `range.days`, `range.since`, `calendarSlot`, `EventBlock` (compact), `onNavigate`, `onSpan`.
- Produces: `MonthGrid({ range, events, selected, onOpen, onNavigate, onSpan })`.

- [ ] **Step 1: Implement** — add to `calendar-view.js` (and `isSameMonth` to the date-fns import) and replace the month placeholder in `CalendarView` with `<MonthGrid range={range} events={events} selected={selected} onOpen={onOpen} onNavigate={onNavigate} onSpan={onSpan} />`:

```jsx
const CHIPS_PER_DAY = 4

function MonthGrid({ range, events, selected, onOpen, onNavigate, onSpan }) {
  const byDay = useMemo(() => {
    const m = new Map()
    for (const e of events) {
      const slot = calendarSlot(e)
      if (!slot) continue
      const k = format(slot.start, 'yyyy-MM-dd')
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(e)
    }
    for (const list of m.values()) list.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    return m
  }, [events])
  const openWeek = (d) => { onNavigate(d); onSpan('week') }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 auto-rows-fr overflow-y-auto rounded-md border">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b px-1 py-1 text-center text-xs text-muted-foreground">{d}</div>)}
      {range.days.map((d) => {
        const inMonth = isSameMonth(d, range.since)
        const list = inMonth ? byDay.get(format(d, 'yyyy-MM-dd')) || [] : []
        const work = list.filter((e) => !e.muted)
        const hours = work.reduce((a, e) => a + ((e.rollup || e).active_s || 0), 0) / 3600
        const heat = Math.min(hours / 8, 1) * 18
        return (
          <div key={+d} className={`min-h-24 border-b border-l p-1 ${inMonth ? '' : 'opacity-40'}`}
            style={hours > 0 ? { background: `color-mix(in srgb, var(--viz-1) ${heat}%, transparent)` } : undefined}>
            <div className="mb-0.5 flex items-center justify-between text-[11px]">
              <button onClick={() => openWeek(d)} className={`rounded px-1 hover:bg-muted ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'd')}</button>
              {hours > 0 && <span className="tabular-nums text-muted-foreground">{hours.toFixed(1)} h</span>}
            </div>
            <div className="space-y-0.5">
              {list.slice(0, CHIPS_PER_DAY).map((e) => (
                <EventBlock key={e.session_id} e={e} compact selected={selected === e.session_id} onOpen={onOpen} />
              ))}
              {list.length > CHIPS_PER_DAY && (
                <button onClick={() => openWeek(d)} className="text-[11px] text-muted-foreground hover:text-foreground">+{list.length - CHIPS_PER_DAY} more</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Verify in the browser** — `/sessions?view=calendar&span=month&date=2026-09-15`: label "September 2026", 1.9. is a Tuesday (Monday 31.8. dimmed and empty), busy days are tinted, days with more than 4 sessions show "+N more" which switches to that week. Check the phone width with `resize_window` (mobile preset): the grid stays inside the viewport. Screenshot.

- [ ] **Step 3: Lint, test, commit**

Run: `npm run lint && npm test`

```bash
git add src/app/sessions/calendar-view.js
git commit -m "feat(sessions): month calendar view"
```

---

### Task 19: Summary banner — ask, run, progress, retry

**Files:**
- Create: `src/app/sessions/summary-banner.js`
- Modify: `src/app/sessions/calendar-view.js` (mount the banner)

**Interfaces:**
- Consumes: `POST /api/sessions/summarize-batch/estimate {ids}`, `POST /api/sessions/summarize-batch {ids}`, `GET /api/sessions/summarize-batch` (Task 10); `missingSummaryIds`, `formatEta` (Task 15).
- Produces: `SummaryBanner({ ids: string[], periodKey: string, onProgress: () => void })`.

- [ ] **Step 1: Create `src/app/sessions/summary-banner.js`**

```jsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatEta } from '@/lib/cc/session-calendar.mjs'

const POLL_MS = 2000
const dismissKey = (k) => `stow.summaryBanner.dismissed:${k}`
function readDismissed(k) { try { return sessionStorage.getItem(dismissKey(k)) === '1' } catch { return false } }
function writeDismissed(k) { try { sessionStorage.setItem(dismissKey(k), '1') } catch { /* private mode */ } }
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const modelLabel = (m) => (/sonnet-5-5/.test(m || '') ? 'Sonnet 5.5' : m || '')

/**
 * "N sessions in this period have no summary" → batch → progress. `ids` are
 * exactly the calendar's visible events without a summary (period + filters),
 * so what the banner counts is what the batch processes. A job already running
 * (e.g. started from MCP) is shown instead of the question.
 */
export function SummaryBanner({ ids, periodKey, onProgress }) {
  const [est, setEst] = useState(null)
  const [job, setJob] = useState(null)
  const [mine, setMine] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState(null)
  const startedAt = useRef(0)
  const idsKey = ids.join(',')

  useEffect(() => { setDismissed(readDismissed(periodKey)) }, [periodKey])

  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        const d = await (await post('/api/sessions/summarize-batch/estimate', { ids })).json()
        if (!alive) return
        setEst(d)
        if (d.job?.status === 'running') setJob((j) => j || d.job)
      } catch { /* offline: no banner */ }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = job?.status === 'running'
  useEffect(() => {
    if (!running) return
    let seen = job.done + job.failed.length
    const iv = setInterval(async () => {
      try {
        const { job: j } = await (await fetch('/api/sessions/summarize-batch')).json()
        if (!j || j.job_id !== job.job_id) return
        setJob(j)
        const n = j.done + j.failed.length
        if (n !== seen || j.status !== 'running') { seen = n; onProgress?.() }
      } catch { /* keep polling */ }
    }, POLL_MS)
    return () => clearInterval(iv)
  }, [job?.job_id, running]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start(runIds) {
    setError(null)
    const r = await post('/api/sessions/summarize-batch', { ids: runIds })
    const d = await r.json()
    if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return }
    startedAt.current = Date.now()
    setMine(true)
    setJob(d.job)
  }

  const box = 'mb-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs'

  if (running) {
    const processed = job.done + job.failed.length
    const elapsed = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0
    const perItem = processed && elapsed ? elapsed / processed : (est?.missing ? est.estimateSeconds / Math.ceil(est.missing / (job.concurrency || 3)) : 30)
    const left = processed && elapsed ? (job.total - processed) * perItem : Math.ceil((job.total - processed) / (job.concurrency || 3)) * perItem
    return (
      <div className={box} role="status">
        <Sparkles className="h-3.5 w-3.5 animate-pulse" />
        <span className="tabular-nums">Summarising {processed} / {job.total} · {formatEta(left)} left{job.failed.length ? ` · ${job.failed.length} failed` : ''}</span>
        <div className="h-1 min-w-24 flex-1 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${job.total ? (processed / job.total) * 100 : 0}%` }} /></div>
      </div>
    )
  }

  if (job && mine && job.status !== 'running') {
    const failedIds = job.failed.map((f) => f.id)
    return (
      <div className={box} role="status">
        <span>{job.status === 'stopped' ? `Stopped: ${job.error}` : job.status === 'stale' ? 'The batch stopped responding.' : `Done: ${job.done} summarised`}{job.failed.length ? `, ${job.failed.length} failed` : ''}.</span>
        {failedIds.length > 0 && job.status !== 'stopped' && <Button size="sm" variant="outline" onClick={() => start(failedIds)}>Retry failed</Button>}
        <button className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close" onClick={() => { setJob(null); setMine(false) }}><X className="h-3.5 w-3.5" /></button>
      </div>
    )
  }

  if (!est?.missing || dismissed) return error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null
  return (
    <div className={box} role="region" aria-label="Missing summaries">
      <Sparkles className="h-3.5 w-3.5" />
      <span><b>{est.missing}</b> {est.missing === 1 ? 'session' : 'sessions'} in this period {est.missing === 1 ? 'has' : 'have'} no summary. Fill them in? <span className="text-muted-foreground">{formatEta(est.estimateSeconds)} ({modelLabel(est.model)})</span></span>
      <Button size="sm" onClick={() => start(est.ids)}>Fill in</Button>
      <Button size="sm" variant="ghost" onClick={() => { writeDismissed(periodKey); setDismissed(true) }}>Not now</Button>
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  )
}
```

- [ ] **Step 2: Mount it** — in `CalendarView` (calendar-view.js): `import { SummaryBanner } from './summary-banner'`, `missingSummaryIds` from session-calendar; compute

```jsx
  const periodKey = `${range.since.toISOString()}|${range.until.toISOString()}`
  const missing = missingSummaryIds(events)
```

and render `<SummaryBanner ids={missing} periodKey={periodKey} onProgress={onRefresh} />` between `PeriodHeader` and the grid. (`events` already reflects the period, the page's filters and the `+ agent/scheduled` chip — the banner's scope is exactly what is on screen.)

- [ ] **Step 3: Verify in the browser without spending model calls** — to exercise the flow cheaply, start the dev server with `CC_SUMMARY_BATCH_MODEL=haiku` for this check (add it to the launch config's env, remove afterwards), pick a week with 1–3 missing summaries:
  1. The banner shows the count and an estimate; "Not now" hides it; reload the page (same tab) → still hidden; navigate to another week → the banner for that week appears.
  2. "Fill in" → progress line with `n / N`; events gain outcome icons as they finish (`read_page` shows the icons); at the end "Done: …".
  3. While a job runs, open `/sessions?view=calendar` in a second tab → it shows the progress, not the question.
  4. `read_network_requests` shows `estimate` once per change of the visible set and `GET summarize-batch` every ~2 s only while running.
  Take a screenshot of the progress state.

- [ ] **Step 4: Lint, test, commit**

Run: `npm run lint && npm test`

```bash
git add src/app/sessions/summary-banner.js src/app/sessions/calendar-view.js
git commit -m "feat(sessions): offer to fill in missing summaries for the visible period"
```

---

### Task 20: Real-data rollout, docs, status

**Files:**
- Modify: `CLAUDE.md`, `STATUS.md`

- [ ] **Step 1: Full test suite + MCP smoke**

Run: `npm test && node src/mcp/server.smoke.mjs && npm run lint`
Expected: all PASS.

- [ ] **Step 2: Ingest real data and import the PoC descriptions**

```bash
npm run cc:ingest
```

```bash
npm run cc:import-summaries -- "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Erickov mind/99-Meta/ai-sessions/2026-09/sessions.json"
```

Expected: about `217 written, 0 kept (already v2), 0 not in store`. If the Task 19 check already summarised some September sessions, those count as `kept`, which is correct.

- [ ] **Step 3: Check September in the calendar** — `/sessions?view=calendar&span=month&date=2026-09-15`: work sessions have titles and outcome icons; the stats line counts roughly the PoC's 135 work sessions for the month; the banner shows only sessions created after the PoC export (if any). Week 7.–13. 9.: no block taller than 5 h unless its active time is. Screenshot.

- [ ] **Step 4: Update `CLAUDE.md`**
  - Commands: `npm run cc:eval -- --summaries [--since D --until D --concurrency N --model M --upgrade]`, `npm run cc:import-summaries -- <sessions.json> [--dry-run]`.
  - Important Files: `src/lib/cc/codex-ingest.mjs`, `summary-view.mjs`, `summary-batch.mjs`, `session-calendar.mjs`, `src/app/sessions/calendar-view.js`, `summary-banner.js`, `src/app/api/sessions/summarize-batch/route.js` (+ `estimate/`), `scripts/cc-import-summaries.mjs`.
  - Session Store section: Codex rollouts (`CC_CODEX_DIR`, default `~/.codex/sessions`) are a third source, subagents linked to the root thread via `session_meta`; new columns `title`/`title_source`/`user_prompts`; `kind` may be `scheduled`; `effectiveKind` vocabulary; summary v2 shape; batch model `CC_SUMMARY_BATCH_MODEL` (default `claude-sonnet-5-5`), job state in `summary_jobs` (cross-process with the MCP server, 60 s stale heartbeat); calendar view (`?view=calendar&span=week|month&date=`), banner scope = visible events, 10-min rule.
  - Environment Variables: `CC_CODEX_DIR`, `CC_SUMMARY_BATCH_MODEL`.

- [ ] **Step 5: Update `STATUS.md`** via the `status-keeper` skill: NEXT = "F5: .ics export + period report via MCP list_sessions (spec 2026-09-30)".

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: session calendar, summaries v2, Codex ingest"
```

---

## Self-Review Notes

- **Spec coverage:** F1 → Tasks 3–5 (+ `codex` source filter, root linking, tests incl. reset). F2 → Tasks 1, 2, 6, 7 (schema v2, `title` + priority, `effectiveKind`, Codex distill, facts header, `ms`). F3 → Tasks 8–13 (runner, API incl. estimate and range GET, CLI, MCP, import, model + estimate rules). F4 → Tasks 14–19 (range API, local-day fix, placement rules, week/month, colours, icons, harness badge, stats header, chip, banner incl. dismiss/in-progress/retry, detail panel reuse). F5 deliberately out of scope (decision 14).
- **Spec deviations (all recorded in the spec's decision list):** job state in SQLite (5), title not overwritten by summaries (6), import also upgrades v1 (7), `user_prompts` column (8), client-side period stats (9), English copy (10), letter badges (11).
- **Known limitation:** on the two DST-change days the week grid positions events after the switch one hour off (minutes are measured from local midnight in real time). Acceptable for a work log; not worth special-casing.
