# stow Session Ingest & Viewer (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Claude Code session transcripts (and cc-guard's audit) into a local `node:sqlite` store inside stow-dashboard, and show a session-centric view of your own sessions.

**Architecture:** A post-session ingester walks `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, reuses stow's existing `usage.mjs` (`parseClaudeLines`) and `usage-pricing.mjs` (`costForClaude`) for per-model tokens/cost, adds a second pass for tool/skill counts and `skill_edited`, and upserts one row per session into a SQLite DB (`node:sqlite`, no new dependency) that lives beside stow's JSON ledger. cc-guard's `audit.jsonl` is folded in as `guard_hits`. A Next.js API route + page render the sessions. Pure parse/store logic is isolated from I/O so it is unit-testable.

**Tech Stack:** Node.js ≥ 24 built-in `node:sqlite` (`DatabaseSync`), stow's existing `src/lib/usage.mjs` + `usage-pricing.mjs` + `state-dir.mjs`, Next.js 16 App Router (existing), `node:test`.

## Global Constraints

- Runtime: **Node.js ≥ 24**; ESM (`.mjs` for lib, `.js` for Next routes/pages per stow convention).
- Local store: **built-in `node:sqlite` (`DatabaseSync`)**, no third-party dependency. Verbatim from spec §4.
- The `node:sqlite` experimental warning is suppressed by running node with
  `--disable-warning=ExperimentalWarning` (added to the new npm scripts).
- DB location: `dataFile('cc-sessions.db')` from `src/lib/state-dir.mjs` — same state dir as
  `usage.json`. Do NOT touch stow's existing JSON ledger. Verbatim from spec §4.
- Reuse, do not reimplement: `parseClaudeLines`, `newFileState` (`src/lib/usage.mjs`),
  `costForClaude` (`src/lib/usage-pricing.mjs`). Verbatim from spec §3/§4.
- Transcript facts (verified): file path `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`;
  filename stem = session id; lines carry `sessionId`, `cwd`, `timestamp`; `type:"assistant"`
  lines carry `message.model`, `message.usage`, and `message.content[]` with
  `{type:"tool_use", name, input}`; skill calls are `name === "Skill"` with `input.skill`.
- Session-level fields for team/eval that phase 1b leaves null: `machine`, `user`, `project_key`,
  `git_*`, `jira_ticket`, `quality_score`, `summary` (filled in phases 2–3).

---

## File Structure

- `src/lib/cc/store.mjs` — SQLite schema + typed upsert/query helpers. One responsibility: persistence.
- `src/lib/cc/ingest.mjs` — pure `parseSessionText(text, meta)` → one session record.
- `src/lib/cc/guard-ingest.mjs` — pure `parseGuardAudit(text)` → guard hits grouped by session.
- `scripts/cc-ingest.mjs` — CLI runner: walk transcripts + guard audit → store (idempotent).
- `src/app/api/sessions/route.js` — GET list + detail from the store.
- `src/app/sessions/page.js` — session-centric viewer.

---

## Task 1: SQLite store (`src/lib/cc/store.mjs`)

**Files:**
- Create: `src/lib/cc/store.mjs`
- Test: `src/lib/cc/store.test.mjs`

**Interfaces:**
- Consumes: `dataFile` from `../state-dir.mjs`.
- Produces:
  - `openStore(path?) -> DatabaseSync` — opens (default `dataFile('cc-sessions.db')`), applies schema, returns the db handle.
  - `upsertSession(db, row)` — INSERT OR REPLACE one `sessions` row (keys below).
  - `replaceTools(db, sessionId, counts)` — `counts` is `{ toolName: n }`.
  - `replaceSkills(db, sessionId, counts, editedSet)` — `editedSet` is a `Set<string>`.
  - `replaceGuardHits(db, sessionId, hits)` — `hits` is `[{ ts, command, rule, action }]`.
  - `listSessions(db, { project?, limit? }) -> row[]` (newest first).
  - `getSession(db, id) -> { session, tools, skills, guard_hits } | null`.
  - `sessions` row keys: `session_id, project_dir, cwd, model, started_at, ended_at,
    duration_s, active_s, input_tokens, output_tokens, cache_read, cache_write_5m,
    cache_write_1h, cost_usd, turns, status, raw_ref, ingested_at`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits, listSessions, getSession } from './store.mjs';

function seed() {
  const db = openStore(':memory:');
  upsertSession(db, {
    session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'claude-opus-5',
    started_at: '2026-08-21T10:00:00Z', ended_at: '2026-08-21T10:30:00Z',
    duration_s: 1800, active_s: 900, input_tokens: 100, output_tokens: 200,
    cache_read: 50, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0.42,
    turns: 12, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: '2026-08-21T11:00:00Z',
  });
  replaceTools(db, 's1', { Bash: 5, Read: 2 });
  replaceSkills(db, 's1', { 'superpowers:brainstorming': 1 }, new Set(['superpowers:brainstorming']));
  replaceGuardHits(db, 's1', [{ ts: '2026-08-21T10:05:00Z', command: 'rm -rf /', rule: 'rm-rf-dangerous', action: 'deny' }]);
  return db;
}

test('upsert + get returns the full session', () => {
  const db = seed();
  const got = getSession(db, 's1');
  assert.equal(got.session.cost_usd, 0.42);
  assert.equal(got.tools.find((t) => t.tool === 'Bash').count, 5);
  assert.equal(got.skills[0].edited, 1);
  assert.equal(got.guard_hits[0].action, 'deny');
});

test('upsert is idempotent (replace, not duplicate)', () => {
  const db = seed();
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'x', started_at: null, ended_at: null, duration_s: 0, active_s: 0, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: 'now' });
  replaceTools(db, 's1', { Bash: 9 });
  assert.equal(listSessions(db, {}).length, 1);
  assert.equal(getSession(db, 's1').tools.find((t) => t.tool === 'Bash').count, 9);
});

test('listSessions filters by project and orders newest first', () => {
  const db = seed();
  upsertSession(db, { session_id: 's2', project_dir: '/p/b', cwd: '/p/b', model: 'x', started_at: '2026-08-21T12:00:00Z', ended_at: '2026-08-21T12:10:00Z', duration_s: 600, active_s: 100, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0, turns: 1, status: 'done', raw_ref: '/t/s2.jsonl', ingested_at: 'now' });
  assert.equal(listSessions(db, { project: '/p/a' }).length, 1);
  assert.equal(listSessions(db, {})[0].session_id, 's2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/store.test.mjs`
