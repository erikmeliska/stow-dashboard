/**
 * Batch AI summaries ("fill in what's missing"). One implementation behind the
 * /sessions calendar banner, `npm run cc:eval -- --summaries` and the MCP
 * `summarize_sessions` tool.
 *
 * Job state lives in the `summary_jobs` table, not in memory: the MCP server
 * is its own stdio process and the desktop app binds a runtime-assigned port,
 * so a job started from one must be visible to the other. The process that
 * started a job runs it and writes a heartbeat after every session and every
 * HEARTBEAT_MS; a running job whose heartbeat is older than STALE_MS belongs
 * to a process that died and no longer blocks new batches.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openStore, getSessionsByIds } from './store.mjs';
import { DEFAULT_MODELS, summarizeSession, summaryHarness } from './summary.mjs';
import { needsSummary, parseSummary } from './summary-view.mjs';
import { effectiveKind } from './session-link.mjs';

export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

/** Parallel CLI calls for a batch: an integer in 1..MAX_CONCURRENCY; junk/0 → the default. */
export function clampConcurrency(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v === 0) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, v));
}

/** Batch model: CC_SUMMARY_BATCH_MODEL, else the harness default ('' = the CLI's own default). */
export function batchModel(env = process.env, harness = summaryHarness(env)) {
  return (env.CC_SUMMARY_BATCH_MODEL || '').trim() || DEFAULT_MODELS[harness].batch;
}

/**
 * Session ids a batch should summarise.
 * `ids`: exactly what the UI shows (it already applied kind/filters), so only
 * needsSummary is checked. Range (CLI/MCP): top-level rows started in
 * [since, until) whose effectiveKind is in `kinds`.
 * Either way a row whose transcript (`raw_ref`; a Gemini `.db` counts) is no
 * longer on disk is skipped: it could only fail as not-found, and Claude
 * Code's transcript cleanup would otherwise keep it "missing" forever.
 */
export function selectMissing(db, { ids = null, since = null, until = null, force = false, kinds = ['work'], now = Date.now(), exists = existsSync } = {}) {
  let rows;
  if (ids) {
    rows = getSessionsByIds(db, ids);
  } else {
    const conds = ['parent_session_id IS NULL'];
    const args = [];
    if (since) { conds.push('started_at >= ?'); args.push(since); }
    if (until) { conds.push('started_at < ?'); args.push(until); }
    rows = db.prepare(`SELECT * FROM sessions WHERE ${conds.join(' AND ')} ORDER BY started_at`).all(...args)
      .filter((r) => kinds.includes(effectiveKind(r)));
  }
  return rows.filter((r) => needsSummary(r, { force, now }) && exists(r.raw_ref)).map((r) => r.session_id);
}

/** Median CLI time of the last 50 summaries made with `model`; null without history. */
export function medianSummaryMs(db, model) {
  const ms = db.prepare('SELECT summary FROM sessions WHERE summary_model = ? AND summary IS NOT NULL ORDER BY summarized_at DESC LIMIT 50').all(model)
    .map((r) => parseSummary(r)?.ms)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!ms.length) return null;
  const mid = Math.floor(ms.length / 2);
  return ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
}

export function estimateBatch(db, { count, concurrency = DEFAULT_CONCURRENCY, harness = summaryHarness(), model = batchModel(process.env, harness) } = {}) {
  const per = (model ? medianSummaryMs(db, model) : null) ?? (/haiku/i.test(model) ? 10_000 : 30_000);
  return { count, harness, model, seconds: Math.ceil(Math.ceil(count / Math.max(1, concurrency)) * per / 1000) };
}

function toJob(r, now) {
  if (!r) return null;
  const alive = r.status === 'running' && now - Date.parse(r.heartbeat_at || '') < STALE_MS;
  let failed = [], ids = [];
  try { failed = JSON.parse(r.failed || '[]'); } catch { /* keep [] */ }
  try { ids = JSON.parse(r.ids || '[]'); } catch { /* keep [] */ }
  return { ...r, status: r.status === 'running' && !alive ? 'stale' : r.status, failed, ids, alive };
}

/** One job by id, or the most recently started one. */
export function readJob(db, jobId = null, now = Date.now()) {
  const r = jobId
    ? db.prepare('SELECT * FROM summary_jobs WHERE job_id = ?').get(jobId)
    : db.prepare('SELECT * FROM summary_jobs ORDER BY started_at DESC LIMIT 1').get();
  return toJob(r, now);
}

