import { applySuggestion } from '@/lib/reorg-service.mjs'
import { guardRequest } from '@/lib/request-guard.mjs'

/**
 * POST /api/reorg/apply { id, running? }
 * Runs the suggestion's own virtual action (register only, nothing moves on
 * disk) and returns the refreshed report. Unknown/stale id → 409.
 */
export async function POST(request) {
    const refused = guardRequest(request.headers)
    if (refused) return Response.json({ error: refused }, { status: 403 })
    let body = {}
    try { body = await request.json() } catch { /* no body */ }
    if (typeof body?.id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 })
    try {
        const runningDirs = Array.isArray(body.running) ? body.running.filter(d => typeof d === 'string') : []
        return Response.json(await applySuggestion({ id: body.id, runningDirs }))
    } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: e?.status ?? 500 })
    }
}
