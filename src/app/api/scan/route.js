import { NextResponse } from 'next/server'
import path from 'path'
import { ProjectScanner } from '@/scanner/index.mjs'

// Configuration - can be moved to environment variables
const SCAN_ROOTS = ['/Users/ericsko/Projekty']
const SYNC_FILE = path.join(process.cwd(), 'data', 'projects_metadata.jsonl')

export async function POST(request) {
    try {
        const body = await request.json().catch(() => ({}))
        const { force = false, cleanup = false } = body

        const logs = []
        const scanner = new ProjectScanner({
            scanRoots: SCAN_ROOTS,
            syncFile: SYNC_FILE,
            forceUpdate: force,
            onProgress: (event) => {
                logs.push(event)
                console.log(JSON.stringify(event))
            }
        })

        if (cleanup) {
            const deletedCount = await scanner.cleanupMetadataFiles()
            return NextResponse.json({
                success: true,
                message: `Deleted ${deletedCount} metadata files`,
                logs
            })
        }

        const projects = await scanner.scanProjects()
        await scanner.syncMetadata(projects)

        return NextResponse.json({
            success: true,
            message: `Scanned ${projects.length} projects`,
            projectCount: projects.length,
            logs
        })
    } catch (error) {
        console.error('Scan error:', error)
        return NextResponse.json({
            success: false,
            error: error.message
        }, { status: 500 })
    }
}

export async function GET() {
    return NextResponse.json({
        message: 'Use POST to trigger a scan',
        options: {
            force: 'boolean - Force update all metadata',
            cleanup: 'boolean - Delete all metadata files instead of scanning'
        }
    })
}
