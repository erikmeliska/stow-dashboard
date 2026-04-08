import { spawn } from 'child_process'
import { open as fsOpen, mkdir } from 'fs/promises'
import path from 'path'
import os from 'os'

const LOG_DIR = path.join(os.tmpdir(), 'stow-dashboard-logs')

export async function POST(request) {
    const { directory, script } = await request.json()

    if (!directory || !script) {
        return Response.json({ error: 'Directory and script are required' }, { status: 400 })
    }

    try {
        await mkdir(LOG_DIR, { recursive: true })

        const timestamp = Date.now()
        const logFile = path.join(LOG_DIR, `${script.replace(/[^a-zA-Z0-9-_]/g, '_')}-${timestamp}.log`)
        const fd = await fsOpen(logFile, 'w')

        const isShellScript = script.endsWith('.sh')
        const cmd = isShellScript ? 'bash' : 'npm'
        const args = isShellScript ? [`./${script}`] : ['run', script]

        const child = spawn(cmd, args, {
            cwd: directory,
            detached: true,
            stdio: ['ignore', fd.fd, fd.fd],
            env: { ...process.env, FORCE_COLOR: '1' }
        })

        child.unref()

        // Close our reference to the file descriptor (child keeps its own)
        // Wait a moment to ensure the fd is inherited before closing
        child.once('spawn', () => {
            fd.close().catch(() => {})
        })

        // If spawn fails immediately, clean up
        child.once('error', () => {
            fd.close().catch(() => {})
        })

        return Response.json({
            success: true,
            pid: child.pid,
            logFile,
            script
        })
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 })
    }
}
