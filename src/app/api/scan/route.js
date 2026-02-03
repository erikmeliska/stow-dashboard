import path from 'path'
import { ProjectScanner } from '@/scanner/index.mjs'

const SCAN_ROOTS = (process.env.SCAN_ROOTS || '/Users/ericsko/Projekty').split(',').map(s => s.trim())
const SYNC_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

export async function POST(request) {
    const body = await request.json().catch(() => ({}))
    const { force = false, cleanup = false } = body

    // Create a readable stream for SSE
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        async start(controller) {
            const sendEvent = (data) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            }

            try {
                const scanner = new ProjectScanner({
                    scanRoots: SCAN_ROOTS,
                    syncFile: SYNC_FILE,
                    forceUpdate: force,
                    onProgress: (event) => {
                        sendEvent(event)
                    }
                })

                if (cleanup) {
                    sendEvent({ type: 'status', message: 'Cleaning up metadata files...' })
                    const deletedCount = await scanner.cleanupMetadataFiles()
                    sendEvent({ type: 'complete', success: true, message: `Deleted ${deletedCount} metadata files` })
                } else {
                    sendEvent({ type: 'status', message: 'Starting scan...', roots: SCAN_ROOTS })
                    const projects = await scanner.scanProjects()

                    sendEvent({ type: 'status', message: 'Syncing metadata...' })
                    await scanner.syncMetadata(projects)

                    sendEvent({ type: 'complete', success: true, projectCount: projects.length })
                }
            } catch (error) {
                sendEvent({ type: 'error', message: error.message })
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
