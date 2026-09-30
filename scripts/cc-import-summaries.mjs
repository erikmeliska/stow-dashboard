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
