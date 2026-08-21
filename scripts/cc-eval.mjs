#!/usr/bin/env node
/**
 * cc-eval — on-demand AI summaries for stored sessions (uses your local `claude` CLI).
 *
 *   npm run cc:eval -- --summaries                 # newest sessions without a summary (limit 5)
 *   npm run cc:eval -- --summaries --limit 20
 *   npm run cc:eval -- --summaries --id <session_id>
 *
 * Never runs from ingest: each summary is a real (cheap, ~1k-token) Claude call.
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
      const s = JSON.parse(r.session.summary);
      ok++;
      log(`✓ ${sid.slice(0, 8)} ${s.outcome}: ${s.what}`);
    } catch (e) {
      failed++;
      log(`✗ ${sid.slice(0, 8)} ${e.kind || 'error'}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
      if (e.kind === 'cli-missing') break;
    }
  }
  return { ok, failed, total: ids.length };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { values } = parseArgs({ options: { summaries: { type: 'boolean' }, limit: { type: 'string' }, id: { type: 'string' } } });
  if (!values.summaries) {
    console.error('usage: cc-eval --summaries [--limit N] [--id SESSION_ID]');
    process.exit(2);
  }
  const db = openStore();
  const r = await evalSummaries(db, { limit: Number(values.limit) || 5, id: values.id || null });
  db.close();
  console.log(`cc-eval: ${r.ok} summarised, ${r.failed} failed of ${r.total}`);
}
