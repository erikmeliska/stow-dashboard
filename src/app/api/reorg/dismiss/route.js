import { dismissSuggestion } from '@/lib/reorg-service.mjs'
import { guardRequest } from '@/lib/request-guard.mjs'

async function handle(request, undo) {
    const refused = guardRequest(request.headers)
    if (refused) return Response.json({ error: refused }, { status: 403 })
    let body = {}
    try { body = await request.json() } catch { /* no body */ }
    if (typeof body?.id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 })
    try {
        const runningDirs = Array.isArray(body.running) ? body.running.filter(d => typeof d === 'string') : []
        return Response.json(await dismissSuggestion({ id: body.id, undo, runningDirs }))
    } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: e?.status ?? 500 })
    }
}

/** POST /api/reorg/dismiss { id } — hide until the suggestion's evidence changes. */
export async function POST(request) { return handle(request, false) }

/** DELETE /api/reorg/dismiss { id } — undo a dismissal. */
export async function DELETE(request) { return handle(request, true) }
