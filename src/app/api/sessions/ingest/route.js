import { runIngest } from '@/lib/cc/ingest-run.mjs'

/**
 * POST /api/sessions/ingest  [{ full?: boolean }]
 * Brings data/cc-sessions.db up to date from ~/.claude transcripts (incremental,
 * ~0.1 s when nothing changed). Concurrent calls share one run.
 */
export async function POST(request) {
  let full = false
  try { full = Boolean((await request.json())?.full) } catch { /* no body */ }
  try {
    return Response.json(await runIngest({ full }))
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 })
  }
}
