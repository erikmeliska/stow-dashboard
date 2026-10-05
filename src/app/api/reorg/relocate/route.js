import { relocate } from '@/lib/reorg-service.mjs'
import { guardRequest } from '@/lib/request-guard.mjs'

/**
 * POST /api/reorg/relocate
 *   { from, to, dryRun: true }            → the plan (blockers, warnings, steps, planHash)
 *   { from, to, planHash, force? }        → runs it; refused unless planHash matches a fresh re-plan
 * The physical move is the exception to the report's virtual actions (#11).
 */
export async function POST(request) {
    const refused = guardRequest(request.headers)
    if (refused) return Response.json({ error: refused }, { status: 403 })
    let body = {}
    try { body = await request.json() } catch { /* no body */ }
    try {
        return Response.json(await relocate({
            from: body?.from, to: body?.to, dryRun: body?.dryRun === true,
            planHash: body?.planHash, force: body?.force === true,
        }))
    } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: e?.status ?? 500 })
    }
}
