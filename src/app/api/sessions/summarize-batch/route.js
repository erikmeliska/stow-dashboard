import { openStore } from '../../../../lib/cc/store.mjs'
import { batchModel, clampConcurrency, estimateBatch, readJob, selectMissing, startBatch } from '../../../../lib/cc/summary-batch.mjs'

/**
 * GET  /api/sessions/summarize-batch                    → { job }   (latest job, any status; `alive` + `status: 'stale'` for a dead runner)
 * GET  /api/sessions/summarize-batch?since=&until=      → { job, missing, estimateSeconds, model }   (CLI/MCP-style range)
 * POST /api/sessions/summarize-batch { ids } | { since, until } (+ force, model, concurrency 1..8)
 *                                                       → { job, started, total }; a live job is returned with started=false
 * The job runs in this server process and keeps its state in summary_jobs
 * (see src/lib/cc/summary-batch.mjs), so a job started by the MCP server shows up here too.
 */
export function handleGet(searchParams, db, now = Date.now()) {
  const out = { job: readJob(db, null, now) }
  const since = searchParams.get('since')
  const until = searchParams.get('until')
  if (since || until) {
    const ids = selectMissing(db, { since, until, now })
    const e = estimateBatch(db, { count: ids.length })
    Object.assign(out, { missing: ids.length, estimateSeconds: e.seconds, model: e.model })
  }
  return out
}

export function handlePost(body, db, deps = {}) {
  const now = deps.now || Date.now
  const force = body?.force ?? false
  let ids
  if (Array.isArray(body?.ids)) ids = selectMissing(db, { ids: body.ids.map(String), force, now: now() })
  else if (body?.since || body?.until) ids = selectMissing(db, { since: body.since ?? null, until: body.until ?? null, force, now: now() })
  else throw Object.assign(new Error('ids or since/until required'), { status: 400 })
  const { job, started } = startBatch(db, {
    ids,
    model: body?.model || batchModel(),
    concurrency: clampConcurrency(body?.concurrency),
    ...deps,
  })
  return { job, started, total: job.total }
}

export async function GET(request) {
  const db = openStore()
  try {
    return Response.json(handleGet(new URL(request.url).searchParams, db))
  } finally {
    db.close()
  }
}

export async function POST(request) {
  let body = null
  try { body = await request.json() } catch { /* no body */ }
  const db = openStore()
  try {
    return Response.json(handlePost(body, db))
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: e?.status || 500 })
  } finally {
    db.close()
  }
}
