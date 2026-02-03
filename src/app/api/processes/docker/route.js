import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function POST(request) {
    const { action, ids } = await request.json()

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return Response.json({ error: 'Container IDs array is required' }, { status: 400 })
    }

    const results = []

    for (const id of ids) {
        try {
            switch (action) {
                case 'stop':
                    await execAsync(`docker stop ${id}`, { timeout: 30000 })
                    results.push({ id, success: true, action: 'stopped' })
                    break
                case 'restart':
                    await execAsync(`docker restart ${id}`, { timeout: 30000 })
                    results.push({ id, success: true, action: 'restarted' })
                    break
                case 'kill':
                    await execAsync(`docker kill ${id}`, { timeout: 10000 })
                    results.push({ id, success: true, action: 'killed' })
                    break
                default:
                    results.push({ id, success: false, error: `Unknown action: ${action}` })
            }
        } catch (error) {
            results.push({ id, success: false, error: error.message })
        }
    }

    return Response.json({
        results,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
    })
}
