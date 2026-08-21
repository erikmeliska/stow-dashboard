# cc Phase 2 — Eval, Summaries & Work Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich every ingested Claude Code session with tool-agnostic work context (repo/branch/PR/ticket), a transparent quality score, and an on-demand `claude -p` AI summary, and show all of it in the `/sessions` viewer.

**Architecture:** Three new pure modules under `src/lib/cc/` (`context.mjs`, `quality.mjs`, `summary.mjs`) operate on the already-parsed transcript lines; the ingest runner calls context + quality deterministically on every run, while summaries are generated only on demand (CLI `cc:eval` or a POST route) through an injectable `exec` seam around the `claude` CLI. The store gains a guarded in-place migration and a separate `setSummary` so re-ingests never erase summaries.

**Tech Stack:** Node ≥ 24, `node:sqlite`, `node:test`, `claude` CLI (`claude -p --output-format json --json-schema … --tools "" --no-session-persistence`), Next.js 16 App Router.

**Spec:** `docs/superpowers/specs/2026-08-21-cc-phase2-eval-context-design.md` (addendum to `2026-08-21-cc-observability-team-design.md`)

## Global Constraints

- Node ≥ 24, ESM, `node:test`; all new scripts/tests run with `--disable-warning=ExperimentalWarning` (already in `npm test`).
- Ticket is **tool-agnostic**: columns `ticket_id`, `ticket_source` — never `jira_ticket`. Default pattern `\b[A-Z][A-Z0-9]+-\d+\b`, env override `CC_TICKET_PATTERN`.
- Ticket sources, priority order, first match wins: `branch` → `prompt` → `commit`.
- Summary engine is `claude -p` with **`--no-session-persistence`** (mandatory — otherwise summaries create transcripts we then ingest). Engine behind `summarize(distillate, { exec })`; `npm test` must never spawn the real CLI.
- Summaries are on-demand only; ingest never calls the model. Re-ingest must preserve `summary`.
- Quality score is a heuristic: score 0–100 + `quality_detail` JSON with components; UI labels it "heuristic".
- Verify pattern default: `npm test|node --test|pytest|cargo test|go test|vitest|jest|playwright`, env override `CC_VERIFY_PATTERN`.
- No new dependencies. Existing JSON ledger untouched.

---

## File Structure

- `src/lib/cc/store.mjs` (modify) — migration (`ensureColumns`), `setSummary`, `ingestRow` column split; `upsertSession` stops touching summary columns.
- `src/lib/cc/transcript.mjs` (create) — `parseLines(text) → object[]` shared JSON-line parser (ingest/context/quality/summary all need it; avoids 4 copies).
- `src/lib/cc/context.mjs` (create) — `extractContext(lines, opts)`.
- `src/lib/cc/quality.mjs` (create) — `scoreSession(lines, opts)`.
- `src/lib/cc/summary.mjs` (create) — `distill(lines, opts)`, `summarize(distillate, opts)`, `SUMMARY_SCHEMA`.
- `scripts/cc-ingest.mjs` (modify) — call context + quality, store them.
- `scripts/cc-eval.mjs` (create) — `--summaries [--limit N] [--id SID]`; `package.json` `cc:eval`.
- `src/app/api/sessions/summarize/route.js` (create) — POST `{id}`.
- `src/app/sessions/page.js` (modify) — columns + sections + Generate button.
- `CLAUDE.md`, `STATUS.md` (modify) — docs.

---

### Task 1: Store migration + summary persistence (`src/lib/cc/store.mjs`)

**Files:**
- Modify: `src/lib/cc/store.mjs`
- Test: `src/lib/cc/store.test.mjs`

**Interfaces:**
- Produces: `openStore(path)` now migrates: adds columns `ticket_id, ticket_source, pr, quality_detail, summary_model, summarized_at` when missing (SCHEMA for fresh DBs includes them; `jira_ticket` is dropped from SCHEMA and left unused if present in old files).
- `upsertSession(db, row)` writes ingest-owned columns: the phase-1 list **plus** `git_repo, git_branch, pr, ticket_id, ticket_source, quality_score, quality_detail`. It uses `INSERT … ON CONFLICT(session_id) DO UPDATE SET <those cols>` so `summary*` columns survive.
- `setSummary(db, sessionId, { summary, model, at })` writes `summary, summary_model, summarized_at`.
- `getSession` unchanged in shape (row now has the new columns).

- [ ] **Step 1: Add failing tests** (append to `src/lib/cc/store.test.mjs`)

```javascript
import { DatabaseSync } from 'node:sqlite';
import { setSummary } from './store.mjs';

test('openStore migrates an old phase-1 DB in place', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, jira_ticket TEXT, summary TEXT)');
  raw.exec("INSERT INTO sessions (session_id) VALUES ('old')");
  const db = openStore(raw); // accepts an open handle
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  for (const c of ['ticket_id', 'ticket_source', 'pr', 'quality_detail', 'summary_model', 'summarized_at']) assert.ok(cols.includes(c), c);
  assert.equal(getSession(db, 'old').session.session_id, 'old');
});

test('re-upsert keeps the summary, setSummary writes it', () => {
  const db = seed();
  setSummary(db, 's1', { summary: '{"what":"x"}', model: 'claude-haiku-4-5', at: '2026-08-21T12:00:00Z' });
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', model: 'y', ticket_id: 'ABC-1', ticket_source: 'branch', git_branch: 'feat/ABC-1', quality_score: 80, quality_detail: '{"verified":true}' });
  const s = getSession(db, 's1').session;
  assert.equal(s.summary, '{"what":"x"}');
  assert.equal(s.summary_model, 'claude-haiku-4-5');
  assert.equal(s.model, 'y');
  assert.equal(s.ticket_id, 'ABC-1');
  assert.equal(s.quality_score, 80);
});
```

- [ ] **Step 2: Run** `node --disable-warning=ExperimentalWarning --test src/lib/cc/store.test.mjs` → FAIL (`setSummary` not exported / missing columns).

