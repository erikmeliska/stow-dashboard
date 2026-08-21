/**
 * Ingest runner: walk Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl)
 * plus cc-guard's audit log and upsert one row per session into the session
 * store. Shared by the CLI (scripts/cc-ingest.mjs), the /api/sessions/ingest
 * route and the refresh cycle.
 *
 * Subagent transcripts (`<slug>/<sessionId>/subagents/*.jsonl`) are folded
 * into their parent session: tokens, cost, tool and skill counts are summed;
 * turns / duration / active time stay those of the main transcript.
 *
 * Work context (branch/repo/PR/ticket) and the quality score are computed from
 * the main transcript only (subagents excluded). AI summaries are NOT touched
 * here (see summary.mjs).
 *
 * Incremental by default: each session's signature (size+mtime of the main
 * transcript and all its subagent files) is kept in `ingest_state`; unchanged
 * sessions are skipped, except that their guard hits are refreshed (the audit
 * log is small and read whole every run). `full: true` re-parses everything.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits,
  getIngestState, setIngestState, clearIngestState,
} from './store.mjs';
import { parseSessionText } from './ingest.mjs';
import { parseGuardAudit } from './guard-ingest.mjs';
import { extractContext, ticketRegex } from './context.mjs';
import { scoreSession, verifyRegex } from './quality.mjs';

export function defaultIngestPaths(env = process.env) {
  return {
    claudeDir: env.CC_CLAUDE_DIR || join(homedir(), '.claude', 'projects'),
    guardAudit: env.CC_GUARD_AUDIT || join(homedir(), '.claude', 'cc-guard', 'audit.jsonl'),
  };
}

async function safeReaddir(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** @returns {Promise<Array<{file: string, subagents: string[]}>>} one entry per session transcript */
export async function listTranscripts(claudeDir) {
  const out = [];
  for (const d of await safeReaddir(claudeDir)) {
    if (!d.isDirectory()) continue;
    const sub = join(claudeDir, d.name);
    for (const f of await safeReaddir(sub)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const stem = f.name.slice(0, -'.jsonl'.length);
      const subagents = (await safeReaddir(join(sub, stem, 'subagents')))
        .filter((a) => a.isFile() && a.name.endsWith('.jsonl'))
        .map((a) => join(sub, stem, 'subagents', a.name));
      out.push({ file: join(sub, f.name), subagents });
    }
  }
  return out;
}

/**
 * Change signature for a session: size+mtime of the main file and every
 * subagent file. mtime is rounded to whole seconds on purpose: Node and Deno
 * report `mtimeMs` with different sub-second precision, and the CLI (Node)
 * and the desktop app (Deno) share one store — with raw ms they kept
 * re-parsing each other's sessions.
 */
async function signatureOf(file, subagents) {
  const parts = [];
  for (const p of [file, ...subagents]) {
    try { const s = await stat(p); parts.push(`${basename(p)}:${s.size}:${Math.floor(s.mtimeMs / 1000)}`); } catch { parts.push(`${basename(p)}:gone`); }
  }
  return parts.join('|');
}

const SUM_KEYS = ['input_tokens', 'output_tokens', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

function addCounts(into, from) {
  for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v;
}

/** Fold a subagent row into its parent session row (mutates `parent`). */
export function mergeSubagent(parent, sub) {
  for (const k of SUM_KEYS) parent[k] = (parent[k] || 0) + (sub[k] || 0);
  if (sub.cost_usd != null) parent.cost_usd = (parent.cost_usd || 0) + sub.cost_usd;
  addCounts(parent._tools, sub._tools);
  addCounts(parent._skills, sub._skills);
  for (const s of sub._editedSkills) parent._editedSkills.add(s);
  if (!parent.model && sub.model) parent.model = sub.model;
  return parent;
}

/**
 * @param {{claudeDir: string, guardAudit: string, db: import('node:sqlite').DatabaseSync, env?: object, full?: boolean}} opts
 * @returns {Promise<{sessions: number, changed: number, skipped: number, ms: number}>}
 */
export async function ingestAll({ claudeDir, guardAudit, db, env = process.env, full = false }) {
  const t0 = Date.now();
  const ticketPattern = ticketRegex(env);
  const verifyPattern = verifyRegex(env);
  let guardMap = new Map();
  try { guardMap = parseGuardAudit(await readFile(guardAudit, 'utf8')); } catch { /* no audit yet */ }

  if (full) clearIngestState(db);
  const state = getIngestState(db);

  let sessions = 0, changed = 0, skipped = 0;
  for (const { file, subagents } of await listTranscripts(claudeDir)) {
    const signature = await signatureOf(file, subagents);
    const prev = state.get(file);
    if (prev && prev.signature === signature && prev.session_id) {
      // Unchanged transcript: only the guard audit may have grown.
      replaceGuardHits(db, prev.session_id, guardMap.get(prev.session_id) || []);
      sessions++; skipped++;
      continue;
    }

    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    const row = parseSessionText(text, { fileName: basename(file), rawRef: file });
    if (!row.session_id) continue;
    for (const sf of subagents) {
      let st;
      try { st = await readFile(sf, 'utf8'); } catch { continue; }
      mergeSubagent(row, parseSessionText(st, { fileName: basename(sf), rawRef: sf }));
    }
    const hits = guardMap.get(row.session_id) || [];
    Object.assign(row, extractContext(row._lines, { ticketPattern }));
    const q = scoreSession(row._lines, { guardHits: hits, verifyPattern });
    row.quality_score = q.score;
    row.quality_detail = JSON.stringify(q.detail);
    db.exec('BEGIN');
    try {
      upsertSession(db, row);
      replaceTools(db, row.session_id, row._tools);
      replaceSkills(db, row.session_id, row._skills, row._editedSkills);
      replaceGuardHits(db, row.session_id, hits);
      setIngestState(db, file, row.session_id, signature);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sessions++; changed++;
  }
  return { sessions, changed, skipped, ms: Date.now() - t0 };
}

let inFlight = null;

/**
 * Run an ingest against the real store with the default paths, serialised:
 * concurrent callers (refresh cycle + page reload) share one run.
 */
export function runIngest({ full = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const db = openStore();
    try { return await ingestAll({ ...defaultIngestPaths(), db, full }); }
    finally { db.close(); inFlight = null; }
  })();
  return inFlight;
}
