import { updateUsage, defaultUsagePaths } from '@/lib/usage.mjs'
import { readProjectsData } from '@/lib/projects'

// Full re-parse of every transcript (rebuild: true). Idempotent, so no guard —
// plain JSON in/out, unlike the SSE scan routes.
export async function POST() {
    try {
        const projects = await readProjectsData()
        const projectDirs = projects.map(p => p.directory).filter(Boolean)
        const counters = await updateUsage({ ...defaultUsagePaths(), projectDirs, rebuild: true })
        return Response.json(counters)
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}

export async function GET() {
    return Response.json({
        message: 'POST to rebuild the AI-usage ledger from all transcripts',
        method: 'POST'
    })
}
