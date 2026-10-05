import { openStore } from '../../../../lib/cc/store.mjs'
import { summarizeSession, SummaryError } from '../../../../lib/cc/summary.mjs'
import { annotateDetail } from '../../../../lib/cc/session-projects.mjs'
import { loadProjectIndex } from '../../../../lib/cc/project-index.mjs'

/**
 * POST /api/sessions/summarize  { id }  → fresh { session, tools, skills, guard_hits }, rows annotated
 *   with client/project like GET /api/sessions (#13), so the detail panel keeps its client.
 * Runs the local `claude` or `codex` CLI per CC_SUMMARY_HARNESS (see src/lib/cc/summary.mjs); errors map to
 * 404 not-found, 503 cli-missing / cli-auth, 502 cli-failed / bad-json.
 */
const STATUS = { 'not-found': 404, 'cli-missing': 503, 'cli-auth': 503, 'cli-failed': 502, 'bad-json': 502 }

export async function POST(request) {
  let id = null
  try { id = (await request.json())?.id } catch { /* no body */ }
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const { index } = await loadProjectIndex({ base: process.cwd() })
  const db = openStore()
  try {
    return Response.json(annotateDetail(await summarizeSession(db, id), index))
  } catch (e) {
    if (e instanceof SummaryError) return Response.json({ error: e.message, kind: e.kind, detail: e.detail }, { status: STATUS[e.kind] || 500 })
    return Response.json({ error: String(e?.message || e) }, { status: 500 })
  } finally {
    db.close()
  }
}