Expected: FAIL ("Cannot find module './store.mjs'").

- [ ] **Step 3: Write `src/lib/cc/store.mjs`**

```javascript
import { DatabaseSync } from 'node:sqlite';
import { dataFile } from '../state-dir.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine TEXT, user TEXT, project_dir TEXT, project_key TEXT, cwd TEXT, model TEXT,
  started_at TEXT, ended_at TEXT, duration_s REAL, active_s REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
  cache_write_5m INTEGER, cache_write_1h INTEGER, cost_usd REAL,
  turns INTEGER, status TEXT, git_repo TEXT, git_branch TEXT, jira_ticket TEXT,
  quality_score REAL, summary TEXT, raw_ref TEXT, ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_usage (session_id TEXT, tool TEXT, count INTEGER, PRIMARY KEY (session_id, tool));
CREATE TABLE IF NOT EXISTS skill_usage (session_id TEXT, skill TEXT, count INTEGER, edited INTEGER DEFAULT 0, PRIMARY KEY (session_id, skill));
CREATE TABLE IF NOT EXISTS guard_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, command TEXT, rule TEXT, action TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_dir);
`;

const SESSION_COLS = [
  'session_id', 'project_dir', 'cwd', 'model', 'started_at', 'ended_at',
  'duration_s', 'active_s', 'input_tokens', 'output_tokens', 'cache_read',
  'cache_write_5m', 'cache_write_1h', 'cost_usd', 'turns', 'status', 'raw_ref', 'ingested_at',
];

export function openStore(path) {
  const db = new DatabaseSync(path || dataFile('cc-sessions.db'));
  db.exec(SCHEMA);
  return db;
}