function liveJob(db, now) {
  const r = db.prepare("SELECT * FROM summary_jobs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get();
  const job = toJob(r, now);
  return job?.alive ? job : null;
}

/**
 * Start a batch over `ids` (see selectMissing), or return the live one.
 * With no ids nothing is inserted: the latest job (any status, or null) comes
 * back with started=false, so "nothing to do" never shadows a real job.
 * The worker opens its own connection (`openDb`) so the caller may close `db`
 * as soon as this returns (an API route does).
 */
export function startBatch(db, {
  ids,
  harness = summaryHarness(),
  model = batchModel(process.env, harness),
  concurrency = DEFAULT_CONCURRENCY,
  summarizeImpl = summarizeSession,
  openDb = () => openStore(),
  closeDb = (d) => d.close(),
  onProgress = null,
  now = Date.now,
} = {}) {
  const list = [...new Set(ids || [])];
  if (!list.length) {
    const latest = readJob(db, null, now());
    return { job: latest, started: false, done: Promise.resolve(latest) };
  }
  concurrency = clampConcurrency(concurrency);
  let row;
  db.exec('BEGIN IMMEDIATE');
  try {
    const running = liveJob(db, now());
    if (running) {
      db.exec('COMMIT');
      return { job: running, started: false, done: Promise.resolve(running) };
    }
    const t = new Date(now()).toISOString();
    row = {
      job_id: randomUUID(), status: 'running', model, concurrency,
      total: list.length, done: 0, failed: '[]', ids: JSON.stringify(list),
      started_at: t, heartbeat_at: t, finished_at: null, error: null,
    };
    db.prepare(`INSERT INTO summary_jobs (job_id, status, model, concurrency, total, done, failed, ids, started_at, heartbeat_at, finished_at, error)
      VALUES (@job_id, @status, @model, @concurrency, @total, @done, @failed, @ids, @started_at, @heartbeat_at, @finished_at, @error)`).run(row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const job = readJob(db, row.job_id, now());
  const done = runJob(row.job_id, list, { harness, model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now });
  return { job, started: true, done };
}

/**
 * The MCP `summarize_sessions` flow over [since, until): `statusOnly` only
 * reports (latest job + how many are still missing); otherwise a batch starts
 * over what is missing, unless a job is already live or nothing is missing, in
 * which case the latest job is reported and nothing starts.
 * @returns {{started: boolean, job: object|null, missing: number, estimateSeconds: number, note: string, done: Promise}}
 */
export function rangeBatch(db, { since = null, until = null, force = false, statusOnly = false } = {}, {
  exists, now = Date.now, ...startOpts
} = {}) {
  const ids = selectMissing(db, { since, until, force, now: now(), exists });
  const harness = startOpts.harness || summaryHarness();
  const model = startOpts.model || batchModel(process.env, harness);
  const estimateFor = (n) => estimateBatch(db, { count: n, harness, model }).seconds;
  if (statusOnly) {
    const job = readJob(db, null, now());
    const running = job?.status === 'running';
    const note = running
      ? `A batch is running (${job.done + job.failed.length}/${job.total}). Nothing was started.`
      : `${ids.length} session(s) in this period still have no summary. Nothing was started.`;
    return { started: false, job, missing: ids.length, estimateSeconds: running ? estimateFor(job.total - job.done - job.failed.length) : estimateFor(ids.length), note, done: Promise.resolve(job) };
  }
  const { job, started, done } = startBatch(db, { ids, harness, model, now, ...startOpts });
  let note;
  if (started) note = `Started: ${job.total} sessions. Call summarize_sessions with status_only: true to see progress.`;
  else if (job?.status === 'running') note = `A batch is already running (${job.done + job.failed.length}/${job.total}); this call did not start another.`;
  else note = 'Nothing to summarise in this period; nothing was started. `job` is the most recent batch.';
  const left = job?.status === 'running' ? job.total - job.done - job.failed.length : 0;
  return { started, job, missing: ids.length, estimateSeconds: estimateFor(left), note, done };
}

async function runJob(jobId, ids, { harness, model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now }) {
  let done = 0;
  const failed = [];
  let stopError = null;
  let db;
  try {
    db = openDb();
  } catch (e) {
    // No connection to record it on; the row goes stale after STALE_MS.
    return { job_id: jobId, status: 'stopped', model, concurrency, total: ids.length, done, failed, ids, error: String(e?.message || e), alive: false };
  }
  let next = 0;
  // A missed heartbeat is not fatal; the next one (or the final write) catches up.
  const beat = () => {
    try {
      db.prepare('UPDATE summary_jobs SET done = ?, failed = ?, heartbeat_at = ? WHERE job_id = ?')
        .run(done, JSON.stringify(failed), new Date(now()).toISOString(), jobId);
    } catch { /* best effort */ }
  };
  const progress = (p) => { try { onProgress?.(p); } catch { /* a throwing callback must not affect the job */ } };
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  const worker = async () => {
    while (!stopError && next < ids.length) {
      const id = ids[next++];
      let err = null;
      try {
        await summarizeImpl(db, id, { harness, model });
      } catch (e) {
        err = e;
      }
      if (err) {
        failed.push({ id, kind: err?.kind || 'error', message: String(err?.message || err) });
        progress({ id, ok: false, error: err });
        // Without the CLI every remaining call fails the same way.
        if (err?.kind === 'cli-missing') stopError = String(err.message || `${harness} CLI not found`);
      } else {
        done++;
        progress({ id, ok: true });
      }
      beat();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  } catch (e) {
    stopError = stopError || String(e?.message || e);
  } finally {
    clearInterval(timer);
  }
  const t = new Date(now()).toISOString();
  const status = stopError ? 'stopped' : 'done';
  let job = { job_id: jobId, status, model, concurrency, total: ids.length, done, failed, ids, finished_at: t, error: stopError, alive: false };
  try {
    db.prepare('UPDATE summary_jobs SET status = ?, done = ?, failed = ?, heartbeat_at = ?, finished_at = ?, error = ? WHERE job_id = ?')
      .run(status, done, JSON.stringify(failed), t, t, stopError, jobId);
    job = readJob(db, jobId, now()) || job;
  } catch { /* best effort: the row goes stale and stops blocking */ }
  try { closeDb(db); } catch { /* ignore */ }
  return job;
}
