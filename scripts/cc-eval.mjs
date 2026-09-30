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
  log = console.log, summarizeImpl = summarizeSession, now = null,
} = {}) {
  const at = now ?? Date.now(); // snapshot for selection; heartbeats use a live clock unless injected
  const clock = now != null ? () => now : Date.now;
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
  let ids = selectMissing(db, { since: iso(since), until: iso(until), force, now: at });
  if (!since && !until) ids = ids.slice(-limit); // oldest-first → newest `limit`
  const { job, started, done } = startBatch(db, {
    ids, model: model || batchModel(), concurrency, summarizeImpl,
    openDb: () => db, closeDb: () => {}, now: clock,
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
    concurrency: Math.max(1, Math.floor(Number(values.concurrency) || DEFAULT_CONCURRENCY)), model: values.model,
  });
  db.close();
  console.log(`cc-eval: ${r.ok} summarised, ${r.failed} failed of ${r.total}`);
}