export function upsertSession(db, row) {
  const cols = SESSION_COLS.join(', ');
  const ph = SESSION_COLS.map((c) => '@' + c).join(', ');
  const params = {};
  for (const c of SESSION_COLS) params[c] = row[c] ?? null;
  db.prepare(`INSERT OR REPLACE INTO sessions (${cols}) VALUES (${ph})`).run(params);
}

export function replaceTools(db, sessionId, counts) {
  db.prepare('DELETE FROM tool_usage WHERE session_id = ?').run(sessionId);
  const ins = db.prepare('INSERT INTO tool_usage (session_id, tool, count) VALUES (?, ?, ?)');
  for (const [tool, count] of Object.entries(counts || {})) ins.run(sessionId, tool, count);
}

export function replaceSkills(db, sessionId, counts, editedSet = new Set()) {
  db.prepare('DELETE FROM skill_usage WHERE session_id = ?').run(sessionId);
  const ins = db.prepare('INSERT INTO skill_usage (session_id, skill, count, edited) VALUES (?, ?, ?, ?)');
  for (const [skill, count] of Object.entries(counts || {})) ins.run(sessionId, skill, count, editedSet.has(skill) ? 1 : 0);
}

export function replaceGuardHits(db, sessionId, hits) {
  db.prepare('DELETE FROM guard_hits WHERE session_id = ?').run(sessionId);
  const ins = db.prepare('INSERT INTO guard_hits (session_id, ts, command, rule, action) VALUES (?, ?, ?, ?, ?)');
  for (const h of hits || []) ins.run(sessionId, h.ts ?? null, h.command ?? null, h.rule ?? null, h.action ?? null);
}

export function listSessions(db, { project, limit = 200 } = {}) {
  if (project) {
    return db.prepare('SELECT * FROM sessions WHERE project_dir = ? ORDER BY started_at DESC LIMIT ?').all(project, limit);
  }
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
}

export function getSession(db, id) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
  if (!session) return null;
  const tools = db.prepare('SELECT tool, count FROM tool_usage WHERE session_id = ? ORDER BY count DESC').all(id);
  const skills = db.prepare('SELECT skill, count, edited FROM skill_usage WHERE session_id = ? ORDER BY count DESC').all(id);
  const guard_hits = db.prepare('SELECT ts, command, rule, action FROM guard_hits WHERE session_id = ? ORDER BY ts').all(id);
  return { session, tools, skills, guard_hits };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/store.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/store.mjs src/lib/cc/store.test.mjs
git commit -m "feat(cc): node:sqlite session store"
```

---

## Task 2: Transcript session parser (`src/lib/cc/ingest.mjs`)

**Files:**
- Create: `src/lib/cc/ingest.mjs`
- Test: `src/lib/cc/ingest.test.mjs`

**Interfaces:**
- Consumes: `newFileState`, `parseClaudeLines` (`../usage.mjs`); `costForClaude` (`../usage-pricing.mjs`).
- Produces: `parseSessionText(text, meta) -> sessionRow` where `meta = { fileName, rawRef }`.
  The row matches Task 1's `sessions` keys, plus `_tools` (`{name:count}`), `_skills`
  (`{skill:count}`), `_editedSkills` (`Set`). Token/cost come from `parseClaudeLines` +
  `costForClaude`; tools/skills/turns/`skill_edited` come from a second pass.
  `SKILL_PATH_RE` matches an Edit/Write `file_path` under a skills dir.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText } from './ingest.mjs';

const lines = [
  { type: 'user', cwd: '/p/a', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:00Z' },
  { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:05Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:20Z',
    message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 10 },
      content: [
        { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/x/.claude/skills/foo/SKILL.md' } },
      ] } },
];
const text = lines.map((l) => JSON.stringify(l)).join('\n');

test('parseSessionText extracts tokens, tools, skills, skill_edited', () => {
  const row = parseSessionText(text, { fileName: 'sess-1.jsonl', rawRef: '/t/sess-1.jsonl' });
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.project_dir, '/p/a');
  assert.equal(row.input_tokens, 105);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.turns, 2);
  assert.equal(row._tools.Bash, 1);
  assert.equal(row._tools.Edit, 1);
  assert.equal(row._skills['superpowers:brainstorming'], 1);
  assert.ok(row._editedSkills.has('superpowers:brainstorming'));
  assert.equal(row.started_at, '2026-08-21T10:00:00Z');
  assert.ok(typeof row.cost_usd === 'number' || row.cost_usd === null);
});

test('session id falls back to filename stem when absent on lines', () => {
  const row = parseSessionText('{"type":"user","cwd":"/p"}', { fileName: 'abc-123.jsonl', rawRef: '/t/abc-123.jsonl' });
  assert.equal(row.session_id, 'abc-123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest.test.mjs`
