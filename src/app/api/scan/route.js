import path from 'path'
import fs from 'fs/promises'
import { ProjectScanner } from '@/scanner/index.mjs'
import { getScanRoots } from '@/lib/scan-roots.mjs'
import { updateUsage, defaultUsagePaths } from '@/lib/usage.mjs'

const SYNC_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

async function getExistingProjectCount() {
    try {
        const content = await fs.readFile(SYNC_FILE, 'utf-8')
        return content.trim().split('\n').filter(Boolean).length
    } catch {
        return 0
    }
}

export async function POST(request) {
    const body = await request.json().catch(() => ({}))
    const { force = false, cleanup = false } = body

    // Read per-request so a SCAN_ROOTS change from the Settings dialog applies
    // without restarting the (never-restarted) desktop server process.
    const SCAN_ROOTS = getScanRoots()

    // Create a readable stream for SSE
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        async start(controller) {
            const sendEvent = (data) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            }

            const startTime = Date.now()

            try {
                // Get existing project count for progress estimation
                const estimatedTotal = await getExistingProjectCount()
                let currentIndex = 0

                const scanner = new ProjectScanner({
                    scanRoots: SCAN_ROOTS,
                    syncFile: SYNC_FILE,
                    forceUpdate: force,
                    onProgress: (event) => {
                        if (event.type === 'updated' || event.type === 'existing') {
                            currentIndex++
                            sendEvent({ ...event, current: currentIndex, total: estimatedTotal })
                        } else {
                            sendEvent(event)
                        }
                    }
                })

                if (cleanup) {
                    sendEvent({ type: 'status', message: 'Cleaning up metadata files...' })
                    const deletedCount = await scanner.cleanupMetadataFiles()
                    const duration = Math.round((Date.now() - startTime) / 1000)
                    sendEvent({ type: 'complete', success: true, message: `Deleted ${deletedCount} metadata files`, duration })
                } else {
                    sendEvent({ type: 'status', message: 'Starting scan...', roots: SCAN_ROOTS, total: estimatedTotal })
                    const projects = await scanner.scanProjects()

                    sendEvent({ type: 'status', message: 'Syncing metadata...' })
                    await scanner.syncMetadata(projects)

                    // AI-usage ledger update (never fatal to the scan)
                    try {
                        const usage = await updateUsage({ ...defaultUsagePaths(), projectDirs: projects.map(p => p.directory).filter(Boolean) })
                        sendEvent({ type: 'usage_updated', ...usage })
                    } catch (usageErr) {
                        sendEvent({ type: 'usage_error', message: usageErr.message })
                    }

                    const duration = Math.round((Date.now() - startTime) / 1000)
                    sendEvent({ type: 'complete', success: true, projectCount: projects.length, duration })
                }
            } catch (error) {
                const duration = Math.round((Date.now() - startTime) / 1000)
                sendEvent({ type: 'error', message: error.message, duration })
            } finally {
                controller.close()
            }
        }
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    })
}

export async function GET() {
    return Response.json({
        message: 'Use POST to trigger a scan',
        options: {
            force: 'boolean - Force update all metadata',
            cleanup: 'boolean - Delete all metadata files instead of scanning'
        }
    })
}
