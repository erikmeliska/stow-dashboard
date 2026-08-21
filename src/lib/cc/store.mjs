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
  raw_ref TEXT, ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_usage (session_id TEXT, tool TEXT, count INTEGER, PRIMARY KEY (session_id, tool));
CREATE TABLE IF NOT EXISTS skill_usage (session_id TEXT, skill TEXT, count INTEGER, edited INTEGER DEFAULT 0, PRIMARY KEY (session_id, skill));
CREATE TABLE IF NOT EXISTS guard_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, command TEXT, rule TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS ingest_state (path TEXT PRIMARY KEY, session_id TEXT, signature TEXT, ingested_at TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_guard_session ON guard_hits (session_id);
`;

/** Ingest-owned columns: rewritten on every upsert. Summary columns are NOT here. */
const SESSION_COLS = [
  'session_id', 'project_dir', 'cwd', 'model', 'started_at', 'ended_at',
  'duration_s', 'active_s', 'input_tokens', 'output_tokens', 'cache_read',
  'cache_write_5m', 'cache_write_1h', 'cost_usd', 'turns', 'status', 'raw_ref', 'ingested_at',
  'git_repo', 'git_branch', 'pr', 'ticket_id', 'ticket_source', 'quality_score', 'quality_detail',
];

/** Columns added after phase 1; `openStore` adds them to older DB files in place. */
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

/**
 * Open (creating if needed) the session store and bring its schema up to date.
 * `path` defaults to the state-dir DB; an already-open DatabaseSync is accepted too.
 */
export function openStore(path) {
  const db = path instanceof DatabaseSync ? path : new DatabaseSync(path || dataFile(DB_NAME));
  if (!(path instanceof DatabaseSync) && path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
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