Expected: FAIL ("Cannot find module './ingest.mjs'").

- [ ] **Step 3: Write `src/lib/cc/ingest.mjs`**

```javascript
import { newFileState, parseClaudeLines } from '../usage.mjs';
import { costForClaude } from '../usage-pricing.mjs';

export const SKILL_PATH_RE = /(?:^|\/)(?:\.claude\/skills|skills)\/[^/]+\//;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function toSeconds(a, b) {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0;
}

export function parseSessionText(text, meta = {}) {
  const rawLines = text.split('\n').filter((l) => l.trim());
  const state = newFileState('claude');
  parseClaudeLines(rawLines, state); // tokens per model + cwd + firstTs/lastTs/activeSeconds

  const tools = {};
  const skills = {};
  const editedSkills = new Set();
  let turns = 0;
  let sessionId = null;
  let lastSkill = null;

  for (const raw of rawLines) {
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (!sessionId && typeof d.sessionId === 'string') sessionId = d.sessionId;
    if (d.type !== 'assistant') continue;
    turns++;
    for (const b of d.message?.content || []) {
      if (b?.type !== 'tool_use') continue;
      tools[b.name] = (tools[b.name] || 0) + 1;
      if (b.name === 'Skill') {
        const s = b.input?.skill || b.input?.command;
        if (s) { skills[s] = (skills[s] || 0) + 1; lastSkill = s; }
      } else if (EDIT_TOOLS.has(b.name) && SKILL_PATH_RE.test(b.input?.file_path || '')) {
        if (lastSkill) editedSkills.add(lastSkill);
      }
    }
  }

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let cost = 0;
  let priced = false;
  let primaryModel = null;
  let primaryOut = -1;
  for (const [model, m] of Object.entries(state.models)) {
    totals.input += m.input; totals.output += m.output; totals.cacheRead += m.cacheRead;
    totals.cacheWrite5m += m.cacheWrite5m; totals.cacheWrite1h += m.cacheWrite1h;
    const c = costForClaude(model, m);
    if (c != null) { cost += c; priced = true; }
    if (m.output > primaryOut) { primaryOut = m.output; primaryModel = model; }
  }

  const started = state.firstTs ? new Date(state.firstTs * 1000).toISOString() : null;
  const ended = state.lastTs ? new Date(state.lastTs * 1000).toISOString() : null;

  return {
    session_id: sessionId || meta.fileName?.replace(/\.jsonl$/, '') || null,
    project_dir: state.cwd, cwd: state.cwd, model: primaryModel,
    started_at: started, ended_at: ended,
    duration_s: started && ended ? toSeconds(started, ended) : 0,
    active_s: state.activeSeconds || 0,
    input_tokens: totals.input, output_tokens: totals.output, cache_read: totals.cacheRead,
    cache_write_5m: totals.cacheWrite5m, cache_write_1h: totals.cacheWrite1h,
    cost_usd: priced ? cost : null, turns, status: ended ? 'done' : 'unknown',
    raw_ref: meta.rawRef || null, ingested_at: new Date().toISOString(),
    _tools: tools, _skills: skills, _editedSkills: editedSkills,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/ingest.test.mjs`
