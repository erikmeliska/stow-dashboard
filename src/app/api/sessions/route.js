import { openStore, listSessions, listSubagents, getSession } from '../../../lib/cc/store.mjs'
import { annotateSessions } from '../../../lib/cc/session-projects.mjs'
import { loadProjectIndex } from '../../../lib/cc/project-index.mjs'

/**
 * GET /api/sessions            → { sessions: row[], agents: row[] }   (?project=<dir>|?project_key=<id>
 *   &limit=<n>&since=<iso>&until=<iso> — top-level start in [since, until))
 *   `project` matches the main-checkout dir subtree (worktree sessions included),
 *   minus sub-dirs owned by another register project; `project_key` the register
 *   project id (#12). Rows carry `project_name`, `client_id` (null = unassigned) and
 *   `client_name`, joined from the register at read time (#13).
 *   `sessions` holds top-level rows (limit applies to those) plus every linked
 *   child of them (`parent_session_id`); `agents` the nested Agent-tool runs of
 *   all returned sessions. session-tree.mjs turns the pair into families.
 * GET /api/sessions?id=<sid>   → { session, tools, skills, guard_hits, agents, children, parent } | { session: null }
 *
 * Reads the cc session store (data/cc-sessions.db, written by `npm run cc:ingest`).
 * `handle()` is pure over an open db so it can be unit-tested without Next.
 */
export function handle(searchParams, db, { index = null, projectNames = new Map(), projectKeyOf = null } = {}) {
  // `index` is session-projects.mjs's projectIndex; bare `projectNames` (key → name) still works, unassigned.
  const idx = index || new Map([...projectNames].map(([k, n]) => [k, { project_key: k, project_name: n, client_id: null, client_name: null }]))
  const named = (rows) => annotateSessions(rows, idx)
  const id = searchParams.get('id')
  if (id) {
    const r = getSession(db, id)
    if (!r) return { session: null }
    return { ...r, session: named([r.session])[0], children: named(r.children || []), parent: r.parent ? named([r.parent])[0] : r.parent }
  }
  const project = searchParams.get('project') || undefined
  const projectKey = searchParams.get('project_key') || undefined
  const since = searchParams.get('since') || null
  const until = searchParams.get('until') || null
  const ranged = Boolean(since || until)
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || (ranged ? 5000 : 200), 1), ranged ? 5000 : 1000)
  const projectDirKey = project && projectKeyOf ? projectKeyOf(project) : undefined
  const sessions = named(listSessions(db, { project, projectDirKey, projectKey, limit, since, until }))
  return { sessions, agents: listSubagents(db, sessions.map((s) => s.session_id)) }
}

export async function GET(request) {
  // Opened per request (not at module eval): the desktop app preloads route
  // modules at boot, before the state dir is final — see state-dir.mjs.
  const db = openStore()
  try {
    const { searchParams } = new URL(request.url)
    // Memoised, fail-soft: no/malformed register → basename labels, Unassigned, whole-subtree ?project=.
    const { index, projectKeyOf } = await loadProjectIndex({ base: process.cwd() })
    return Response.json(handle(searchParams, db, { index, projectKeyOf }))
  } finally {
    db.close()
  }
}