- [ ] **Step 3: Implement** in `store.mjs`

```javascript
// SCHEMA: replace `jira_ticket TEXT,` with `ticket_id TEXT, ticket_source TEXT, pr TEXT,`
// and add after `summary TEXT,`: `summary_model TEXT, summarized_at TEXT, quality_detail TEXT,`

const MIGRATION_COLS = {
  ticket_id: 'TEXT', ticket_source: 'TEXT', pr: 'TEXT',
  quality_detail: 'TEXT', summary_model: 'TEXT', summarized_at: 'TEXT',
};

function ensureColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(MIGRATION_COLS)) {
    if (!have.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
  }
}

export function openStore(path) {
  const db = path instanceof DatabaseSync ? path : new DatabaseSync(path || dataFile(DB_NAME));
  if (path !== ':memory:' && !(path instanceof DatabaseSync)) db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  ensureColumns(db);
  return db;
}

const SESSION_COLS = [
  'session_id', 'project_dir', 'cwd', 'model', 'started_at', 'ended_at',
  'duration_s', 'active_s', 'input_tokens', 'output_tokens', 'cache_read',
  'cache_write_5m', 'cache_write_1h', 'cost_usd', 'turns', 'status', 'raw_ref', 'ingested_at',
  'git_repo', 'git_branch', 'pr', 'ticket_id', 'ticket_source', 'quality_score', 'quality_detail',
];

export function upsertSession(db, row) {
  const cols = SESSION_COLS.join(', ');
  const ph = SESSION_COLS.map((c) => '@' + c).join(', ');
  const set = SESSION_COLS.filter((c) => c !== 'session_id').map((c) => `${c} = excluded.${c}`).join(', ');
  const params = {};
  for (const c of SESSION_COLS) params[c] = row[c] ?? null;
  db.prepare(`INSERT INTO sessions (${cols}) VALUES (${ph}) ON CONFLICT(session_id) DO UPDATE SET ${set}`).run(params);
}

export function setSummary(db, sessionId, { summary, model, at }) {
  db.prepare('UPDATE sessions SET summary = ?, summary_model = ?, summarized_at = ? WHERE session_id = ?')
    .run(summary ?? null, model ?? null, at ?? new Date().toISOString(), sessionId);
}
```

Note: `quality_detail` is stored as a JSON **string**; callers stringify.

- [ ] **Step 4: Run** the store tests → PASS (6 tests). Run `npm test` → all green (ingest tests still pass — they only set phase-1 keys).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/store.mjs src/lib/cc/store.test.mjs
git commit -m "feat(cc): store migration for phase-2 columns; summaries survive re-ingest"
```

---

### Task 2: Shared line parser + work context (`transcript.mjs`, `context.mjs`)

**Files:**
- Create: `src/lib/cc/transcript.mjs`, `src/lib/cc/context.mjs`
- Test: `src/lib/cc/context.test.mjs`

**Interfaces:**
- Produces: `parseLines(text) → object[]` (skips blank/invalid lines).
- Produces: `extractContext(lines, { ticketPattern? }) → { git_branch, git_repo, pr, ticket_id, ticket_source }` (all nullable strings). `DEFAULT_TICKET_RE`, `ticketRegex(env)` helper (reads `CC_TICKET_PATTERN`, falls back to default on invalid regex).
- Helpers used by later tasks: `bashCommands(lines) → string[]` (every Bash `tool_use.input.command`), `toolResults(lines) → {is_error:boolean, text:string}[]`, `userPrompts(lines) → string[]` (user lines whose `message.content` is a string or text blocks, excluding tool_result-only messages).

- [ ] **Step 1: Write failing test** `src/lib/cc/context.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from './transcript.mjs';
import { extractContext, ticketRegex } from './context.mjs';

const J = (o) => JSON.stringify(o);
function asst(content, extra = {}) { return { type: 'assistant', gitBranch: 'main', message: { content }, ...extra }; }
function bash(command) { return { type: 'tool_use', name: 'Bash', input: { command } }; }
function result(text, is_error = false) {
  return { type: 'user', gitBranch: 'main', message: { content: [{ type: 'tool_result', content: text, is_error }] } };
}

test('branch: most common non-HEAD gitBranch; ticket from branch wins', () => {
  const lines = parseLines([
    J({ type: 'user', gitBranch: 'HEAD', message: { content: 'fix XYZ-9 please' } }),
    J({ type: 'user', gitBranch: 'feat/ABC-123-login', message: { content: 'hi' } }),
    J(asst([bash('ls')], { gitBranch: 'feat/ABC-123-login' })),
  ].join('\n'));
  const c = extractContext(lines);
  assert.equal(c.git_branch, 'feat/ABC-123-login');
  assert.equal(c.ticket_id, 'ABC-123');
  assert.equal(c.ticket_source, 'branch');
});

test('ticket from first prompt, then from commit message', () => {
  const p = parseLines([J({ type: 'user', gitBranch: 'main', message: { content: 'work on DEF-7 now' } })].join('\n'));
  assert.deepEqual([extractContext(p).ticket_id, extractContext(p).ticket_source], ['DEF-7', 'prompt']);
  const c = parseLines([J({ type: 'user', gitBranch: 'main', message: { content: 'hello' } }), J(asst([bash('git commit -m "GHI-42: fix"')]))].join('\n'));
  assert.deepEqual([extractContext(c).ticket_id, extractContext(c).ticket_source], ['GHI-42', 'commit']);
});

test('repo from git remote / push URL; PR number from gh output', () => {
  const lines = parseLines([
    J(asst([bash('git remote -v')])),
    result('origin\tgit@github.com:acme/widgets.git (fetch)\norigin\tgit@github.com:acme/widgets.git (push)'),
    J(asst([bash('gh pr create --fill')])),
    result('https://github.com/acme/widgets/pull/57'),
  ].join('\n'));
  const c = extractContext(lines);
  assert.equal(c.git_repo, 'github.com/acme/widgets');
  assert.equal(c.pr, '57');
});