Expected: PASS (2 tests). `parseClaudeLines` sets `firstTs`/`lastTs` from `d.timestamp`; if the fixture
timestamps produce a different `started_at`, align the assertion to the earliest line's timestamp.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/ingest.mjs src/lib/cc/ingest.test.mjs
git commit -m "feat(cc): per-session transcript parser (tokens/cost/tools/skills)"
```

---

## Task 3: Guard audit ingest (`src/lib/cc/guard-ingest.mjs`)

**Files:**
- Create: `src/lib/cc/guard-ingest.mjs`
- Test: `src/lib/cc/guard-ingest.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseGuardAudit(text) -> Map<sessionId, hit[]>` where `hit = { ts, command, rule, action }`.
  Lines with no `session_id` are grouped under the key `''` (unattached).

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuardAudit } from './guard-ingest.mjs';

const text = [
  JSON.stringify({ ts: '2026-08-21T10:05:00Z', action: 'deny', rule: 'rm-rf-dangerous', command: 'rm -rf /', session_id: 'sess-1' }),
  JSON.stringify({ ts: '2026-08-21T10:06:00Z', action: 'warn', rule: 'git-reset-hard', command: 'git reset --hard', session_id: 'sess-1' }),
  'not json',
  JSON.stringify({ ts: '2026-08-21T10:07:00Z', action: 'deny', rule: 'mkfs', command: 'mkfs /dev/x' }),
].join('\n');

test('groups guard hits by session_id, skips bad lines', () => {
  const map = parseGuardAudit(text);
  assert.equal(map.get('sess-1').length, 2);
  assert.equal(map.get('sess-1')[0].action, 'deny');
  assert.equal(map.get('').length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/guard-ingest.test.mjs`
Expected: FAIL ("Cannot find module './guard-ingest.mjs'").

- [ ] **Step 3: Write `src/lib/cc/guard-ingest.mjs`**

```javascript
export function parseGuardAudit(text) {
  const map = new Map();
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    const key = d.session_id || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ts: d.ts ?? null, command: d.command ?? null, rule: d.rule ?? null, action: d.action ?? null });
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/lib/cc/guard-ingest.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cc/guard-ingest.mjs src/lib/cc/guard-ingest.test.mjs
git commit -m "feat(cc): parse cc-guard audit into per-session hits"
```

---

## Task 4: Ingest runner (`scripts/cc-ingest.mjs`)

**Files:**
- Create: `scripts/cc-ingest.mjs`
- Modify: `package.json` (add `"cc:ingest"` script)
- Test: `scripts/cc-ingest.test.mjs`

**Interfaces:**
- Consumes: `openStore`, `upsertSession`, `replaceTools`, `replaceSkills`, `replaceGuardHits` (Task 1);
  `parseSessionText` (Task 2); `parseGuardAudit` (Task 3).
- Produces: `ingestAll({ claudeDir, guardAudit, db }) -> Promise<{ sessions: number }>` — walks
  `<claudeDir>/<slug>/*.jsonl`, parses + upserts each, attaches guard hits; returns a count.
  The default CLI resolves `claudeDir = ~/.claude/projects`, `guardAudit = ~/.claude/cc-guard/audit.jsonl`,
  `db = openStore()`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, getSession } from '../src/lib/cc/store.mjs';
import { ingestAll } from './cc-ingest.mjs';

