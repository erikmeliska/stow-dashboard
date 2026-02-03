import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function POST(request) {
    const { pids } = await request.json()

    if (!pids || !Array.isArray(pids) || pids.length === 0) {
        return Response.json({ error: 'PIDs array is required' }, { status: 400 })
    }

    const results = []

    for (const pid of pids) {
        try {
            // First try graceful kill (SIGTERM)
            await execAsync(`kill ${pid}`)
            results.push({ pid, success: true })
        } catch (error) {
            // Process might already be dead or we don't have permission
            results.push({ pid, success: false, error: error.message })
        }
    }

    return Response.json({
        results,
        killed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
    })
}
