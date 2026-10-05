import { getReport } from '@/lib/reorg-service.mjs'

/**
 * GET /api/reorg?running=<JSON array of dirs>&includeDismissed=1
 * The Reorg report over the virtual-project register (#11). `running` comes
 * from the client, which already holds the process state.
 */
export async function GET(request) {
    const { searchParams } = new URL(request.url)
    let runningDirs = []
    try { runningDirs = JSON.parse(searchParams.get('running') || '[]') } catch { /* ignore */ }
    if (!Array.isArray(runningDirs)) runningDirs = []
    try {
        return Response.json(await getReport({
            runningDirs: runningDirs.filter(d => typeof d === 'string'),
            includeDismissed: searchParams.get('includeDismissed') === '1',
        }))
    } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: e?.status ?? 500 })
    }
}
