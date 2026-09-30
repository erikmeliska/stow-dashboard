/**
 * Local Claude Code session store (node:sqlite, no third-party dependency).
 *
 * One DB file beside stow's JSON ledger (`dataFile('cc-sessions.db')`) holding
 * one row per session plus per-session tool/skill counts and cc-guard hits.
 * Stow's own ledger (projects_metadata.jsonl, usage.json) is untouched — this
 * is a *new* store for session-centric data, not a migration.
 *
 * Session rows also carry nullable columns reserved for later phases
 * (machine/user/project_key, git_*, jira_ticket, quality_score, summary) so
 * those can be filled without a schema migration.
 */
import { DatabaseSync } from 'node:sqlite';
import { dataFile } from '../state-dir.mjs';

export const DB_NAME = 'cc-sessions.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine TEXT, user TEXT, project_dir TEXT, project_key TEXT, cwd TEXT, model TEXT,
  started_at TEXT, ended_at TEXT, duration_s REAL, active_s REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
  cache_write_5m INTEGER, cache_write_1h INTEGER, cost_usd REAL,
  turns INTEGER, status TEXT, git_repo TEXT, git_branch TEXT, pr TEXT,
  ticket_id TEXT, ticket_source TEXT,
  quality_score REAL, quality_detail TEXT, summary TEXT, summary_model TEXT, summarized_at TEXT,
  raw_ref TEXT, ingested_at TEXT,
  parent_session_id TEXT, kind TEXT, entrypoint TEXT,
  title TEXT, title_source TEXT, user_prompts INTEGER
);
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY, session_id TEXT, agent_type TEXT, description TEXT, model TEXT,
  started_at TEXT, ended_at TEXT, active_s REAL, turns INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, cost_usd REAL, raw_ref TEXT
);
CREATE TABLE IF NOT EXISTS tool_usage (session_id TEXT, tool TEXT, count INTEGER, PRIMARY KEY (session_id, tool));
CREATE TABLE IF NOT EXISTS skill_usage (session_id TEXT, skill TEXT, count INTEGER, edited INTEGER DEFAULT 0, PRIMARY KEY (session_id, skill));
CREATE TABLE IF NOT EXISTS guard_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, command TEXT, rule TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS ingest_state (path TEXT PRIMARY KEY, session_id TEXT, signature TEXT, ingested_at TEXT);
CREATE TABLE IF NOT EXISTS summary_jobs (
  job_id TEXT PRIMARY KEY, status TEXT, model TEXT, concurrency INTEGER,
  total INTEGER, done INTEGER, failed TEXT, ids TEXT,
  started_at TEXT, heartbeat_at TEXT, finished_at TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_guard_session ON guard_hits (session_id);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents (session_id);
`;

/** Ingest-owned columns: rewritten on every upsert. Summary columns are NOT here. */
const SESSION_COLS = [
  'session_id', 'project_dir', 'cwd', 'model', 'started_at', 'ended_at',
  'duration_s', 'active_s', 'input_tokens', 'output_tokens', 'cache_read',
  'cache_write_5m', 'cache_write_1h', 'cost_usd', 'turns', 'status', 'raw_ref', 'ingested_at',
  'git_repo', 'git_branch', 'pr', 'ticket_id', 'ticket_source', 'quality_score', 'quality_detail',
  'kind', 'entrypoint',
  'title', 'title_source', 'user_prompts',
];

/** Columns of the `subagents` table, in insert order. */
const SUBAGENT_COLS = [
  'agent_id', 'session_id', 'agent_type', 'description', 'model', 'started_at', 'ended_at', 'active_s', 'turns',
  'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'cost_usd', 'raw_ref',
];

/** Columns added after phase 1; `openStore` adds them to older DB files in place. */
const MIGRATION_COLS = {
  ticket_id: 'TEXT', ticket_source: 'TEXT', pr: 'TEXT',
  quality_detail: 'TEXT', summary_model: 'TEXT', summarized_at: 'TEXT',
  parent_session_id: 'TEXT', kind: 'TEXT', entrypoint: 'TEXT',
  title: 'TEXT', title_source: 'TEXT', user_prompts: 'INTEGER',
};

export function ensureColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(MIGRATION_COLS)) {
    if (have.has(col)) continue;
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
    } catch (e) {
      // Another process (Next vs MCP) migrated the same file between our
      // table_info read and this ALTER: the column is there, which is the goal.
      if (!/duplicate column name/i.test(String(e?.message))) throw e;
    }
  }
  // kind/entrypoint only get filled by a re-parse: forget the incremental
  // signatures so the next ingest walks every transcript once.
  if (!have.has('kind') && have.size > 0) db.exec('DELETE FROM ingest_state');
  // title/user_prompts only get filled by a re-parse as well.
  if (!have.has('title') && have.size > 0) db.exec('DELETE FROM ingest_state');
  // Indexes on migrated columns can only be created once the column exists.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)');
}

/**
 * Open (creating if needed) the session store and bring its schema up to date.
 * `path` defaults to the state-dir DB; an already-open DatabaseSync is accepted too.
 */
export function openStore(path) {
  const db = path instanceof DatabaseSync ? path : new DatabaseSync(path || dataFile(DB_NAME));
  if (!(path instanceof DatabaseSync) && path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // Wait for another process's write lock instead of failing at once.
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec(SCHEMA);
  ensureColumns(db);
  return db;
}

export function upsertSession(db, row) {
  const cols = SESSION_COLS.join(', ');
  const ph = SESSION_COLS.map((c) => '@' + c).join(', ');
  const set = SESSION_COLS.filter((c) => c !== 'session_id').map((c) => `${c} = excluded.${c}`).join(', ');
  const params = {};
  for (const c of SESSION_COLS) params[c] = row[c] ?? null;
  db.prepare(`INSERT INTO sessions (${cols}) VALUES (${ph}) ON CONFLICT(session_id) DO UPDATE SET ${set}`).run(params);
}

/**
 * `parent_session_id` is written by the link pass (ingest-run.mjs), not by the
 * upsert: a re-parse of a child transcript must not drop a link that was
 * already inferred. `null` clears it.
 */
export function setParent(db, sessionId, parentId) {
  db.prepare('UPDATE sessions SET parent_session_id = ? WHERE session_id = ?').run(parentId ?? null, sessionId);
}

/** Nested Agent-tool runs of one session; replaced whole on every re-parse of the parent. */
export function replaceSubagents(db, sessionId, agents) {
  db.prepare('DELETE FROM subagents WHERE session_id = ?').run(sessionId);
  const cols = SUBAGENT_COLS.join(', ');
  const ph = SUBAGENT_COLS.map((c) => '@' + c).join(', ');
  const ins = db.prepare(`INSERT OR REPLACE INTO subagents (${cols}) VALUES (${ph})`);
  for (const a of agents || []) {
    const params = { session_id: sessionId };
    for (const c of SUBAGENT_COLS) if (c !== 'session_id') params[c] = a[c] ?? null;
    ins.run(params);
  }
}

/** Nested agents of the given sessions (all sessions when `ids` is omitted). */
export function listSubagents(db, ids = null) {
  if (ids == null) return db.prepare('SELECT * FROM subagents ORDER BY started_at').all();
  if (ids.length === 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...db.prepare(`SELECT * FROM subagents WHERE session_id IN (${chunk.map(() => '?').join(',')}) ORDER BY started_at`).all(...chunk));
  }
  return out;
}

/** Summary columns live outside the ingest upsert so re-ingests never erase them. */
export function setSummary(db, sessionId, { summary, model, at }) {
  db.prepare('UPDATE sessions SET summary = ?, summary_model = ?, summarized_at = ? WHERE session_id = ?')
    .run(summary ?? null, model ?? null, at ?? new Date().toISOString(), sessionId);
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

export function getSession(db, id) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
  if (!session) return null;
  const tools = db.prepare('SELECT tool, count FROM tool_usage WHERE session_id = ? ORDER BY count DESC').all(id);
  const skills = db.prepare('SELECT skill, count, edited FROM skill_usage WHERE session_id = ? ORDER BY count DESC').all(id);
  const guard_hits = db.prepare('SELECT ts, command, rule, action FROM guard_hits WHERE session_id = ? ORDER BY ts').all(id);
  const agents = db.prepare('SELECT * FROM subagents WHERE session_id = ? ORDER BY started_at').all(id);
  const children = db.prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at').all(id);
  const parent = session.parent_session_id
    ? db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session.parent_session_id) || null
    : null;
  return { session, tools, skills, guard_hits, agents, children, parent };
}

/**
 * Rows that still need a parent: linkable kinds without a link. `since` bounds
 * the retry window (a child whose parent never shows up would otherwise be
 * re-examined on every 60 s cycle); pass null to retry everything.
 */
export function listUnlinked(db, kinds, { since = null } = {}) {
  if (!kinds.length) return [];
  const ph = kinds.map(() => '?').join(',');
  if (since) return db.prepare(`SELECT * FROM sessions WHERE parent_session_id IS NULL AND kind IN (${ph}) AND started_at >= ?`).all(...kinds, since);
  return db.prepare(`SELECT * FROM sessions WHERE parent_session_id IS NULL AND kind IN (${ph})`).all(...kinds);
}

/**
 * Candidate parents for a child: every Claude Code main or scheduled session (hooks don't
 * run in Gemini/Antigravity) that had started before the child and was still
 * running at the child's start, allowing `slackS` seconds past the recorded
 * end since a parent's transcript is only appended after the hook that spawned
 * the child returns. Not restricted to the child's directory: the reviewer runs
 * in the repo root of the edited files, and the parent may sit in a sibling or
 * ancestor directory. session-link.mjs ranks them by timing.
 */
export function listParentCandidates(db, { started_at }, slackS = 120) {
  if (!started_at) return [];
  const t = Date.parse(started_at);
  if (!Number.isFinite(t)) return [];
  const lower = new Date(t - slackS * 1000).toISOString();
  return db.prepare(`SELECT * FROM sessions WHERE kind IN ('main', 'scheduled') AND coalesce(entrypoint, '') NOT LIKE 'antigravity%' AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC`)
    .all(started_at, lower);
}

/** Incremental-ingest bookkeeping: transcript path → { session_id, signature }. */
export function getIngestState(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT path, session_id, signature FROM ingest_state').all()) map.set(r.path, { session_id: r.session_id, signature: r.signature });
  return map;
}

export function setIngestState(db, path, sessionId, signature) {
  db.prepare('INSERT INTO ingest_state (path, session_id, signature, ingested_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET session_id = excluded.session_id, signature = excluded.signature, ingested_at = excluded.ingested_at')
    .run(path, sessionId, signature, new Date().toISOString());
}

export function clearIngestState(db) {
  db.exec('DELETE FROM ingest_state');
}
