import { openStore } from '../../../../lib/cc/store.mjs'
import { summarizeSession, SummaryError } from '../../../../lib/cc/summary.mjs'

/**
 * POST /api/sessions/summarize  { id }  → fresh { session, tools, skills, guard_hits }
 * Runs the local `claude` CLI (see src/lib/cc/summary.mjs); errors map to
 * 404 not-found, 503 cli-missing, 502 cli-failed / bad-json.
 */
const STATUS = { 'not-found': 404, 'cli-missing': 503, 'cli-failed': 502, 'bad-json': 502 }

export async function POST(request) {
  let id = null
  try { id = (await request.json())?.id } catch { /* no body */ }
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const db = openStore()
  try {
    return Response.json(await summarizeSession(db, id))
  } catch (e) {
    if (e instanceof SummaryError) return Response.json({ error: e.message, kind: e.kind, detail: e.detail }, { status: STATUS[e.kind] || 500 })
    return Response.json({ error: String(e?.message || e) }, { status: 500 })
  } finally {
    db.close()
  }
}
