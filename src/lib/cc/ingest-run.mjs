/**
 * Ingest runner: walk Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl)
 * plus cc-guard's audit log and upsert one row per session into the session
 * store. Shared by the CLI (scripts/cc-ingest.mjs), the /api/sessions/ingest
 * route and the refresh cycle.
 *
 * Subagent transcripts (`<slug>/<sessionId>/subagents/*.jsonl`) are folded
 * into their parent session: tokens, cost, tool and skill counts are summed;
 * turns / duration / active time stay those of the main transcript. Each one
 * is also recorded on its own in the `subagents` table (type + description
 * from the sibling `.meta.json`) so the UI can break the family down.
 *
 * Codex rollouts (`~/.codex/sessions`, parsed by codex-ingest.mjs) are ingested
 * in the same pass; their subagents carry an explicit root-thread parent.
 *
 * Hook-spawned SDK sessions (see session-link.mjs) get a `kind` from the
 * parser and are attached to a parent by `linkChildren` after every walk.
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
  openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits, replaceSubagents,
  getIngestState, setIngestState, clearIngestState, listUnlinked, listParentCandidates, setParent,
} from './store.mjs';
import { LINKABLE_KIND_NAMES, pickParent, turnEndTimestamps } from './session-link.mjs';
import { parseSessionText } from './ingest.mjs';
import { parseGuardAudit } from './guard-ingest.mjs';
import { extractContext, ticketRegex } from './context.mjs';
import { scoreSession, verifyRegex } from './quality.mjs';
import { ledgerFile } from '../state-dir.mjs';
import { assignPlacements, loadPlacementContext } from './project-key.mjs';
import { listGeminiDbs, parseGeminiSession } from './gemini-ingest.mjs';
import { listCodexFiles } from '../usage.mjs';
import { parseCodexSession } from './codex-ingest.mjs';
import { loadPathMoves, resolveMovedPath } from '../path-moves.mjs';

export function defaultIngestPaths(env = process.env) {
  return {
    claudeDir: env.CC_CLAUDE_DIR || join(homedir(), '.claude', 'projects'),
    geminiDir: env.CC_GEMINI_DIR || join(homedir(), '.gemini', 'antigravity', 'conversations'),
    geminiCliDir: env.CC_GEMINI_CLI_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'conversations'),
    codexDir: env.CC_CODEX_DIR || join(homedir(), '.codex', 'sessions'),
    guardAudit: env.CC_GUARD_AUDIT || join(homedir(), '.claude', 'cc-guard', 'audit.jsonl'),
  };
}

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
 * re-parsing each other's sessions. Parts are sorted for the same reason:
 * readdir order differs between runtimes.
 */
