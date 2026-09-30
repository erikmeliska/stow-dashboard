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
import { openStore, getSessionsByIds } from './store.mjs';
import { summarizeSession } from './summary.mjs';
import { needsSummary, parseSummary } from './summary-view.mjs';
import { effectiveKind } from './session-link.mjs';

export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 3;

export function batchModel(env = process.env) {
  return env.CC_SUMMARY_BATCH_MODEL || 'claude-sonnet-5-5';
}

/**
 * Session ids a batch should summarise.
 * `ids`: exactly what the UI shows (it already applied kind/filters), so only
 * needsSummary is checked. Range (CLI/MCP): top-level rows started in
 * [since, until) whose effectiveKind is in `kinds`.
 */
export function selectMissing(db, { ids = null, since = null, until = null, force = false, kinds = ['work'], now = Date.now() } = {}) {
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
  return rows.filter((r) => needsSummary(r, { force, now })).map((r) => r.session_id);
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

export function estimateBatch(db, { count, concurrency = DEFAULT_CONCURRENCY, model = batchModel() } = {}) {
  const per = medianSummaryMs(db, model) ?? (/haiku/i.test(model) ? 10_000 : 30_000);
  return { count, model, seconds: Math.ceil(Math.ceil(count / Math.max(1, concurrency)) * per / 1000) };
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
 * The worker opens its own connection (`openDb`) so the caller may close `db`
 * as soon as this returns (an API route does).
 */
export function startBatch(db, {
  ids,
  model = batchModel(),
  concurrency = DEFAULT_CONCURRENCY,
  summarizeImpl = summarizeSession,
  openDb = () => openStore(),
  closeDb = (d) => d.close(),
  onProgress = null,
  now = Date.now,
} = {}) {
  const list = [...new Set(ids || [])];
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
      job_id: randomUUID(), status: list.length ? 'running' : 'done', model, concurrency,
      total: list.length, done: 0, failed: '[]', ids: JSON.stringify(list),
      started_at: t, heartbeat_at: t, finished_at: list.length ? null : t, error: null,
    };
    db.prepare(`INSERT INTO summary_jobs (job_id, status, model, concurrency, total, done, failed, ids, started_at, heartbeat_at, finished_at, error)
      VALUES (@job_id, @status, @model, @concurrency, @total, @done, @failed, @ids, @started_at, @heartbeat_at, @finished_at, @error)`).run(row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const job = readJob(db, row.job_id, now());
  if (!list.length) return { job, started: true, done: Promise.resolve(job) };
  const done = runJob(row.job_id, list, { model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now });
  return { job, started: true, done };
}

async function runJob(jobId, ids, { model, concurrency, summarizeImpl, openDb, closeDb, onProgress, now }) {
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
        await summarizeImpl(db, id, { model });
      } catch (e) {
        err = e;
      }
      if (err) {
        failed.push({ id, kind: err?.kind || 'error', message: String(err?.message || err) });
        progress({ id, ok: false, error: err });
        // Without the CLI every remaining call fails the same way.
        if (err?.kind === 'cli-missing') stopError = String(err.message || 'claude CLI not found');
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
