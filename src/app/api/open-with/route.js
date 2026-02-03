import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Configurable via .env.local
const TERMINAL_APP = process.env.TERMINAL_APP || 'Terminal'
const IDE_COMMAND = process.env.IDE_COMMAND || 'code'

export async function POST(request) {
    const { directory, action } = await request.json()

    if (!directory) {
        return Response.json({ error: 'Directory is required' }, { status: 400 })
    }

    try {
        switch (action) {
            case 'vscode':
                // -n flag opens in new window (works for code, cursor, etc.)
                await execAsync(`${IDE_COMMAND} -n "${directory}"`)
                break
            case 'finder':
                await execAsync(`open "${directory}"`)
                break
            case 'terminal':
                await execAsync(`open -a "${TERMINAL_APP}" "${directory}"`)
                break
            default:
                return Response.json({ error: 'Unknown action' }, { status: 400 })
        }

        return Response.json({ success: true })
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}
