import { openStore } from '../../../../../lib/cc/store.mjs'
import { estimateBatch, readJob, selectMissing } from '../../../../../lib/cc/summary-batch.mjs'

/**
 * POST /api/sessions/summarize-batch/estimate { ids } → { missing, ids, estimateSeconds, model, job }
 * `ids` are the sessions the calendar currently shows; the answer is exactly
 * what a POST to ../summarize-batch with the same ids would summarise.
 */
export function handleEstimate(body, db, now = Date.now()) {
  const ids = selectMissing(db, { ids: (Array.isArray(body?.ids) ? body.ids : []).map(String), now })
  const e = estimateBatch(db, { count: ids.length })
  return { missing: ids.length, ids, estimateSeconds: e.seconds, model: e.model, job: readJob(db, null, now) }
}

export async function POST(request) {
  let body = null
  try { body = await request.json() } catch { /* no body */ }
  const db = openStore()
  try {
    return Response.json(handleEstimate(body, db))
  } finally {
    db.close()
  }
}
