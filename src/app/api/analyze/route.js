import path from 'path'
import { runAnalysisBatch, isAnalysisRunning } from '@/lib/analyze-batch.mjs'
import { ApfelError } from '@/lib/analyzer.mjs'
import { readProjectsData } from '@/lib/projects'
import { getBaseDir } from '@/lib/scan-roots.mjs'

const DATA_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

export async function POST(request) {
  const body = await request.json().catch(() => ({}))
  const { force = false, project = null } = body

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      const started = Date.now()
      try {
        if (isAnalysisRunning()) {
          send({ type: 'error', message: 'analysis already running' })
          return
        }
        let only = null
        if (project) {
          const rec = (await readProjectsData()).find(p => p.id === project)
          if (!rec) {
            send({ type: 'error', message: `unknown project id: ${project}` })
            return
          }
          only = [rec.directory]
        }
        send({ type: 'status', message: project ? 'Re-analyzing project…' : 'Starting AI analysis…' })
        const summary = await runAnalysisBatch({
          dataFile: DATA_FILE, baseDir: getBaseDir(),
          force: force || Boolean(project), only,
          onProgress: send,
        })
        send({ type: 'complete', success: true, ...summary, duration: Date.now() - started })
      } catch (err) {
        const message = err instanceof ApfelError && err.kind === 'unavailable'
          ? 'Apple model unavailable — is apfel installed and Apple Intelligence enabled?'
          : err.message
        send({ type: 'error', message, duration: Date.now() - started })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
