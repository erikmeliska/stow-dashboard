import fs from 'fs/promises'
import path from 'path'
import { simpleGit } from 'simple-git'
import dotenv from 'dotenv'

const DEFAULT_IGNORE_PATTERNS = [
    '.git', 'node_modules', 'venv', '.venv',
    '__pycache__', '.pytest_cache', 'build', 'dist',
    'python3.7', 'python3.8', 'python3.9', 'python3.10',
    'python3.11', 'python3.12', '.next'
]

const PROJECT_INDICATORS = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'composer.json',
    'build.gradle',
    'pom.xml',
    '.git',
    'README.md'
]

export class ProjectScanner {
    constructor(options = {}) {
        this.scanRoots = options.scanRoots || []
        this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORE_PATTERNS
        this.syncFile = options.syncFile || null
        this.forceUpdate = options.forceUpdate || false
        this.onProgress = options.onProgress || (() => {})
        this.existingProjectsCache = new Map() // Cache loaded from JSONL
    }

    isIgnored(filePath) {
        const normalized = filePath.toLowerCase().replace(/\\/g, '/')
        const withSlashes = `/${normalized}/`

        for (const pattern of this.ignorePatterns) {
            if (withSlashes.includes(`/${pattern.toLowerCase()}/`)) {
                return true
            }
        }
        return false
    }

    async isProjectDirectory(directory) {
        for (const indicator of PROJECT_INDICATORS) {
            try {
                await fs.access(path.join(directory, indicator))
                return true
            } catch {
                // Continue checking
            }
        }
        return false
    }

    async getGitInfo(repoPath) {
        try {
            const git = simpleGit(repoPath)

            // Check if it's a git repo
            const isRepo = await git.checkIsRepo()
            if (!isRepo) {
                return { git_detected: false }
            }

            // Get config
            let currentUser = 'Unknown'
            let currentEmail = 'Unknown'
            try {
                currentUser = await git.getConfig('user.name').then(r => r.value || 'Unknown')
                currentEmail = await git.getConfig('user.email').then(r => r.value || 'Unknown')
            } catch {
                // Ignore config errors
            }

            // Get log info
            const log = await git.log({ maxCount: 1000 })
            const allCommits = log.all || []
            const totalCommits = allCommits.length

            // User commits
            const userCommits = allCommits.filter(c =>
                c.author_name === currentUser || c.author_email === currentEmail
            ).length

            // First and last commits
            const firstCommit = allCommits[allCommits.length - 1]
            const lastCommit = allCommits[0]

            // User's last commit
            const userCommitsList = allCommits.filter(c =>
                c.author_name === currentUser || c.author_email === currentEmail
            )
            const lastUserCommit = userCommitsList[0]

            // Get remotes
            const remotes = await git.getRemotes(true)
            const remoteUrls = remotes.map(r => r.refs?.fetch || r.refs?.push || '').filter(Boolean)

            // Get current branch, tracking info, and working tree status
            let currentBranch = 'unknown'
            let ahead = 0
            let behind = 0
            let hasRemoteTracking = false
            let uncommittedChanges = 0
            let isClean = true
            try {
                const branchResult = await git.branch()
                currentBranch = branchResult.current || 'unknown'

                // Get status (ahead/behind + working tree)
                const status = await git.status()
                ahead = status.ahead || 0
                behind = status.behind || 0
                hasRemoteTracking = status.tracking !== null
                uncommittedChanges = status.files?.length || 0
                isClean = status.isClean()
            } catch {
                // Ignore branch errors
            }

            return {
                project_created: firstCommit?.date || null,
                current_user: currentUser,
                current_email: currentEmail,
                total_commits: totalCommits,
                user_commits: userCommits,
                last_total_commit_date: lastCommit?.date || null,
                last_user_commit_date: lastUserCommit?.date || null,
                remotes: remoteUrls,
                current_branch: currentBranch,
                ahead,
                behind,
                has_remote_tracking: hasRemoteTracking,
                uncommitted_changes: uncommittedChanges,
                is_clean: isClean,
                git_detected: true
            }
        } catch (error) {
            return {
                git_error: error.message,
                git_detected: false
            }
        }
    }

    async loadExistingCache() {
        if (!this.syncFile) return

        try {
            const content = await fs.readFile(this.syncFile, 'utf-8')
            const lines = content.trim().split('\n').filter(l => l.trim())

            for (const line of lines) {
                try {
                    const project = JSON.parse(line)
                    if (project.directory) {
                        this.existingProjectsCache.set(project.directory, project)
                    }
                } catch {
                    // Skip invalid lines
                }
            }

            this.onProgress({ type: 'cache_loaded', count: this.existingProjectsCache.size })
        } catch {
            // JSONL doesn't exist yet, start fresh
            this.onProgress({ type: 'cache_empty' })
        }
    }

