import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const TERMINAL_APP = process.env.TERMINAL_APP || 'Terminal'

async function findProcessOutput(pid) {
    try {
        // Check stdout (fd 1) and stderr (fd 2) for the process
        const { stdout } = await execAsync(`lsof -p ${pid} -a -d 1,2 -Ftfn 2>/dev/null`)
        const lines = stdout.trim().split('\n')

        const files = new Set()
        let currentType = ''

        for (const line of lines) {
            if (line.startsWith('t')) currentType = line.slice(1)
            if (line.startsWith('n') && currentType === 'REG') {
                const path = line.slice(1)
                if (path && !path.startsWith('/dev/')) {
                    files.add(path)
                }
            }
        }

        if (files.size > 0) return [...files]
    } catch {
        // ignore
    }
    return null
}

function openInTerminal(cmd) {
    const terminalLower = TERMINAL_APP.toLowerCase()
    const escaped = cmd.replace(/"/g, '\\"')

    if (terminalLower === 'terminal' || terminalLower === 'terminal.app') {
        return execAsync(`osascript -e 'tell application "Terminal"
            activate
            do script "${escaped}"
        end tell'`)
    } else if (terminalLower === 'iterm' || terminalLower.includes('iterm')) {
        return execAsync(`osascript -e 'tell application "iTerm2"
            activate
            tell current window
                create tab with default profile
                tell current session
                    write text "${escaped}"
                end tell
            end tell
        end tell'`)
    } else {
        // Warp and others — write command to a temp script and execute
        return execAsync(`osascript -e 'tell application "${TERMINAL_APP}" to activate'`)
    }
}

export async function POST(request) {
    const { pid, logFile, directory } = await request.json()

    if (!pid) {
        return Response.json({ error: 'PID is required' }, { status: 400 })
    }

    try {
        let tailTarget = logFile

        // If no explicit log file, try to discover where stdout/stderr goes
        if (!tailTarget) {
            const outputFiles = await findProcessOutput(pid)
            if (outputFiles) {
                tailTarget = outputFiles[0]
            }
        }

        const cmd = tailTarget
            ? `echo "Attached to PID ${pid} — Ctrl+C to detach (process keeps running)" && echo "Log: ${tailTarget}" && echo "---" && tail -f "${tailTarget}"`
            : `echo "Process PID: ${pid}" && cd "${directory || '/tmp'}" && $SHELL`

        await openInTerminal(cmd)

        return Response.json({ success: true, tailTarget })
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}