test('no signals → all null; custom ticket pattern via env', () => {
  const c = extractContext(parseLines(J({ type: 'user', message: { content: 'x' } })));
  assert.deepEqual(c, { git_branch: null, git_repo: null, pr: null, ticket_id: null, ticket_source: null });
  assert.equal(ticketRegex({ CC_TICKET_PATTERN: '#(\\d+)' }).source, '#(\\d+)');
  assert.equal(ticketRegex({ CC_TICKET_PATTERN: '[' }).source, ticketRegex({}).source);
  const lines = parseLines(J({ type: 'user', gitBranch: 'main', message: { content: 'see #1234' } }));
  assert.equal(extractContext(lines, { ticketPattern: /#(\d+)/ }).ticket_id, '#1234');
});
```

- [ ] **Step 2: Run** → FAIL (modules missing).

- [ ] **Step 3: Implement** `src/lib/cc/transcript.mjs`

```javascript
/** Shared helpers over a parsed Claude Code JSONL transcript. */
export function parseLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    try { const d = JSON.parse(raw); if (d && typeof d === 'object') out.push(d); } catch { /* skip */ }
  }
  return out;
}

function blocks(d) {
  const c = d?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Every Bash tool_use command, in order. */
export function bashCommands(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') out.push(b.input.command);
  return out;
}

/** Every tool_use block as { tool, input, line }. */
export function toolUses(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'tool_use' && b.name) out.push({ tool: b.name, input: b.input ?? {}, line: d });
  return out;
}

/** Every tool_result as { is_error, text }. */
export function toolResults(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'user') for (const b of blocks(d)) if (b?.type === 'tool_result') {
    const c = b.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('\n') : '';
    out.push({ is_error: b.is_error === true, text });
  }
  return out;
}

/** Human prompts (string content or text blocks), excluding tool_result-only messages. */
export function userPrompts(lines) {
  const out = [];
  for (const d of lines) {
    if (d.type !== 'user') continue;
    const c = d?.message?.content;
    if (typeof c === 'string') { if (c.trim()) out.push(c); continue; }
    const text = blocks(d).filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
    if (text.trim()) out.push(text);
  }
  return out;
}

/** Assistant text blocks, in order. */
export function assistantTexts(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'text' && b.text) out.push(b.text);
  return out;
}
```

Implement `src/lib/cc/context.mjs`

```javascript
import { bashCommands, toolResults, userPrompts } from './transcript.mjs';

export const DEFAULT_TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Ticket regex from env (CC_TICKET_PATTERN); invalid → default. */
export function ticketRegex(env = process.env) {
  const p = env.CC_TICKET_PATTERN;
  if (!p) return DEFAULT_TICKET_RE;
  try { return new RegExp(p); } catch { return DEFAULT_TICKET_RE; }
}

const REPO_RE = /(?:https?:\/\/|git@)?(github\.com|gitlab\.com|bitbucket\.org)[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s'")]|$)/;
const PR_RE = /\/(?:pull|merge_requests|pull-requests)\/(\d+)/;

function mostCommonBranch(lines) {
  const counts = new Map();
  let lastSeen = null;
  for (const d of lines) {
    const b = d.gitBranch;
    if (typeof b !== 'string' || !b || b === 'HEAD') continue;
    counts.set(b, (counts.get(b) || 0) + 1);
    lastSeen = b;
  }
  let best = null, bestN = 0;
  for (const [b, n] of counts) if (n > bestN || (n === bestN && b === lastSeen)) { best = b; bestN = n; }
  return best;
}

function firstMatch(re, texts) {
  for (const t of texts) { const m = re.exec(t); if (m) return m[0]; }
  return null;
}

/**
 * @param {object[]} lines  parsed transcript lines
 * @param {{ticketPattern?: RegExp}} opts
 * @returns {{git_branch, git_repo, pr, ticket_id, ticket_source}}
 */
export function extractContext(lines, { ticketPattern = DEFAULT_TICKET_RE } = {}) {
  const re = new RegExp(ticketPattern.source, ticketPattern.flags.replace('g', ''));
  const branch = mostCommonBranch(lines);
  const cmds = bashCommands(lines);
  const results = toolResults(lines);
  const prompts = userPrompts(lines);

  let ticket_id = null, ticket_source = null;
  if (branch && (ticket_id = firstMatch(re, [branch]))) ticket_source = 'branch';
  else if ((ticket_id = firstMatch(re, prompts.slice(0, 1)))) ticket_source = 'prompt';
  else {
    const commits = cmds.filter((c) => /\bgit\s+commit\b/.test(c));
    if ((ticket_id = firstMatch(re, commits))) ticket_source = 'commit';
  }

  const repoTexts = [...cmds, ...results.map((r) => r.text)];
  let git_repo = null;
  for (const t of repoTexts) { const m = REPO_RE.exec(t); if (m) { git_repo = `${m[1]}/${m[2]}`; break; } }

  let pr = null;
  for (const r of results) { const m = PR_RE.exec(r.text); if (m) { pr = m[1]; break; } }
  if (!pr) for (const c of cmds) { const m = PR_RE.exec(c); if (m) { pr = m[1]; break; } }

  return { git_branch: branch, git_repo, pr, ticket_id, ticket_source };
}
```

- [ ] **Step 4: Run** `node --disable-warning=ExperimentalWarning --test src/lib/cc/context.test.mjs` → PASS (4 tests). If the repo regex trips on the `.git (fetch)` suffix, the lookahead `(?=[\s'")]|$)` after the optional `.git` is what must match — adjust there, not in the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/transcript.mjs src/lib/cc/context.mjs src/lib/cc/context.test.mjs
git commit -m "feat(cc): work-context extraction (branch/repo/PR + tool-agnostic ticket id)"
```

---

### Task 3: Quality score (`src/lib/cc/quality.mjs`)

**Files:**
- Create: `src/lib/cc/quality.mjs`
- Test: `src/lib/cc/quality.test.mjs`

**Interfaces:**
- Consumes: `toolUses`, `toolResults`, `bashCommands` (Task 2).
- Produces: `scoreSession(lines, { guardHits = [], verifyPattern? }) → { score: number, detail: { verified, clean_finish, error_rate_pct, loops, guard_incidents, points: {verified, clean_finish, error_rate, no_loops, guard_clean} } }`; `DEFAULT_VERIFY_RE`, `verifyRegex(env)`.

- [ ] **Step 1: Write failing test** `src/lib/cc/quality.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from './transcript.mjs';
import { scoreSession, verifyRegex } from './quality.mjs';

const J = (o) => JSON.stringify(o);
const asst = (content) => J({ type: 'assistant', message: { content } });
const use = (name, input) => ({ type: 'tool_use', name, input });
const res = (is_error = false) => J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error }] } });