    async getLatestTimestamps(directory) {
        let latestAtime = 0
        let latestMtime = 0

        const scanDir = async (dir) => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true })

                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name)

                    // Skip ignored paths
                    if (this.isIgnored(fullPath)) continue

                    // Skip legacy meta file (may still exist in some projects)
                    if (entry.name === '.project_meta.json') continue

                    try {
                        const stat = await fs.stat(fullPath)
                        latestAtime = Math.max(latestAtime, stat.atimeMs)
                        latestMtime = Math.max(latestMtime, stat.mtimeMs)

                        if (entry.isDirectory()) {
                            await scanDir(fullPath)
                        }
                    } catch {
                        // Ignore stat errors
                    }
                }
            } catch {
                // Ignore read errors
            }
        }

        await scanDir(directory)
        return { latestAtime, latestMtime }
    }

    async calculateSizes(directory) {
        let contentSizeBytes = 0
        let libsSizeBytes = 0
        const fileTypes = {}

        const scanDir = async (dir, isLibPath = false) => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true })

                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name)
                    const isIgnoredPath = this.isIgnored(fullPath)

                    if (entry.isDirectory()) {
                        await scanDir(fullPath, isLibPath || isIgnoredPath)
                    } else if (entry.isFile()) {
                        try {
                            const stat = await fs.stat(fullPath)
                            const size = stat.size

                            if (isLibPath || isIgnoredPath) {
                                libsSizeBytes += size
                            } else {
                                contentSizeBytes += size
                                const ext = path.extname(entry.name) || 'no_extension'
                                fileTypes[ext] = (fileTypes[ext] || 0) + 1
                            }
                        } catch {
                            // Ignore stat errors
                        }
                    }
                }
            } catch {
                // Ignore read errors
            }
        }

        await scanDir(directory)
        return { contentSizeBytes, libsSizeBytes, fileTypes }
    }

    async extractProjectMetadata(directory) {
        // Get timestamps
        const { latestAtime, latestMtime } = await this.getLatestTimestamps(directory)

        // Get creation time
        let createdTime = null
        try {
            const stat = await fs.stat(directory)
            createdTime = stat.birthtime || stat.ctime
        } catch {
            // Ignore
        }

        // Project name and description
        let projectName = null
        let description = null
        let stack = []

        // Check package.json
        const packageJsonPath = path.join(directory, 'package.json')
        try {
            const packageData = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
            projectName = packageData.name
            description = packageData.description

            if (packageData.dependencies) {
                stack.push(...Object.keys(packageData.dependencies))
            }
        } catch {
            // No package.json or invalid
        }

        // Check requirements.txt
        const reqTxtPath = path.join(directory, 'requirements.txt')
        try {
            const reqContent = await fs.readFile(reqTxtPath, 'utf-8')
            stack.push(...reqContent.split('\n').filter(l => l.trim() && !l.startsWith('#')))
        } catch {
            // No requirements.txt
        }

        // Check README.md for name/description if not found
        const readmePath = path.join(directory, 'README.md')
        if (!projectName || !description) {
            try {
                const readmeContent = await fs.readFile(readmePath, 'utf-8')
                if (!projectName) {
                    const firstLine = readmeContent.split('\n')[0]
                    projectName = firstLine.replace(/^#\s*/, '').trim()
                }
                if (!description) {
                    const match = readmeContent.match(/\n\n(.*?)(\n\n|$)/s)
                    if (match) {
                        description = match[1].trim()
                    }
                }
            } catch {
                // No README.md
            }
        }

        // Detect credentials (anonymized)
        const credentials = []
        try {
            const entries = await fs.readdir(directory)
            const envFiles = entries.filter(f => f.startsWith('.env'))

            for (const envFile of envFiles) {
                try {
                    const envPath = path.join(directory, envFile)
                    const envContent = await fs.readFile(envPath, 'utf-8')
                    const parsed = dotenv.parse(envContent)

                    for (const key of Object.keys(parsed)) {
                        if (/token|secret|password|key|credentials/i.test(key)) {
                            credentials.push(key)
                        }
                    }
                } catch {
                    // Ignore env file errors
                }
            }
        } catch {
            // Ignore
        }

        // Calculate sizes
        const { contentSizeBytes, libsSizeBytes, fileTypes } = await this.calculateSizes(directory)

        // Git information
        const gitInfo = await this.getGitInfo(directory)

        return {
            directory,
            created: createdTime ? createdTime.toISOString() : null,
            last_accessed: new Date(latestAtime).toISOString(),
            last_modified: new Date(latestMtime).toISOString(),
            project_name: projectName || path.basename(directory),
            description,
            stack: [...new Set(stack)],
            file_types: fileTypes,
            content_size_bytes: contentSizeBytes,
            libs_size_bytes: libsSizeBytes,
            total_size_bytes: contentSizeBytes + libsSizeBytes,
            credentials,
            git_info: gitInfo
        }
    }

    async shouldUpdateMetadata(directory) {
        if (this.forceUpdate) return { needsUpdate: true, cached: null }

        const cached = this.existingProjectsCache.get(directory)
        if (!cached || !cached.last_modified) {
            return { needsUpdate: true, cached: null }
        }

        const { latestMtime } = await this.getLatestTimestamps(directory)
        const cachedMtime = new Date(cached.last_modified).getTime()

        // If project hasn't been modified since last scan, use cached data
        if (latestMtime <= cachedMtime) {
            return { needsUpdate: false, cached }
        }

        return { needsUpdate: true, cached: null }
    }

    async scanProjects() {
        const scannedProjects = []
        const startTime = Date.now()

        // Load existing JSONL as cache for incremental scanning
        await this.loadExistingCache()

        for (const root of this.scanRoots) {
            try {
                await fs.access(root)
            } catch {
                continue // Skip non-existent roots
            }

            await this.scanDirectory(root, scannedProjects)
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
        this.onProgress({ type: 'complete', totalTime, count: scannedProjects.length })

        return scannedProjects
    }

    async scanDirectory(directory, scannedProjects) {
        // Check if path should be ignored
        if (this.isIgnored(directory)) return

        // Check if this is a project directory
        const isProject = await this.isProjectDirectory(directory)

        if (isProject) {
            // Check if subdirectories contain their own projects (monorepo/multi-project)
            const subProjects = []
            try {
                const entries = await fs.readdir(directory, { withFileTypes: true })
                for (const entry of entries) {
                    if (entry.isDirectory() && !this.isIgnored(path.join(directory, entry.name))) {
                        const subPath = path.join(directory, entry.name)
                        if (await this.isProjectDirectory(subPath)) {
                            subProjects.push(subPath)
                        }
                    }
                }
            } catch {
                // Ignore read errors
            }

            if (subProjects.length > 0) {
                // Has sub-projects: scan each sub-project instead of the parent
                for (const subPath of subProjects) {
                    await this.scanDirectory(subPath, scannedProjects)
                }
                return
            }

            // Leaf project (no sub-projects): index it
            const startTime = Date.now()

            try {
                const { needsUpdate, cached } = await this.shouldUpdateMetadata(directory)

                let projectMeta
                if (needsUpdate) {
                    projectMeta = await this.extractProjectMetadata(directory)
                    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)
                    this.onProgress({ type: 'updated', directory, processingTime })

                    // Auto-cleanup legacy .project_meta.json when rescanning
                    await this.deleteLegacyMetaFile(directory)
                } else {
                    projectMeta = cached
                    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)
                    this.onProgress({ type: 'existing', directory, processingTime })
                }

                scannedProjects.push(projectMeta)
            } catch (error) {
                this.onProgress({ type: 'error', directory, error: error.message })
            }

            return // Don't scan deeper into leaf projects
        }

        // Scan subdirectories
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true })

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const fullPath = path.join(directory, entry.name)
                    await this.scanDirectory(fullPath, scannedProjects)
                }
            }
        } catch {
            // Ignore read errors
        }
    }

    async deleteLegacyMetaFile(directory) {
        const legacyMetaPath = path.join(directory, '.project_meta.json')
        try {
            await fs.access(legacyMetaPath)
            await fs.unlink(legacyMetaPath)
            this.onProgress({ type: 'legacy_deleted', file: legacyMetaPath })
        } catch {
            // File doesn't exist, nothing to delete
        }
    }

    async syncMetadata(projects) {
        if (!this.syncFile) return

        // Create parent directories
        const parentDir = path.dirname(this.syncFile)
        await fs.mkdir(parentDir, { recursive: true })

        // Write JSONL
        const lines = projects.map(p => JSON.stringify(p))
        await fs.writeFile(this.syncFile, lines.join('\n') + '\n')

        this.onProgress({ type: 'synced', file: this.syncFile })
    }

    async cleanupMetadataFiles() {
        // Clean up old .project_meta.json files (legacy format)
        const LEGACY_META_FILENAME = '.project_meta.json'
        let deletedCount = 0

        const cleanup = async (directory) => {
            if (this.isIgnored(directory)) return

            const metaFilePath = path.join(directory, LEGACY_META_FILENAME)
            try {
                await fs.access(metaFilePath)
                await fs.unlink(metaFilePath)
                deletedCount++
                this.onProgress({ type: 'deleted', file: metaFilePath })
            } catch {
                // File doesn't exist
            }

            try {
                const entries = await fs.readdir(directory, { withFileTypes: true })
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        await cleanup(path.join(directory, entry.name))
                    }
                }
            } catch {
                // Ignore read errors
            }
        }

        for (const root of this.scanRoots) {
            try {
                await fs.access(root)
                await cleanup(root)
            } catch {
                // Skip non-existent roots
            }
        }

        return deletedCount
    }
}

export default ProjectScanner
