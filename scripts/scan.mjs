#!/usr/bin/env node

import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load .env.local (silent)
config({ path: path.join(__dirname, '..', '.env.local'), debug: false })

// Dynamic import of the scanner
const { ProjectScanner } = await import('../src/scanner/index.mjs')

// Get scan roots from env
const ENV_SCAN_ROOTS = (process.env.SCAN_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean)

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2)
    const options = {
        roots: [],
        ignore: [],
        sync: null,
        force: false,
        cleanup: false,
        help: false
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '--help' || arg === '-h') {
            options.help = true
        } else if (arg === '--root' || arg === '-r') {
            // Collect all roots until next flag
            while (args[i + 1] && !args[i + 1].startsWith('-')) {
                options.roots.push(args[++i])
            }
        } else if (arg === '--ignore' || arg === '-i') {
            while (args[i + 1] && !args[i + 1].startsWith('-')) {
                options.ignore.push(args[++i])
            }
        } else if (arg === '--sync' || arg === '-s') {
            options.sync = args[++i] || path.join(__dirname, '..', 'data', 'projects_metadata.jsonl')
        } else if (arg === '--force' || arg === '-f') {
            options.force = true
        } else if (arg === '--cleanup') {
            options.cleanup = true
        }
    }

    return options
}

function printHelp() {
    console.log(`
Stow Dashboard Project Scanner

Usage: node scripts/scan.mjs [options]

Options:
  -r, --root <path...>   Root directories to scan (defaults to SCAN_ROOTS env)
  -i, --ignore <pattern...>  Additional patterns to ignore
  -s, --sync [path]      Sync all metadata to JSONL file
  -f, --force            Force update all metadata
  --cleanup              Delete all .project_meta.json files
  -h, --help             Show this help message

Environment:
  SCAN_ROOTS    Comma-separated list of directories to scan (in .env.local)

Examples:
  node scripts/scan.mjs -s data/projects_metadata.jsonl
  node scripts/scan.mjs -r ~/Projekty ~/Work -s
  node scripts/scan.mjs -f -s
  node scripts/scan.mjs --cleanup
`)
}

async function main() {
    const options = parseArgs()

    if (options.help) {
        printHelp()
        process.exit(0)
    }

    if (options.roots.length === 0) {
        // Use env roots or default
        options.roots = ENV_SCAN_ROOTS.length > 0 ? ENV_SCAN_ROOTS : ['/Users/ericsko/Projekty']
    }

    // Default sync file if --sync is used without path
    if (options.sync === undefined && process.argv.includes('--sync') || process.argv.includes('-s')) {
        options.sync = path.join(__dirname, '..', 'data', 'projects_metadata.jsonl')
    }

    console.log('Starting scan...')
    console.log(`Roots: ${options.roots.join(', ')}`)
    if (options.force) console.log('Force update: enabled')
    if (options.sync) console.log(`Sync file: ${options.sync}`)

    const scanner = new ProjectScanner({
        scanRoots: options.roots,
        ignorePatterns: options.ignore.length > 0 ? undefined : undefined,
        syncFile: options.sync,
        forceUpdate: options.force,
        onProgress: (event) => {
            if (event.type === 'updated') {
                console.log(`Updated: ${event.directory} (${event.processingTime}s)`)
            } else if (event.type === 'existing') {
                console.log(`Existing: ${event.directory} (${event.processingTime}s)`)
            } else if (event.type === 'error') {
                console.error(`Error: ${event.directory} - ${event.error}`)
            } else if (event.type === 'complete') {
                console.log(`\nTotal: ${event.count} projects in ${event.totalTime}s`)
            } else if (event.type === 'synced') {
                console.log(`Synced to: ${event.file}`)
            } else if (event.type === 'deleted') {
                console.log(`Deleted: ${event.file}`)
            }
        }
    })

    // Add custom ignore patterns
    if (options.ignore.length > 0) {
        scanner.ignorePatterns.push(...options.ignore)
    }

    if (options.cleanup) {
        const deletedCount = await scanner.cleanupMetadataFiles()
        console.log(`\nDeleted ${deletedCount} metadata files`)
        return
    }

    const projects = await scanner.scanProjects()

    if (options.sync) {
        await scanner.syncMetadata(projects)
    }
}

main().catch(error => {
    console.error('Error:', error)
    process.exit(1)
})
