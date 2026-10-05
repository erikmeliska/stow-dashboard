import { openStore, listSessions, listSubagents, getSession } from '../../../lib/cc/store.mjs'
import { sessionProjectLabel } from '../../../lib/cc/session-project.mjs'
import { loadRegistry } from '../../../lib/registry/registry.mjs'
import { buildProjectIndex } from '../../../lib/cc/project-key.mjs'

/**
 * GET /api/sessions            → { sessions: row[], agents: row[] }   (?project=<dir>|?project_key=<id>
 *   &limit=<n>&since=<iso>&until=<iso> — top-level start in [since, until))
 *   `project` matches the main-checkout dir subtree (worktree sessions included),
 *   minus sub-dirs owned by another register project; `project_key` the register
 *   project id (#12). Rows carry `project_name`.
 *   `sessions` holds top-level rows (limit applies to those) plus every linked
 *   child of them (`parent_session_id`); `agents` the nested Agent-tool runs of
 *   all returned sessions. session-tree.mjs turns the pair into families.
 * GET /api/sessions?id=<sid>   → { session, tools, skills, guard_hits, agents, children, parent } | { session: null }
 *
 * Reads the cc session store (data/cc-sessions.db, written by `npm run cc:ingest`).
 * `handle()` is pure over an open db so it can be unit-tested without Next.
 */
export function handle(searchParams, db, { projectNames = new Map(), projectKeyOf = null } = {}) {
  const named = (s) => ({ ...s, project_name: (s.project_key && projectNames.get(s.project_key)) || sessionProjectLabel(s) })
  const id = searchParams.get('id')
  if (id) {
    const r = getSession(db, id)
    return r ? { ...r, session: named(r.session) } : { session: null }
  }
  const project = searchParams.get('project') || undefined
  const projectKey = searchParams.get('project_key') || undefined
  const since = searchParams.get('since') || null
  const until = searchParams.get('until') || null
  const ranged = Boolean(since || until)
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || (ranged ? 5000 : 200), 1), ranged ? 5000 : 1000)
  const projectDirKey = project && projectKeyOf ? projectKeyOf(project) : undefined
  const sessions = listSessions(db, { project, projectDirKey, projectKey, limit, since, until }).map(named)
  return { sessions, agents: listSubagents(db, sessions.map((s) => s.session_id)) }
}

export async function GET(request) {
  // Opened per request (not at module eval): the desktop app preloads route
  // modules at boot, before the state dir is final — see state-dir.mjs.
  const db = openStore()
  try {
    const { searchParams } = new URL(request.url)
    let register = null
    try { register = await loadRegistry() } catch { /* no/malformed register: basename labels, whole-subtree ?project= */ }
    const projectNames = new Map((register?.projects || []).filter((p) => p.key && p.name).map((p) => [p.key, p.name]))
    const projectKeyOf = register ? buildProjectIndex({ register }).lookup : null
    return Response.json(handle(searchParams, db, { projectNames, projectKeyOf }))
  } finally {
    db.close()
  }
}