test('perfect session scores 100 with every component earned', () => {
  const lines = parseLines([asst([use('Bash', { command: 'npm test' })]), res(false), asst([{ type: 'text', text: 'done' }])].join('\n'));
  const { score, detail } = scoreSession(lines);
  assert.equal(score, 100);
  assert.equal(detail.verified, true);
  assert.equal(detail.clean_finish, true);
  assert.equal(detail.error_rate_pct, 0);
  assert.equal(detail.loops, 0);
  assert.deepEqual(detail.points, { verified: 25, clean_finish: 25, error_rate: 25, no_loops: 15, guard_clean: 10 });
});

test('errors, loops, guard denies and an error ending cost points', () => {
  const loop = asst([use('Read', { file_path: '/a' })]);
  const lines = parseLines([
    asst([use('Bash', { command: 'ls' })]), res(true),
    loop, res(), loop, res(), loop, res(),
    asst([use('Bash', { command: 'rm -rf /' })]), res(true),
  ].join('\n'));
  const { score, detail } = scoreSession(lines, { guardHits: [{ action: 'deny' }] });
  assert.equal(detail.verified, false);
  assert.equal(detail.clean_finish, false);
  assert.equal(detail.loops, 1);
  assert.equal(detail.guard_incidents, 1);
  assert.equal(detail.error_rate_pct, 40);
  assert.equal(score, 0);
});

test('error rate is linear to zero at 20%', () => {
  const lines = parseLines([asst([use('Bash', { command: 'ls' })]), res(true), ...Array(9).fill(res())].join('\n'));
  const { detail } = scoreSession(lines);
  assert.equal(detail.error_rate_pct, 10);
  assert.equal(detail.points.error_rate, 12.5);
});

