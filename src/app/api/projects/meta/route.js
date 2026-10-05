import { validateMetaPatch } from '../../../../lib/virtual-projects.mjs'
import { setProjectClient, setLocationRole } from '../../../../lib/project-meta-write.mjs'
import { guardRequest } from '../../../../lib/reorg-service.mjs'

/**
 * PATCH /api/projects/meta — manual client / role / primary from the
 * projects page (#10). Body: `{projectId, client}` (null = automatic) or
 * `{directory, role}`. 200 `{ok}`, 400/500 `{error}`; 403 `{error}` unless the
 * request is same-origin JSON on a loopback host (`guardRequest`, CSRF).
 */
export async function handleMetaPatch(body, deps) {
  const v = validateMetaPatch(body)
  if (!v.ok) return { status: 400, json: { error: v.error } }
  try {
    if (v.op.kind === 'client') await deps.setProjectClient({ projectId: v.op.projectId, client: v.op.client })
    else await deps.setLocationRole({ directory: v.op.directory, role: v.op.role })
    return { status: 200, json: { ok: true } }
  } catch (err) {
    return { status: 500, json: { error: err?.message || String(err) } }
  }
}

export async function PATCH(request) {
  const refused = guardRequest(request.headers)
  if (refused) return Response.json({ error: refused }, { status: 403 })
  let body
  try { body = await request.json() } catch { body = null }
  const { status, json } = await handleMetaPatch(body, { setProjectClient, setLocationRole })
  return Response.json(json, { status })
}