test('ingestAll ingests every transcript and attaches guard hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccp-'));
  const proj = join(root, 'projects', '-p-a');
  await mkdir(proj, { recursive: true });
  const lines = [
    { type: 'user', cwd: '/p/a', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:00Z' },
    { type: 'assistant', sessionId: 'sess-1', timestamp: '2026-08-21T10:00:05Z', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(proj, 'sess-1.jsonl'), lines, 'utf8');
  const guard = join(root, 'audit.jsonl');
  await writeFile(guard, JSON.stringify({ ts: 't', action: 'deny', rule: 'r', command: 'rm -rf /', session_id: 'sess-1' }) + '\n', 'utf8');

  const db = openStore(':memory:');
  const res = await ingestAll({ claudeDir: join(root, 'projects'), guardAudit: guard, db });
  assert.equal(res.sessions, 1);
  const got = getSession(db, 'sess-1');
  assert.equal(got.tools.find((t) => t.tool === 'Bash').count, 1);
  assert.equal(got.guard_hits[0].action, 'deny');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cc-ingest.test.mjs`
Expected: FAIL ("Cannot find module './cc-ingest.mjs'").

- [ ] **Step 3: Write `scripts/cc-ingest.mjs`**

```javascript
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits } from '../src/lib/cc/store.mjs';
import { parseSessionText } from '../src/lib/cc/ingest.mjs';
import { parseGuardAudit } from '../src/lib/cc/guard-ingest.mjs';

async function listTranscripts(claudeDir) {
  const out = [];
  let dirents;
  try { dirents = await readdir(claudeDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const sub = join(claudeDir, d.name);
    let files;
    try { files = await readdir(sub); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(join(sub, f));
  }
  return out;
}

export async function ingestAll({ claudeDir, guardAudit, db }) {
  let guardMap = new Map();
  try { guardMap = parseGuardAudit(await readFile(guardAudit, 'utf8')); } catch { /* no audit yet */ }

  let n = 0;
  for (const file of await listTranscripts(claudeDir)) {
    const text = await readFile(file, 'utf8');
    const fileName = file.split('/').pop();
    const row = parseSessionText(text, { fileName, rawRef: file });
    if (!row.session_id) continue;
    upsertSession(db, row);
    replaceTools(db, row.session_id, row._tools);
    replaceSkills(db, row.session_id, row._skills, row._editedSkills);
    replaceGuardHits(db, row.session_id, guardMap.get(row.session_id) || []);
    n++;
  }
  return { sessions: n };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const db = openStore();
  const res = await ingestAll({
    claudeDir: join(homedir(), '.claude', 'projects'),
    guardAudit: join(homedir(), '.claude', 'cc-guard', 'audit.jsonl'),
    db,
  });
  console.log(`cc-ingest: ${res.sessions} sessions`);
}
```

- [ ] **Step 4: Add the npm script to `package.json`**

Add to `"scripts"`:
```json
"cc:ingest": "node --disable-warning=ExperimentalWarning scripts/cc-ingest.mjs"
```

- [ ] **Step 5: Run test to verify it passes, then a real ingest**

```bash
node --disable-warning=ExperimentalWarning --test scripts/cc-ingest.test.mjs   # PASS
npm run cc:ingest                                                              # prints "cc-ingest: N sessions"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/cc-ingest.mjs scripts/cc-ingest.test.mjs package.json
git commit -m "feat(cc): ingest runner over ~/.claude transcripts + guard audit"
```

---

## Task 5: Sessions API route (`src/app/api/sessions/route.js`)

**Files:**
- Create: `src/app/api/sessions/route.js`
- Test: `src/app/api/sessions/route.test.mjs`

**Interfaces:**
- Consumes: `openStore`, `listSessions`, `getSession` (Task 1).
- Produces: a Next.js route `GET(request)`. `?id=<sessionId>` → `getSession` JSON; otherwise
  `?project=&limit=` → `{ sessions: row[] }`. Reads the real store via `openStore()`. Exports a
  testable `handle(searchParams, db)` that the route wraps.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, upsertSession } from '../../../lib/cc/store.mjs';
import { handle } from './route.js';

function db1() {
  const db = openStore(':memory:');
  upsertSession(db, { session_id: 's1', project_dir: '/p/a', cwd: '/p/a', model: 'm', started_at: '2026-08-21T10:00:00Z', ended_at: '2026-08-21T10:10:00Z', duration_s: 600, active_s: 60, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost_usd: 0.01, turns: 3, status: 'done', raw_ref: '/t/s1.jsonl', ingested_at: 'now' });
  return db;
}

test('list returns sessions', () => {
  const res = handle(new URLSearchParams(''), db1());
  assert.equal(res.sessions.length, 1);
});

test('detail returns one session by id', () => {
  const res = handle(new URLSearchParams('id=s1'), db1());
  assert.equal(res.session.session_id, 's1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test src/app/api/sessions/route.test.mjs`
Expected: FAIL ("Cannot find module './route.js'").

- [ ] **Step 3: Write `src/app/api/sessions/route.js`**

```javascript
import { openStore, listSessions, getSession } from '../../../lib/cc/store.mjs';

export function handle(searchParams, db) {
  const id = searchParams.get('id');
  if (id) return getSession(db, id) || { session: null };
  const project = searchParams.get('project') || undefined;
  const limit = Number(searchParams.get('limit')) || 200;
  return { sessions: listSessions(db, { project, limit }) };
}

export async function GET(request) {
  const db = openStore();
  const { searchParams } = new URL(request.url);
  return Response.json(handle(searchParams, db));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test src/app/api/sessions/route.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sessions/route.js src/app/api/sessions/route.test.mjs
git commit -m "feat(cc): /api/sessions list + detail route"
```

---

## Task 6: Sessions viewer page (`src/app/sessions/page.js`)

**Files:**
- Create: `src/app/sessions/page.js`

**Interfaces:**
- Consumes: `GET /api/sessions` and `GET /api/sessions?id=`. No new exports.

- [ ] **Step 1: Write `src/app/sessions/page.js`** (Client Component; follows stow's existing App Router style)

```javascript
'use client';
import { useEffect, useState } from 'react';

export default function SessionsPage() {
  const [sessions, setSessions] = useState([]);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    fetch('/api/sessions').then((r) => r.json()).then((d) => setSessions(d.sessions || []));
  }, []);

  function open(id) {
    fetch(`/api/sessions?id=${encodeURIComponent(id)}`).then((r) => r.json()).then(setDetail);
  }

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24 }}>
      <div style={{ flex: 1 }}>
        <h1>Sessions</h1>
        <table>
          <thead><tr><th>Started</th><th>Project</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Turns</th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.session_id} onClick={() => open(s.session_id)} style={{ cursor: 'pointer' }}>
                <td>{s.started_at?.slice(0, 16).replace('T', ' ')}</td>
                <td>{s.project_dir?.split('/').slice(-1)[0]}</td>
                <td>{s.model}</td>
                <td>{(s.input_tokens + s.output_tokens).toLocaleString()}</td>
                <td>{s.cost_usd == null ? '—' : `$${s.cost_usd.toFixed(2)}`}</td>
                <td>{s.turns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail?.session && (
        <aside style={{ width: 360 }}>
          <h2>{detail.session.session_id.slice(0, 8)}</h2>
          <p>{detail.session.project_dir}</p>
          <h3>Tools</h3>
          <ul>{detail.tools.map((t) => <li key={t.tool}>{t.tool}: {t.count}</li>)}</ul>
          <h3>Skills</h3>
          <ul>{detail.skills.map((s) => <li key={s.skill}>{s.skill}{s.edited ? ' (edited)' : ''}: {s.count}</li>)}</ul>
          <h3>Guard hits</h3>
          <ul>{detail.guard_hits.map((g, i) => <li key={i}>{g.action}: {g.command}</li>)}</ul>
        </aside>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Manual verification in the running app**

```bash
npm run cc:ingest      # populate the store
npm run dev            # start Next.js
# open http://localhost:3000/sessions — verify the session list renders,
# click a row and confirm tools / skills / guard hits show in the side panel.
```
Expected: a session list with tokens/cost/turns, and a working detail panel.

- [ ] **Step 3: Commit**

```bash
git add src/app/sessions/page.js
git commit -m "feat(cc): session-centric viewer page"
```

---

## Self-Review notes (author checklist, already applied)

- **Spec coverage:** local `node:sqlite` store (spec §4) → Task 1; transcript mining reusing
  `usage.mjs` (spec §3 process path) → Task 2; guard audit → `guard_hits` (spec §4) → Task 3;
  ingest runner (spec §3) → Task 4; session-centric viewer / "kukátko" (spec §6) → Tasks 5–6.
- **Deferred (not in this plan, per spec phasing):** AI summaries + quality score (phase 2),
  work-context Jira/branch/PR (phase 2), sync + egress + team server (phase 3). The `sessions`
  row keeps `quality_score`, `summary`, `git_*`, `jira_ticket`, `project_key` columns as nullable
  placeholders so phases 2–3 add data without a migration.
- **Placeholders:** none — every code and test step is concrete.
- **Type consistency:** `sessions` row keys are identical across Tasks 1, 2, 4, 5; `parseSessionText`
  returns `_tools`/`_skills`/`_editedSkills` consumed verbatim by the runner; `handle(searchParams, db)`
  is defined in Task 5 and used by its own route.

## Dependencies between the two phase-1 plans

cc-guard (plan 1a) writes `~/.claude/cc-guard/audit.jsonl`; this plan reads it in Task 3/4. If
cc-guard is not installed yet, `guardAudit` simply doesn't exist and ingest proceeds with zero
guard hits (handled). The two plans are otherwise independent and can be built in either order.
