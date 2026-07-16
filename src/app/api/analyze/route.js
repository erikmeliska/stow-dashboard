import { runAnalysisBatch, isAnalysisRunning } from '@/lib/analyze-batch.mjs'
import { readProjectsData } from '@/lib/projects'
import { getBaseDir } from '@/lib/scan-roots.mjs'
import { ledgerFile } from '@/lib/state-dir.mjs'

export async function POST(request) {
  const body = await request.json().catch(() => ({}))
  const { force = false, project = null } = body

  if (isAnalysisRunning()) {
    return Response.json({ error: 'analysis already running' }, { status: 409 })
  }

  let only = null
  if (project) {
    const rec = (await readProjectsData()).find(p => p.id === project)
    if (!rec) {
      return Response.json({ error: `unknown project id: ${project}` }, { status: 400 })
    }
    only = [rec.directory]
  }

  // Fire-and-forget: the batch maintains its own status snapshot
  // (getAnalysisStatus / GET /api/analyze/status), so we start it without
  // awaiting and let the client poll for progress.
  runAnalysisBatch({
    dataFile: ledgerFile(),
    baseDir: getBaseDir(),
    force: force || Boolean(project),
    only,
  }).catch(err => console.error('[analyze]', err))

  return Response.json({ started: true }, { status: 202 })
}
