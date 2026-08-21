#!/usr/bin/env node
/**
 * cc-ingest — walk Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl)
 * plus cc-guard's audit log and upsert one row per session into the node:sqlite
 * session store (src/lib/cc/store.mjs). Idempotent: re-running replaces rows.
 *
 * Subagent transcripts (`<slug>/<sessionId>/subagents/*.jsonl`) are folded
 * into their parent session: tokens, cost, tool and skill counts are summed;
 * turns / duration / active time stay those of the main transcript.
 *
 * Phase 1b: a full re-parse on every run (no incremental skip yet).
 *
 *   npm run cc:ingest
 *   CC_CLAUDE_DIR=/x/projects CC_GUARD_AUDIT=/x/audit.jsonl npm run cc:ingest
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, upsertSession, replaceTools, replaceSkills, replaceGuardHits } from '../src/lib/cc/store.mjs';
import { parseSessionText } from '../src/lib/cc/ingest.mjs';
import { parseGuardAudit } from '../src/lib/cc/guard-ingest.mjs';

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

export async function ingestAll({ claudeDir, guardAudit, db }) {
  let guardMap = new Map();
  try { guardMap = parseGuardAudit(await readFile(guardAudit, 'utf8')); } catch { /* no audit yet */ }

  let n = 0;
  for (const { file, subagents } of await listTranscripts(claudeDir)) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    const row = parseSessionText(text, { fileName: basename(file), rawRef: file });
    if (!row.session_id) continue;
    for (const sf of subagents) {
      let st;
      try { st = await readFile(sf, 'utf8'); } catch { continue; }
      mergeSubagent(row, parseSessionText(st, { fileName: basename(sf), rawRef: sf }));
    }
    db.exec('BEGIN');
    try {
      upsertSession(db, row);
      replaceTools(db, row.session_id, row._tools);
      replaceSkills(db, row.session_id, row._skills, row._editedSkills);
      replaceGuardHits(db, row.session_id, guardMap.get(row.session_id) || []);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    n++;
  }
  return { sessions: n };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const t0 = Date.now();
  const db = openStore();
  const res = await ingestAll({
    claudeDir: process.env.CC_CLAUDE_DIR || join(homedir(), '.claude', 'projects'),
    guardAudit: process.env.CC_GUARD_AUDIT || join(homedir(), '.claude', 'cc-guard', 'audit.jsonl'),
    db,
  });
  db.close();
  console.log(`cc-ingest: ${res.sessions} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
