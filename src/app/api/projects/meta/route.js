import { validateMetaPatch } from '../../../../lib/virtual-projects.mjs'
import { setProjectClient, setLocationRole } from '../../../../lib/project-meta-write.mjs'
import { guardRequest } from '../../../../lib/request-guard.mjs'

/**
 * PATCH /api/projects/meta — manual client / role / primary from the
 * projects page (#10). Body: `{projectId, client}` (null = automatic) or
 * `{directory, role}`. 200 `{ok}`, 400 bad body or a projectId / directory the
 * register doesn't know, 403 not same-origin JSON on loopback, 409 checkout
 * gone from disk, 500 `{error}`.
 */
export async function handleMetaPatch(body, deps) {
  const v = validateMetaPatch(body)
  if (!v.ok) return { status: 400, json: { error: v.error } }
  try {
    if (v.op.kind === 'client') await deps.setProjectClient({ projectId: v.op.projectId, client: v.op.client })
    else await deps.setLocationRole({ directory: v.op.directory, role: v.op.role })
    return { status: 200, json: { ok: true } }
  } catch (err) {
    return { status: err?.status ?? 500, json: { error: err?.message || String(err) } }
  }
}

/** The whole request: guard before the body is read, then `handleMetaPatch`. */
export async function handleMetaRequest(request, deps) {
  const refused = guardRequest(request.headers)
  if (refused) return { status: 403, json: { error: refused } }
  let body
  try { body = await request.json() } catch { body = null }
  return handleMetaPatch(body, deps)
}

export async function PATCH(request) {
  const { status, json } = await handleMetaRequest(request, { setProjectClient, setLocationRole })
  return Response.json(json, { status })
}
