import { exec } from 'child_process'
import { promisify } from 'util'
import { readOpenWithEnv, isAllowedApp } from '@/lib/open-with.mjs'
import { envFile } from '@/lib/state-dir.mjs'

const execAsync = promisify(exec)

export async function GET() {
    const config = await readOpenWithEnv(envFile())
    return Response.json(config)
}

export async function POST(request) {
    const { directory, action, app } = await request.json()

    if (!directory) {
        return Response.json({ error: 'Directory is required' }, { status: 400 })
    }

    const config = await readOpenWithEnv(envFile())

    try {
        switch (action) {
            case 'vscode': {
                const cmd = app ?? config.ide[0]
                if (!isAllowedApp(cmd, config.ide)) {
                    return Response.json({ error: `IDE not configured: ${cmd}` }, { status: 400 })
                }
                // -n flag opens in new window (works for code, cursor, zed, etc.)
                await execAsync(`${cmd} -n "${directory}"`)
                break
            }
            case 'finder':
                await execAsync(`open "${directory}"`)
                break
            case 'terminal': {
                const term = app ?? config.terminal[0]
                if (!isAllowedApp(term, config.terminal)) {
                    return Response.json({ error: `Terminal not configured: ${term}` }, { status: 400 })
                }
                await execAsync(`open -a "${term}" "${directory}"`)
                break
            }
            default:
                return Response.json({ error: 'Unknown action' }, { status: 400 })
        }

        return Response.json({ success: true })
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}
