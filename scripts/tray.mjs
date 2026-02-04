#!/usr/bin/env node

/**
 * Stow Dashboard Launcher
 *
 * Starts the dashboard server on a custom port (default: 3088)
 * and optionally opens the browser.
 *
 * Usage:
 *   npm run tray              # Start on port 3088
 *   STOW_PORT=4000 npm run tray  # Custom port
 *   npm run tray -- --no-open # Don't open browser
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const PORT = process.env.STOW_PORT || 3088
const URL = `http://localhost:${PORT}`
const NO_OPEN = process.argv.includes('--no-open')

async function checkDependencies() {
    const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules')
    if (!fs.existsSync(nodeModulesPath)) {
        console.log('📦 Installing dependencies...')
        await execAsync('npm install', { cwd: PROJECT_ROOT })
        console.log('✅ Dependencies installed.')
    }
}

async function checkBuild() {
    const buildPath = path.join(PROJECT_ROOT, '.next', 'build')
    if (!fs.existsSync(buildPath)) {
        console.log('🔨 Building application (first run)...')
        await execAsync('npm run build', { cwd: PROJECT_ROOT })
        console.log('✅ Build complete.')
    }
}

async function openBrowser() {
    if (NO_OPEN) return

    // Wait a bit for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000))

    try {
        const platform = process.platform
        if (platform === 'darwin') {
            await execAsync(`open "${URL}"`)
        } else if (platform === 'win32') {
            await execAsync(`start "${URL}"`)
        } else {
            await execAsync(`xdg-open "${URL}"`)
        }
        console.log(`🌐 Opened ${URL}`)
    } catch {
        console.log(`📋 Open manually: ${URL}`)
    }
}

async function main() {
    console.log(`
╔═══════════════════════════════════════╗
║         Stow Dashboard                ║
║         Port: ${PORT}                      ║
╚═══════════════════════════════════════╝
`)

    await checkDependencies()
    await checkBuild()

    console.log(`🚀 Starting server on port ${PORT}...`)
    console.log(`   Dashboard: ${URL}`)
    console.log(`   Press Ctrl+C to stop\n`)

    // Open browser in background
    openBrowser()

    // Start Next.js server (this will take over the process)
    const server = spawn('npx', ['next', 'start', '-p', PORT], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        shell: true
    })

    server.on('error', (err) => {
        console.error('Failed to start server:', err)
        process.exit(1)
    })

    // Handle exit
    process.on('SIGINT', () => {
        console.log('\n👋 Shutting down...')
        server.kill('SIGTERM')
        process.exit(0)
    })

    process.on('SIGTERM', () => {
        server.kill('SIGTERM')
        process.exit(0)
    })
}

main().catch(err => {
    console.error('Error:', err)
    process.exit(1)
})