async function signatureOf(file, subagents) {
  const parts = [];
  for (const p of [file, ...subagents]) {
    try { const s = await stat(p); parts.push(`${basename(p)}:${s.size}:${Math.floor(s.mtimeMs / 1000)}`); } catch { parts.push(`${basename(p)}:gone`); }
  }
  return parts.sort().join('|');
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

/** `agent-<id>.jsonl` → its `.meta.json` ({agentType, description, …}) or {} when absent. */
async function readAgentMeta(file) {
  try { return JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return {}; }
}

/** The `subagents` row for one nested agent transcript. */
export function subagentRow(sub, meta = {}, file = null) {
  return {
    agent_id: file ? basename(file).replace(/\.jsonl$/, '') : null,
    agent_type: meta.agentType ?? null, description: meta.description ?? null,
    model: sub.model, started_at: sub.started_at, ended_at: sub.ended_at, active_s: sub.active_s, turns: sub.turns,
    input_tokens: sub.input_tokens, output_tokens: sub.output_tokens, cache_read: sub.cache_read,
    cache_write: (sub.cache_write_5m || 0) + (sub.cache_write_1h || 0), cost_usd: sub.cost_usd, raw_ref: file,
  };
}

/** Subagent transcript paths of a session, given its main transcript path. */
async function subagentFilesOf(file) {
  const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
  return (await safeReaddir(dir)).filter((a) => a.isFile() && a.name.endsWith('.jsonl')).map((a) => join(dir, a.name));
}

/**
 * Attach every still-unlinked child session to a parent. Re-run on each
 * ingest: a child that appeared while its parent was mid-turn finds the parent
 * once the parent's transcript has caught up. Candidate turn times are read
 * from disk (cached per run); without `full`, only children from the last
 * `RETRY_WINDOW_MS` are retried so permanent orphans don't cost a transcript
 * read every cycle.
 * @returns {Promise<number>} sessions linked in this pass
 */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function linkChildren(db, { readText = (f) => readFile(f, 'utf8'), full = false, now = Date.now() } = {}) {
  const cache = new Map();
  const load = async (row) => {
    if (cache.has(row.session_id)) return cache.get(row.session_id);
    const ends = [];
    const files = row.raw_ref ? [row.raw_ref, ...(await subagentFilesOf(row.raw_ref))] : [];
    for (const f of files) {
      try { ends.push(...turnEndTimestamps(await readText(f))); } catch { /* transcript gone */ }
    }
    ends.sort((a, b) => a - b);
    cache.set(row.session_id, ends);
    return ends;
  };
  let linked = 0;
  const since = full ? null : new Date(now - RETRY_WINDOW_MS).toISOString();
  for (const child of listUnlinked(db, LINKABLE_KIND_NAMES, { since })) {
    const candidates = listParentCandidates(db, child);
    const ends = new Map();
    for (const c of candidates) ends.set(c.session_id, await load(c));
    const pick = pickParent(child, candidates, { turnEndsOf: (c) => ends.get(c.session_id) });
    if (!pick) continue;
    setParent(db, child.session_id, pick.parent_session_id);
    linked++;
  }
  return linked;
}

/**
 * `codexDir` (optional) is the Codex sessions root. `placement` (optional) is a
 * project-key.mjs context; without one the placement pass is skipped (runIngest
 * always passes the real one, tests inject theirs). `moves` (optional) are the
 * #11 path moves (`loadPathMoves()`; runIngest passes the real ones).
 * @param {{claudeDir: string, codexDir?: string, guardAudit: string, db: import('node:sqlite').DatabaseSync, env?: object, full?: boolean, placement?: object, moves?: Array<{from: string, to: string}>}} opts
 * @returns {Promise<{sessions: number, changed: number, skipped: number, linked: number, placed: {checked: number, updated: number}|null, placement_error?: string, ms: number}>}
 */
export async function ingestAll({
  claudeDir,
  geminiDir = null,
  geminiCliDir = null,
  codexDir = null,
  guardAudit,
  db,
  env = process.env,
  full = false,
  projectDirs = null,
  placement = null,
  moves = [],
}) {
  const t0 = Date.now();
  // Physical moves (#11): transcripts keep their old cwd forever, so every
  // re-ingest maps it to the project's current path before the upsert.
  const relocate = (row) => moves.length
    ? Object.assign(row, { project_dir: resolveMovedPath(row.project_dir, moves, { at: row.started_at }), cwd: resolveMovedPath(row.cwd, moves, { at: row.started_at }) })
    : row;
  const ticketPattern = ticketRegex(env);
  const verifyPattern = verifyRegex(env);
  let guardMap = new Map();
  try { guardMap = parseGuardAudit(await readFile(guardAudit, 'utf8')); } catch { /* no audit yet */ }

  if (full) clearIngestState(db);
  const state = getIngestState(db);
  // No signatures at all means everything gets (re-)parsed — a fresh store or
  // a schema migration — so the link pass must also look past its retry window.
  const linkAll = full || state.size === 0;

  let sessions = 0, changed = 0, skipped = 0;
  if (claudeDir) {
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
      const agents = [];
      for (const sf of subagents) {
        let st;
        try { st = await readFile(sf, 'utf8'); } catch { continue; }
        const sub = parseSessionText(st, { fileName: basename(sf), rawRef: sf });
        mergeSubagent(row, sub);
        agents.push(subagentRow(sub, await readAgentMeta(sf), sf));
      }
      const hits = guardMap.get(row.session_id) || [];
      Object.assign(row, extractContext(row._lines, { ticketPattern }));
      const q = scoreSession(row._lines, { guardHits: hits, verifyPattern });
      row.quality_score = q.score;
      row.quality_detail = JSON.stringify(q.detail);
      db.exec('BEGIN');
      try {
        upsertSession(db, relocate(row));
        replaceTools(db, row.session_id, row._tools);
        replaceSkills(db, row.session_id, row._skills, row._editedSkills);
        replaceGuardHits(db, row.session_id, hits);
        replaceSubagents(db, row.session_id, agents);
        setIngestState(db, file, row.session_id, signature);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      sessions++; changed++;
    }
  }

  if (geminiDir || geminiCliDir) {
    const geminiDbs = await listGeminiDbs([geminiDir, geminiCliDir]);
    if (geminiDbs.length > 0) {
      const projects = await loadProjectDirs(projectDirs);

      for (const file of geminiDbs) {
        let s;
        try { s = await stat(file); } catch { continue; }
        const signature = `${basename(file)}:${s.size}:${Math.floor(s.mtimeMs / 1000)}`;
        const prev = state.get(file);
        if (prev && prev.signature === signature && prev.session_id) {
          sessions++; skipped++;
          continue;
        }

        const row = parseGeminiSession(file, { projectDirs: projects, rawRef: file });
        if (!row || !row.session_id) continue;
        row.kind = 'main';
        row.entrypoint = file.includes('antigravity-cli') ? 'antigravity-cli' : 'antigravity';

        db.exec('BEGIN');
        try {
          upsertSession(db, relocate(row));
          replaceTools(db, row.session_id, row._tools);
          replaceSkills(db, row.session_id, row._skills, row._editedSkills);
          replaceGuardHits(db, row.session_id, []);
          setIngestState(db, file, row.session_id, signature);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        sessions++; changed++;
      }
    }
  }

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
        upsertSession(db, relocate(row));
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

  // Placement after every source is in, before linking (#12). Recomputes all
  // rows, so it is also the backfill and follows register changes.
  let placed = null, placement_error = null;
  if (placement) {
    try {
      const { checked, updated } = await assignPlacements(db, placement);
      placed = { checked, updated };
    } catch (e) {
      placement_error = String(e?.message || e);
      console.warn('[cc] placement failed:', placement_error);
    }
  }

  const linked = await linkChildren(db, { full: linkAll });
  return { sessions, changed, skipped, linked, placed, ...(placement_error ? { placement_error } : {}), ms: Date.now() - t0 };
}

// Module state on globalThis: Next may bundle this module into several route
// chunks, and the refresh route and a relocation must share one lock.
const S = globalThis.__stowIngestRun ??= { inFlight: null, exclusive: 0, chain: Promise.resolve() };

/**
 * Run an ingest against the real store with the default paths, serialised:
 * concurrent callers (refresh cycle + page reload) share one run.
 */
export function runIngest({ full = false } = {}) {
  if (S.exclusive) return Promise.resolve({ ...DEFERRED });
  if (S.inFlight) return S.inFlight;
  S.inFlight = (async () => {
    const db = openStore();
    try { return await ingestAll({ ...defaultIngestPaths(), db, full, placement: await loadPlacementContext(), moves: await loadPathMoves() }); }
    finally { db.close(); S.inFlight = null; }
  })();
  return S.inFlight;
}

const DEFERRED = { sessions: 0, changed: 0, skipped: 0, linked: 0, placed: null, deferred: true, ms: 0 };

/**
 * Run `fn` while no ingest runs in this process (#11 relocation): callers queue
 * on a promise chain (never two at once), each waits for an in-flight ingest,
 * and a runIngest() call meanwhile returns a no-op `{deferred: true}` at once
 * instead of racing the DB rewrite.
 */
export async function runExclusive(fn) {
  S.exclusive++; // counted at once: a queued move already defers new ingests
  const prev = S.chain;
  let release;
  S.chain = new Promise((r) => { release = r; });
  try {
    await prev;
    while (S.inFlight) await S.inFlight.catch(() => {});
    return await fn();
  } finally {
    S.exclusive--;
    release();
  }
}