test('verifyRegex honours env and falls back on invalid', () => {
  assert.ok(verifyRegex({ CC_VERIFY_PATTERN: 'make check' }).test('make check'));
  assert.ok(verifyRegex({ CC_VERIFY_PATTERN: '(' }).test('npm test'));
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/lib/cc/quality.mjs`

```javascript
/**
 * Quality score v1 — a transparent heuristic (0–100), components stored so the
 * number is explainable. Explicitly NOT a judgement of the work; refine later.
 */
import { bashCommands, toolResults, toolUses } from './transcript.mjs';

export const DEFAULT_VERIFY_RE = /npm test|node --test|pytest|cargo test|go test|vitest|jest|playwright/;

export function verifyRegex(env = process.env) {
  const p = env.CC_VERIFY_PATTERN;
  if (!p) return DEFAULT_VERIFY_RE;
  try { return new RegExp(p); } catch { return DEFAULT_VERIFY_RE; }
}

const POINTS = { verified: 25, clean_finish: 25, error_rate: 25, no_loops: 15, guard_clean: 10 };
const LOOP_RUN = 3;

function countLoops(uses) {
  let loops = 0, run = 1, prev = null;
  for (const u of uses) {
    const key = u.tool + ' ' + JSON.stringify(u.input);
    if (key === prev) { run++; if (run === LOOP_RUN) loops++; } else { run = 1; prev = key; }
  }
  return loops;
}

function cleanFinish(lines) {
  let lastAssistant = -1, lastError = -1;
  lines.forEach((d, i) => {
    if (d.type === 'assistant') lastAssistant = i;
    if (d.type === 'user') for (const b of d?.message?.content || []) if (b?.type === 'tool_result' && b.is_error === true) lastError = i;
  });
  return lastAssistant >= 0 && lastError < lastAssistant;
}

export function scoreSession(lines, { guardHits = [], verifyPattern = DEFAULT_VERIFY_RE } = {}) {
  const verified = bashCommands(lines).some((c) => verifyPattern.test(c));
  const results = toolResults(lines);
  const errors = results.filter((r) => r.is_error).length;
  const error_rate_pct = results.length ? Math.round((errors / results.length) * 1000) / 10 : 0;
  const loops = countLoops(toolUses(lines));
  const guard_incidents = guardHits.filter((h) => h.action === 'deny' || h.action === 'override').length;
  const clean_finish = cleanFinish(lines);

  const points = {
    verified: verified ? POINTS.verified : 0,
    clean_finish: clean_finish ? POINTS.clean_finish : 0,
    error_rate: Math.max(0, POINTS.error_rate * (1 - Math.min(error_rate_pct, 20) / 20)),
    no_loops: loops === 0 ? POINTS.no_loops : 0,
    guard_clean: guard_incidents === 0 ? POINTS.guard_clean : 0,
  };
  const score = Math.round(Object.values(points).reduce((a, b) => a + b, 0));
  return { score, detail: { verified, clean_finish, error_rate_pct, loops, guard_incidents, points } };
}
```

- [ ] **Step 4: Run** → PASS (4 tests). Check: test 2 has 5 results, 2 errors → 40 % → error_rate 0; nothing else earned → 0. Test 3: 10 results, 1 error → 10 % → 12.5.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/quality.mjs src/lib/cc/quality.test.mjs
git commit -m "feat(cc): transparent quality score v1 with stored components"
```

---

### Task 4: Wire context + quality into ingest (`scripts/cc-ingest.mjs`)

**Files:**
- Modify: `scripts/cc-ingest.mjs`, `src/lib/cc/ingest.mjs`
- Test: `scripts/cc-ingest.test.mjs`

**Interfaces:**
- `parseSessionText` additionally returns `_lines` (the parsed line objects) so the runner doesn't re-parse; it switches to `parseLines` from `transcript.mjs` (drops its own JSON loop).
- `ingestAll({ claudeDir, guardAudit, db, env = process.env })` computes `extractContext(row._lines, { ticketPattern: ticketRegex(env) })` and `scoreSession(row._lines, { guardHits, verifyPattern: verifyRegex(env) })` on the **main** transcript lines (subagents excluded from context/quality) and stores `git_branch, git_repo, pr, ticket_id, ticket_source, quality_score, quality_detail (JSON string)`.

- [ ] **Step 1: Add failing test** (append to `scripts/cc-ingest.test.mjs`)

```javascript
test('ingestAll stores work context and quality score', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccp-'));
  const proj = join(root, 'projects', '-p-a');
  await mkdir(proj, { recursive: true });
  const lines = [
    { type: 'user', cwd: '/p/a', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } },
    { type: 'assistant', sessionId: 'sess-q', gitBranch: 'feat/QA-12-x', timestamp: '2026-08-21T10:00:09Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(proj, 'sess-q.jsonl'), lines, 'utf8');
  const db = openStore(':memory:');
  await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: join(root, 'nope'), db, env: {} });
  const s = getSession(db, 'sess-q').session;
  assert.equal(s.git_branch, 'feat/QA-12-x');
  assert.equal(s.ticket_id, 'QA-12');
  assert.equal(s.ticket_source, 'branch');
  assert.equal(s.quality_score, 100);
  assert.equal(JSON.parse(s.quality_detail).verified, true);
});
```

- [ ] **Step 2: Run** → FAIL (`git_branch` null).

- [ ] **Step 3: Implement.** In `src/lib/cc/ingest.mjs`: `import { parseLines } from './transcript.mjs'`; replace the manual loop with `const lines = parseLines(text)` and iterate `lines` (keep `rawLines` for `parseClaudeLines`); add `_lines: lines` to the returned row. In `scripts/cc-ingest.mjs`:

```javascript
import { extractContext, ticketRegex } from '../src/lib/cc/context.mjs';
import { scoreSession, verifyRegex } from '../src/lib/cc/quality.mjs';

export async function ingestAll({ claudeDir, guardAudit, db, env = process.env }) {
  const ticketPattern = ticketRegex(env);
  const verifyPattern = verifyRegex(env);
  // … existing guardMap + loop …
    const hits = guardMap.get(row.session_id) || [];
    Object.assign(row, extractContext(row._lines, { ticketPattern }));
    const q = scoreSession(row._lines, { guardHits: hits, verifyPattern });
    row.quality_score = q.score;
    row.quality_detail = JSON.stringify(q.detail);
    // then the existing transaction: upsertSession / replaceTools / replaceSkills / replaceGuardHits(hits)
```

(Compute `hits` once and pass the same array to `replaceGuardHits`.)

- [ ] **Step 4: Run** `node --disable-warning=ExperimentalWarning --test scripts/cc-ingest.test.mjs` → PASS (5). Then `npm run cc:ingest` and spot-check:

```bash
node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);
console.log(db.prepare("select count(*) n, sum(ticket_id is not null) tickets, sum(git_branch is not null) branches, round(avg(quality_score)) q from sessions").get());
console.log(db.prepare("select ticket_id, ticket_source, count(*) n from sessions where ticket_id is not null group by 1,2 order by n desc limit 5").all());' "$HOME/Library/Application Support/StowDashboardDeno/data/cc-sessions.db"
```
Expected: branches ≫ 0, a plausible avg quality, tickets possibly few (depends on your branch naming).

- [ ] **Step 5: Commit**

```bash
git add scripts/cc-ingest.mjs src/lib/cc/ingest.mjs scripts/cc-ingest.test.mjs
git commit -m "feat(cc): ingest computes work context + quality score per session"
```

---

### Task 5: AI summary engine (`src/lib/cc/summary.mjs`) + `cc:eval` CLI

**Files:**
- Create: `src/lib/cc/summary.mjs`, `scripts/cc-eval.mjs`
- Modify: `package.json`
- Test: `src/lib/cc/summary.test.mjs`

**Interfaces:**
- Produces: `distill(lines, { maxChars = 30000 }) → string`; `SUMMARY_SCHEMA` (JSON Schema); `summarize(distillate, { exec = execClosedStdin, model = process.env.CC_SUMMARY_MODEL, timeout = 120000 }) → Promise<{ what, outcome, improvements, followups, model }>`; `class SummaryError extends Error { kind: 'cli-missing'|'cli-failed'|'bad-json' }`.
- `summarizeSession(db, id, { exec? }) → Promise<detail>` (reads `raw_ref`, distills, summarises, `setSummary`, returns `getSession`) — used by both the CLI and the route.
- `exec(cmd, args, opts) → Promise<{stdout, stderr}>` has the same contract as `execClosedStdin` in `src/lib/analyzer.mjs` (re-export/import it from there).

- [ ] **Step 1: Write failing test** `src/lib/cc/summary.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from './transcript.mjs';
import { distill, summarize, SummaryError } from './summary.mjs';

const J = (o) => JSON.stringify(o);
const lines = parseLines([
  J({ type: 'user', message: { content: 'Please add a login page' } }),
  J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
  J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  J({ type: 'assistant', message: { content: [{ type: 'text', text: 'Login page added and tests pass.' }] } }),
].join('\n'));

test('distill keeps prompts, tool calls and assistant text, and respects maxChars', () => {
  const d = distill(lines);
  assert.match(d, /add a login page/);
  assert.match(d, /Bash: npm test/);
  assert.match(d, /Login page added/);
  assert.ok(distill(lines, { maxChars: 40 }).length <= 40);
});

test('summarize calls claude -p with the safety flags and parses structured output', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: JSON.stringify({ type: 'result', structured_output: { what: 'Added login', outcome: 'done', improvements: [], followups: ['add tests'] } }) };
  };
  const r = await summarize('text', { exec, model: 'claude-haiku-4-5' });
  assert.equal(r.what, 'Added login');
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.followups, ['add tests']);
  assert.equal(r.model, 'claude-haiku-4-5');
  const [cmd, args] = calls[0];
  assert.equal(cmd, 'claude');
  for (const f of ['-p', '--no-session-persistence', '--output-format', 'json', '--json-schema', '--tools', '--model']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--tools') + 1], '');
});

test('summarize surfaces CLI and JSON failures as SummaryError', async () => {
  await assert.rejects(summarize('x', { exec: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } }), (e) => e instanceof SummaryError && e.kind === 'cli-missing');
  await assert.rejects(summarize('x', { exec: async () => ({ stdout: 'not json' }) }), (e) => e instanceof SummaryError && e.kind === 'bad-json');
  await assert.rejects(summarize('x', { exec: async () => ({ stdout: JSON.stringify({ type: 'result', result: 'plain text, no structured_output' }) }) }), (e) => e instanceof SummaryError && e.kind === 'bad-json');
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/lib/cc/summary.mjs`

```javascript
/**
 * AI session summary via the local `claude` CLI (no API key). On-demand only.
 *
 * `--no-session-persistence` is mandatory: without it every summary would
 * write a new transcript under ~/.claude/projects that cc-ingest then indexes.
 * `--tools ""` keeps the call a pure text→JSON step.
 */
import { readFile } from 'node:fs/promises';
import { execClosedStdin } from '../analyzer.mjs';
import { assistantTexts, parseLines, toolUses, userPrompts } from './transcript.mjs';
import { getSession, setSummary } from './store.mjs';

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    what: { type: 'string', description: '1-3 sentences: what was worked on and the result' },
    outcome: { type: 'string', enum: ['done', 'partial', 'abandoned'] },
    improvements: { type: 'array', items: { type: 'string' }, description: 'skills/tools/process improved or created' },
    followups: { type: 'array', items: { type: 'string' } },
  },
  required: ['what', 'outcome', 'improvements', 'followups'],
  additionalProperties: false,
};

const PROMPT = `You are summarising one Claude Code session from a condensed transcript.
Answer ONLY with JSON matching the schema. "what": 1-3 plain sentences on what was worked on and what the result was.
"outcome": done | partial | abandoned. "improvements": skills, tools or process that were improved or created (empty if none).
"followups": open items explicitly left for later (empty if none). Be concrete, no marketing language.

Transcript:
`;

export class SummaryError extends Error {
  constructor(kind, message, detail = null) { super(message || `summary: ${kind}`); this.kind = kind; this.detail = detail; }
}

function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** Condensed, ordered transcript: prompts, tool calls (short), assistant text. */
export function distill(lines, { maxChars = 30000 } = {}) {
  const parts = [];
  for (const d of lines) {
    if (d.type === 'user') for (const p of userPrompts([d])) parts.push(`USER: ${clip(p, 1200)}`);
    if (d.type === 'assistant') {
      for (const u of toolUses([d])) {
        const arg = u.tool === 'Bash' ? u.input.command : u.tool === 'Skill' ? u.input.skill : (u.input.file_path || u.input.pattern || u.input.description || '');
        parts.push(`TOOL ${u.tool}: ${clip(arg || '', 160)}`);
      }
      for (const t of assistantTexts([d])) parts.push(`ASSISTANT: ${clip(t, 600)}`);
    }
  }
  let text = parts.join('\n');
  if (text.length > maxChars) {
    // keep the head (what was asked) and the tail (how it ended)
    const head = Math.floor(maxChars * 0.4), tail = maxChars - head - 7;
    text = text.slice(0, head) + '\n[...]\n' + text.slice(-tail);
  }
  return text;
}

export async function summarize(distillate, { exec = execClosedStdin, model = process.env.CC_SUMMARY_MODEL || 'haiku', timeout = 120000 } = {}) {
  const args = ['-p', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--tools', '', '--model', model, PROMPT + distillate];
  let out;
  try {
    out = await exec('claude', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    if (e?.code === 'ENOENT') throw new SummaryError('cli-missing', 'claude CLI not found on PATH');
    throw new SummaryError('cli-failed', `claude exited ${e?.code ?? '?'}`, (e?.stderr || e?.message || '').split('\n')[0]);
  }
  let parsed;
  try { parsed = JSON.parse(out.stdout); } catch { throw new SummaryError('bad-json', 'claude returned non-JSON output'); }
  const s = parsed?.structured_output;
  if (!s || typeof s.what !== 'string' || !['done', 'partial', 'abandoned'].includes(s.outcome)) throw new SummaryError('bad-json', 'claude returned no structured_output');
  return { what: s.what, outcome: s.outcome, improvements: s.improvements || [], followups: s.followups || [], model };
}

/** Summarise one stored session from its transcript and persist the result. */
export async function summarizeSession(db, id, opts = {}) {
  const got = getSession(db, id);
  if (!got) throw new SummaryError('not-found', `session ${id} not in store`);
  let text;
  try { text = await readFile(got.session.raw_ref, 'utf8'); } catch { throw new SummaryError('not-found', `transcript missing: ${got.session.raw_ref}`); }
  const result = await summarize(distill(parseLines(text)), opts);
  setSummary(db, id, { summary: JSON.stringify(result), model: result.model });
  return getSession(db, id);
}
```

Check `execClosedStdin` is exported from `src/lib/analyzer.mjs` (it is: `export function execClosedStdin`). Note `--output-format json` returns `{type:'result', structured_output: {...}, …}` when `--json-schema` is given — verify once by hand in Step 4.

- [ ] **Step 4: Run** tests → PASS (3). Then one real call to confirm the CLI contract:

```bash
node --disable-warning=ExperimentalWarning -e '
import("./src/lib/cc/summary.mjs").then(async (m) => console.log(await m.summarize("USER: add a hello endpoint\nTOOL Bash: npm test\nASSISTANT: Added /hello, tests pass.")))'
```
Expected: an object with `what`/`outcome`. If `structured_output` is absent in the real CLI output, read the printed JSON, find the key the CLI actually uses, and adapt the one line `parsed?.structured_output` (also the test fixture) — do not fall back to parsing `result` text.

- [ ] **Step 5: CLI** `scripts/cc-eval.mjs`

```javascript
#!/usr/bin/env node
/**
 * cc-eval — on-demand AI summaries for stored sessions (uses your local `claude` CLI).
 *   npm run cc:eval -- --summaries            # newest sessions without a summary (default limit 5)
 *   npm run cc:eval -- --summaries --limit 20
 *   npm run cc:eval -- --summaries --id <session_id>
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/lib/cc/store.mjs';
import { summarizeSession } from '../src/lib/cc/summary.mjs';

export async function evalSummaries(db, { limit = 5, id = null, log = console.log, summarizeImpl = summarizeSession } = {}) {
  const ids = id ? [id]
    : db.prepare('SELECT session_id FROM sessions WHERE summary IS NULL AND raw_ref IS NOT NULL ORDER BY started_at DESC LIMIT ?').all(limit).map((r) => r.session_id);
  let ok = 0, failed = 0;
  for (const sid of ids) {
    try {
      const r = await summarizeImpl(db, sid);
      ok++;
      log(`✓ ${sid.slice(0, 8)} ${JSON.parse(r.session.summary).outcome}: ${JSON.parse(r.session.summary).what}`);
    } catch (e) {
      failed++;
      log(`✗ ${sid.slice(0, 8)} ${e.kind || 'error'}: ${e.message}`);
      if (e.kind === 'cli-missing') break;
    }
  }
  return { ok, failed, total: ids.length };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { values } = parseArgs({ options: { summaries: { type: 'boolean' }, limit: { type: 'string' }, id: { type: 'string' } } });
  if (!values.summaries) { console.error('usage: cc-eval --summaries [--limit N] [--id SID]'); process.exit(2); }
  const db = openStore();
  const r = await evalSummaries(db, { limit: Number(values.limit) || 5, id: values.id || null });
  db.close();
  console.log(`cc-eval: ${r.ok} summarised, ${r.failed} failed of ${r.total}`);
}
```

Add to `package.json` scripts: `"cc:eval": "node --disable-warning=ExperimentalWarning scripts/cc-eval.mjs"`.

Add test `scripts/cc-eval.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, setSummary, getSession } from '../src/lib/cc/store.mjs';
import { evalSummaries } from './cc-eval.mjs';

test('evalSummaries picks only sessions without a summary, newest first, and stops on cli-missing', async () => {
  const db = openStore(':memory:');
  for (const [id, at] of [['a', '2026-08-21T10:00:00Z'], ['b', '2026-08-21T11:00:00Z'], ['c', '2026-08-21T12:00:00Z']]) upsertSession(db, { session_id: id, started_at: at, raw_ref: '/t/' + id });
  setSummary(db, 'c', { summary: '{}', model: 'm' });
  const seen = [];
  const r = await evalSummaries(db, { limit: 5, log: () => {}, summarizeImpl: async (d, sid) => { seen.push(sid); setSummary(d, sid, { summary: '{"what":"w","outcome":"done"}', model: 'm' }); return getSession(d, sid); } });
  assert.deepEqual(seen, ['b', 'a']);
  assert.deepEqual([r.ok, r.failed], [2, 0]);
  const r2 = await evalSummaries(db, { id: 'a', log: () => {}, summarizeImpl: async () => { const e = new Error('x'); e.kind = 'cli-missing'; throw e; } });
  assert.deepEqual([r2.ok, r2.failed], [0, 1]);
});
```

- [ ] **Step 6: Run** `npm test` → all green. Then `npm run cc:eval -- --summaries --limit 2` → two real summaries printed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cc/summary.mjs src/lib/cc/summary.test.mjs scripts/cc-eval.mjs scripts/cc-eval.test.mjs package.json
git commit -m "feat(cc): on-demand AI session summaries via claude -p (+ cc:eval CLI)"
```

---

### Task 6: Summarize route + viewer (`/api/sessions/summarize`, `/sessions`)

**Files:**
- Create: `src/app/api/sessions/summarize/route.js`
- Modify: `src/app/sessions/page.js`

**Interfaces:**
- `POST /api/sessions/summarize` body `{ id }` → 200 `{ session, tools, skills, guard_hits }` (fresh detail) or `{ error, kind }` with 404 (`not-found`) / 503 (`cli-missing`) / 502 (`cli-failed`, `bad-json`) / 400 (no id).

- [ ] **Step 1: Route**

```javascript
import { openStore } from '../../../../lib/cc/store.mjs'
import { summarizeSession, SummaryError } from '../../../../lib/cc/summary.mjs'

const STATUS = { 'not-found': 404, 'cli-missing': 503, 'cli-failed': 502, 'bad-json': 502 }

export async function POST(request) {
  let id = null
  try { id = (await request.json())?.id } catch { /* fallthrough */ }
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const db = openStore()
  try {
    return Response.json(await summarizeSession(db, id))
  } catch (e) {
    if (e instanceof SummaryError) return Response.json({ error: e.message, kind: e.kind, detail: e.detail }, { status: STATUS[e.kind] || 500 })
    return Response.json({ error: String(e?.message || e) }, { status: 500 })
  } finally {
    db.close()
  }
}
```

- [ ] **Step 2: Viewer changes** in `src/app/sessions/page.js`

Table: add columns after Project: `Ticket` (`s.ticket_id || ''`, `title={s.ticket_source}`) and before the status column: `Q` (`s.quality_score ?? '—'`, right-aligned, tabular).

Detail panel (`DetailPanel` gets `onSummarize`, `summarizing`, `summaryError` props):

```javascript
      <Section title="Context" empty="No context">
        {[
          s.git_repo && <Row key="repo" label="Repo" value={s.git_repo} />,
          s.git_branch && <Row key="branch" label="Branch" value={s.git_branch} />,
          s.pr && <Row key="pr" label="PR" value={`#${s.pr}`} />,
          s.ticket_id && <Row key="ticket" label={<>Ticket <span className="text-muted-foreground">({s.ticket_source})</span></>} value={s.ticket_id} />,
        ].filter(Boolean)}
      </Section>
      <QualityBlock s={s} />
      <SummaryBlock s={s} onSummarize={onSummarize} summarizing={summarizing} error={summaryError} />
```

```javascript
function QualityBlock({ s }) {
  let d = null
  try { d = s.quality_detail ? JSON.parse(s.quality_detail) : null } catch { d = null }
  return (
    <div>
      <h3 className="font-medium mb-1">Quality <span className="text-xs font-normal text-muted-foreground">heuristic</span></h3>
      {s.quality_score == null ? <p className="text-xs text-muted-foreground">Not scored — run cc:ingest.</p> : (
        <>
          <div className="text-2xl font-semibold tabular-nums">{s.quality_score}<span className="text-sm text-muted-foreground">/100</span></div>
          {d && (
            <div className="divide-y">
              <Row label="Verification ran" value={`${d.verified ? 'yes' : 'no'} · ${d.points.verified}`} />
              <Row label="Clean finish" value={`${d.clean_finish ? 'yes' : 'no'} · ${d.points.clean_finish}`} />
              <Row label="Tool error rate" value={`${d.error_rate_pct}% · ${d.points.error_rate}`} />
              <Row label="Loops" value={`${d.loops} · ${d.points.no_loops}`} />
              <Row label="Guard incidents" value={`${d.guard_incidents} · ${d.points.guard_clean}`} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryBlock({ s, onSummarize, summarizing, error }) {
  let sum = null
  try { sum = s.summary ? JSON.parse(s.summary) : null } catch { sum = null }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium">Summary</h3>
        <Button variant="outline" size="sm" onClick={() => onSummarize(s.session_id)} disabled={summarizing}>
          <Sparkles className={`h-3.5 w-3.5 mr-1 ${summarizing ? 'animate-pulse' : ''}`} /> {sum ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!sum && !error && <p className="text-xs text-muted-foreground">No summary yet — uses your local <code>claude</code> CLI.</p>}
      {sum && (
        <div className="space-y-1 text-xs">
          <p>{sum.what}</p>
          <Row label="Outcome" value={sum.outcome} />
          {sum.improvements?.length > 0 && <div><span className="text-muted-foreground">Improvements:</span><ul className="list-disc pl-4">{sum.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {sum.followups?.length > 0 && <div><span className="text-muted-foreground">Follow-ups:</span><ul className="list-disc pl-4">{sum.followups.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          <p className="text-muted-foreground">{s.summary_model} · {fmtStart(s.summarized_at)}</p>
        </div>
      )}
    </div>
  )
}
```

Page state + handler (import `Sparkles` from `lucide-react`):

```javascript
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState(null)

  async function summarize(id) {
    setSummarizing(true); setSummaryError(null)
    try {
      const r = await fetch('/api/sessions/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      const d = await r.json()
      if (!r.ok) { setSummaryError(d.error || `HTTP ${r.status}`); return }
      setDetail(d)
      setSessions((prev) => prev.map((s) => (s.session_id === id ? { ...s, summary: d.session.summary } : s)))
    } catch (e) {
      setSummaryError(String(e?.message || e))
    } finally {
      setSummarizing(false)
    }
  }
```

`Section` must tolerate a filtered array of children (it already wraps non-arrays; with the `.filter(Boolean)` above it receives an array — unchanged).

- [ ] **Step 3: Manual verification** with the dev server (`.claude/launch.json` → `dev`, port **3089**): open `/sessions`, confirm Ticket/Q columns, click a row → Context/Quality sections populated, click Generate → summary appears within ~10–30 s, no console errors. `npm run build` passes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/summarize/route.js src/app/sessions/page.js
git commit -m "feat(cc): summarize route + context/quality/summary in the session viewer"
```

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (Commands: `npm run cc:eval`; Important Files: `context.mjs`, `quality.mjs`, `summary.mjs`, `transcript.mjs`, `scripts/cc-eval.mjs`, summarize route; the "Claude Code Session Store" section gains a phase-2 paragraph: tool-agnostic ticket + env vars `CC_TICKET_PATTERN`, `CC_VERIFY_PATTERN`, `CC_SUMMARY_MODEL`; summaries on-demand; `--no-session-persistence` rationale), `STATUS.md` (NEXT → phase 2 shipped; next = merge + phase 3 / incremental ingest).

- [ ] **Step 1: Edit docs as listed.**
- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: phase-2 session eval, summaries and ticket context"
```

---

## Self-Review notes (author checklist, already applied)

- **Spec coverage:** §2 ticket agnostic + sources → Task 2; summary engine + `--no-session-persistence` + on-demand → Task 5/6; quality components table → Task 3; §3 data model + summary survival → Task 1; §4 components → Tasks 2–6; §5 error handling → Task 5 (`SummaryError` kinds) + Task 6 (status map, UI error); §6 testing → every task; docs → Task 7.
- **Placeholders:** none.
- **Type consistency:** `extractContext` keys == `SESSION_COLS` additions (Task 1 ↔ 2 ↔ 4); `scoreSession().detail.points` keys used verbatim in `QualityBlock`; `summarize()` return shape == what `SummaryBlock` parses; `SummaryError.kind` values == route `STATUS` keys; `evalSummaries` uses `summarizeImpl(db, id)` == `summarizeSession(db, id)` signature.
