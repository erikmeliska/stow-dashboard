import { openStore, listSessions, listSubagents, getSession } from '../../../lib/cc/store.mjs'

/**
 * GET /api/sessions            → { sessions: row[], agents: row[] }   (?project=<dir>&limit=<n>)
 *   `sessions` holds top-level rows (limit applies to those) plus every linked
 *   child of them (`parent_session_id`); `agents` the nested Agent-tool runs of
 *   all returned sessions. session-tree.mjs turns the pair into families.
 * GET /api/sessions?id=<sid>   → { session, tools, skills, guard_hits, agents, children, parent } | { session: null }
 *
 * Reads the cc session store (data/cc-sessions.db, written by `npm run cc:ingest`).
 * `handle()` is pure over an open db so it can be unit-tested without Next.
 */
export function handle(searchParams, db) {
  const id = searchParams.get('id')
  if (id) return getSession(db, id) || { session: null }
  const project = searchParams.get('project') || undefined
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 200, 1), 1000)
  const sessions = listSessions(db, { project, limit })
  return { sessions, agents: listSubagents(db, sessions.map((s) => s.session_id)) }
}

export async function GET(request) {
  // Opened per request (not at module eval): the desktop app preloads route
  // modules at boot, before the state dir is final — see state-dir.mjs.
  const db = openStore()
  try {
    const { searchParams } = new URL(request.url)
    return Response.json(handle(searchParams, db))
  } finally {
    db.close()
  }
}
