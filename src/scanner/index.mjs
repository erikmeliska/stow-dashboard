import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { simpleGit } from 'simple-git'
import dotenv from 'dotenv'
import ignore from 'ignore'

const DEFAULT_IGNORE_PATTERNS = [
    '.git', 'node_modules', 'venv', '.venv',
    '__pycache__', '.pytest_cache', 'build', 'dist',
    'python3.7', 'python3.8', 'python3.9', 'python3.10',
    'python3.11', 'python3.12', '.next', 'vendor'
]

// Strong indicators: manifest/doc files that define a real project
const STRONG_PROJECT_INDICATORS = new Set([
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'composer.json',
    'build.gradle',
    'pom.xml',
    'README.md'
])

// Weak indicators: present in projects but also in group/parent directories
const WEAK_PROJECT_INDICATORS = new Set([
    '.git'
])

const CONCURRENCY = 8

export class ProjectScanner {
    constructor(options = {}) {
        this.scanRoots = options.scanRoots || []
        this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORE_PATTERNS
        this.syncFile = options.syncFile || null
        this.forceUpdate = options.forceUpdate || false
        this.onProgress = options.onProgress || (() => {})
        this.existingProjectsCache = new Map()
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

    // Classify a directory based on its already-read entry names
    classifyDirectory(entryNames) {
        const nameSet = new Set(entryNames)
        const hasStrong = [...STRONG_PROJECT_INDICATORS].some(i => nameSet.has(i))
        const hasWeak = [...WEAK_PROJECT_INDICATORS].some(i => nameSet.has(i))
        return { isProject: hasStrong || hasWeak, isStrong: hasStrong, hasGit: nameSet.has('.git') }
    }

    // Load .gitignore from a directory and return an ignore filter
    async loadGitignore(directory) {
        const ig = ignore()
        try {
            const content = await fs.readFile(path.join(directory, '.gitignore'), 'utf-8')
            ig.add(content)
        } catch {
            // No .gitignore
        }
        return ig
    }

    async getSccData(directory) {
        try {
            const output = await new Promise((resolve, reject) => {
                execFile('scc', ['--format', 'json2', '--no-gen', directory], {
                    timeout: 30000,
                    maxBuffer: 10 * 1024 * 1024
                }, (err, stdout) => {
                    if (err) return reject(err)
                    resolve(stdout)
                })
            })

            const data = JSON.parse(output)
            const languages = (data.languageSummary || [])
                .filter(l => l.Code > 0)
                .sort((a, b) => b.Code - a.Code)
                .map(l => ({
                    name: l.Name,
                    files: l.Count,
                    lines: l.Lines,
                    code: l.Code,
                    comment: l.Comment,
                    blank: l.Blank,
                    complexity: l.Complexity,
                }))

            const totalFiles = languages.reduce((s, l) => s + l.files, 0)
            const totalLines = languages.reduce((s, l) => s + l.lines, 0)
            const totalCode = languages.reduce((s, l) => s + l.code, 0)
            const totalComment = languages.reduce((s, l) => s + l.comment, 0)
            const totalBlank = languages.reduce((s, l) => s + l.blank, 0)
            const totalComplexity = languages.reduce((s, l) => s + l.complexity, 0)

            return {
                languages,
                total_files: totalFiles,
                total_lines: totalLines,
                total_code: totalCode,
                total_comment: totalComment,
                total_blank: totalBlank,
                total_complexity: totalComplexity,
                estimated_cost: Math.round(data.estimatedCost || 0),
                estimated_schedule_months: Math.round((data.estimatedScheduleMonths || 0) * 10) / 10,
                estimated_people: Math.round((data.estimatedPeople || 0) * 10) / 10,
            }
        } catch {
            return null
        }
    }

    async getGitInfo(repoPath) {
        try {
            const git = simpleGit(repoPath)

            const isRepo = await git.checkIsRepo()
            if (!isRepo) {
                return { git_detected: false }
            }

            // Run independent git commands in parallel
            const [configResults, log, remotes, status] = await Promise.all([
                Promise.all([
                    git.getConfig('user.name').then(r => r.value || 'Unknown').catch(() => 'Unknown'),
                    git.getConfig('user.email').then(r => r.value || 'Unknown').catch(() => 'Unknown')
                ]),
                git.log({ maxCount: 1000 }),
                git.getRemotes(true),
                git.status().catch(() => null)
            ])

            const [currentUser, currentEmail] = configResults
            const allCommits = log.all || []
            const totalCommits = allCommits.length

            const userCommits = allCommits.filter(c =>
                c.author_name === currentUser || c.author_email === currentEmail
            ).length

            const firstCommit = allCommits[allCommits.length - 1]
            const lastCommit = allCommits[0]

            const userCommitsList = allCommits.filter(c =>
                c.author_name === currentUser || c.author_email === currentEmail
            )
            const lastUserCommit = userCommitsList[0]

            const remoteUrls = remotes.map(r => r.refs?.fetch || r.refs?.push || '').filter(Boolean)

            return {
                project_created: firstCommit?.date || null,
                current_user: currentUser,
                current_email: currentEmail,
                total_commits: totalCommits,
                user_commits: userCommits,
                last_total_commit_date: lastCommit?.date || null,
                last_user_commit_date: lastUserCommit?.date || null,
                remotes: remoteUrls,
                current_branch: status?.current || 'unknown',
                ahead: status?.ahead || 0,
                behind: status?.behind || 0,
                has_remote_tracking: status?.tracking !== null,
                uncommitted_changes: status?.files?.length || 0,
                is_clean: status?.isClean() ?? true,
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
            this.onProgress({ type: 'cache_empty' })
        }
    }

    // Single combined file tree walk: timestamps + sizes + file types
    async walkFileTree(directory) {
        let latestAtime = 0
        let latestMtime = 0
        let contentSizeBytes = 0
        let libsSizeBytes = 0
        const fileTypes = {}

        const scanDir = async (dir, isLibPath = false) => {
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            const promises = []

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)
                if (entry.name === '.project_meta.json') continue

                const isIgnoredPath = this.isIgnored(fullPath)

                if (entry.isDirectory()) {
                    if (!isIgnoredPath) {
                        promises.push(scanDir(fullPath, isLibPath))
                    } else {
                        // Still walk ignored dirs for lib size calculation
                        promises.push(scanDir(fullPath, true))
                    }
                } else if (entry.isFile()) {
                    promises.push(
                        fs.stat(fullPath).then(stat => {
                            latestAtime = Math.max(latestAtime, stat.atimeMs)
                            latestMtime = Math.max(latestMtime, stat.mtimeMs)

                            if (isLibPath || isIgnoredPath) {
                                libsSizeBytes += stat.size
                            } else {
                                contentSizeBytes += stat.size
                                const ext = path.extname(entry.name) || 'no_extension'
                                fileTypes[ext] = (fileTypes[ext] || 0) + 1
                            }
                        }).catch(() => {})
                    )
                }
            }

            await Promise.all(promises)
        }

        await scanDir(directory)
        return { latestAtime, latestMtime, contentSizeBytes, libsSizeBytes, fileTypes }
    }

    // Lightweight: only get latest mtime for cache check (skips ignored dirs entirely)
    async getLatestMtime(directory) {
        let latestMtime = 0

        const scanDir = async (dir) => {
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            const promises = []

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)
                if (this.isIgnored(fullPath) || entry.name === '.project_meta.json') continue

                if (entry.isDirectory()) {
                    promises.push(scanDir(fullPath))
                } else if (entry.isFile()) {
                    promises.push(
                        fs.stat(fullPath).then(stat => {
                            latestMtime = Math.max(latestMtime, stat.mtimeMs)
                        }).catch(() => {})
                    )
                }
            }

            await Promise.all(promises)
        }

        await scanDir(directory)
        return latestMtime
    }

    async extractProjectMetadata(directory, treeData = null) {
        const { latestAtime, latestMtime, contentSizeBytes, libsSizeBytes, fileTypes } =
            treeData || await this.walkFileTree(directory)

        // Get creation time + read project files in parallel
        const [dirStat, packageData, reqContent, readmeContent] = await Promise.all([
            fs.stat(directory).catch(() => null),
            fs.readFile(path.join(directory, 'package.json'), 'utf-8')
                .then(c => JSON.parse(c)).catch(() => null),
            fs.readFile(path.join(directory, 'requirements.txt'), 'utf-8').catch(() => null),
            fs.readFile(path.join(directory, 'README.md'), 'utf-8').catch(() => null)
        ])

        const createdTime = dirStat?.birthtime || dirStat?.ctime || null

        let projectName = null
        let description = null
        let stack = []

        if (packageData) {
            projectName = packageData.name
            description = packageData.description
            if (packageData.dependencies) {
                stack.push(...Object.keys(packageData.dependencies))
            }
        }

        if (reqContent) {
            stack.push(...reqContent.split('\n').filter(l => l.trim() && !l.startsWith('#')))
        }

        if (readmeContent && (!projectName || !description)) {
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
        }

        // Detect credentials
        const credentials = []
        try {
            const entries = await fs.readdir(directory)
            const envFiles = entries.filter(f => f.startsWith('.env'))

            await Promise.all(envFiles.map(async (envFile) => {
                try {
                    const envContent = await fs.readFile(path.join(directory, envFile), 'utf-8')
                    const parsed = dotenv.parse(envContent)
                    for (const key of Object.keys(parsed)) {
                        if (/token|secret|password|key|credentials/i.test(key)) {
                            credentials.push(key)
                        }
                    }
                } catch {
                    // Ignore env file errors
                }
            }))
        } catch {
            // Ignore
        }

        // Run git info and scc in parallel
        const [gitInfo, scc] = await Promise.all([
            this.getGitInfo(directory),
            this.getSccData(directory)
        ])

        const id = crypto.createHash('sha256').update(directory).digest('base64url').slice(0, 8)

        return {
            id,
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
            git_info: gitInfo,
            scc
        }
    }

    async shouldUpdateMetadata(directory) {
        if (this.forceUpdate) return { needsUpdate: true, cached: null }

        const cached = this.existingProjectsCache.get(directory)
        if (!cached || !cached.last_modified) {
            return { needsUpdate: true, cached: null }
        }

        const latestMtime = await this.getLatestMtime(directory)
        const cachedMtime = new Date(cached.last_modified).getTime()

        if (latestMtime <= cachedMtime) {
            if (!cached.id) {
                cached.id = crypto.createHash('sha256').update(directory).digest('base64url').slice(0, 8)
            }
            if (latestMtime < cachedMtime) {
                cached.last_modified = new Date(latestMtime).toISOString()
            }
            return { needsUpdate: false, cached }
        }

        return { needsUpdate: true, cached: null }
    }

    async scanProjects() {
        const startTime = Date.now()

        await this.loadExistingCache()

        // Phase 1: Discover all project directories (fast - just readdir, no heavy I/O)
        const projectDirs = []
        for (const root of this.scanRoots) {
            try {
                await fs.access(root)
            } catch {
                continue
            }
            await this.discoverProjects(root, projectDirs, null)
        }

        this.onProgress({ type: 'discovery_complete', count: projectDirs.length })

        // Phase 2: Extract metadata with concurrency limit
        const scannedProjects = []
        for (let i = 0; i < projectDirs.length; i += CONCURRENCY) {
            const batch = projectDirs.slice(i, i + CONCURRENCY)
            const results = await Promise.all(batch.map(dir => this.processProject(dir)))
            for (const result of results) {
                if (result) scannedProjects.push(result)
            }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
        this.onProgress({ type: 'complete', totalTime, count: scannedProjects.length })

        return scannedProjects
    }

    async processProject(directory) {
        const startTime = Date.now()

        try {
            const { needsUpdate, cached } = await this.shouldUpdateMetadata(directory)

            let projectMeta
            if (needsUpdate) {
                projectMeta = await this.extractProjectMetadata(directory)
                const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)
                this.onProgress({ type: 'updated', directory, processingTime })

                this.deleteLegacyMetaFile(directory) // fire and forget
            } else {
                projectMeta = cached
                const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)
                this.onProgress({ type: 'existing', directory, processingTime })
            }

            return projectMeta
        } catch (error) {
            this.onProgress({ type: 'error', directory, error: error.message })
            return null
        }
    }

    // Check if a directory name should be skipped during discovery
    isSkippedForDiscovery(name) {
        // Skip hidden directories (. prefix) - they are caches, configs, build artifacts
        // .git is handled separately as an indicator, not traversed
        if (name.startsWith('.')) return true
        return false
    }

    // Max levels of non-project directories to traverse below an indexed project
    // Allows: project/orgDir/subProject (2 levels) but not project/a/b/c/dep (4 levels)
    static MAX_SUB_DEPTH = 2

    // Filter subdirectories: skip hidden dirs, globally ignored, and gitignored
    filterSubDirs(entries, directory, gitIgnore, gitRoot) {
        const subDirs = []
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (this.isSkippedForDiscovery(entry.name)) continue
            const fullPath = path.join(directory, entry.name)
            if (this.isIgnored(fullPath)) continue

            if (gitIgnore && gitRoot) {
                const relPath = path.relative(gitRoot, fullPath)
                if (gitIgnore.ignores(relPath + '/')) continue
            }

            subDirs.push(fullPath)
        }
        return subDirs
    }

    // Classify subdirectories in parallel (one readdir each)
    async classifySubDirs(subDirs) {
        return Promise.all(
            subDirs.map(async (subPath) => {
                try {
                    const subEntries = await fs.readdir(subPath, { withFileTypes: true })
                    const subNames = subEntries.map(e => e.name)
                    return { path: subPath, ...this.classifyDirectory(subNames), entries: subEntries }
                } catch {
                    return { path: subPath, isProject: false, isStrong: false, hasGit: false, entries: [] }
                }
            })
        )
    }

    // Fast discovery: walk the tree, respect .gitignore when inside a git repo
    // subDepth: how many non-project levels deep we are below an indexed project (0 = not inside one)
    async discoverProjects(directory, results, gitIgnore, gitRoot = null, subDepth = 0) {
        if (this.isIgnored(directory)) return

        let entries
        try {
            entries = await fs.readdir(directory, { withFileTypes: true })
        } catch {
            return
        }

        const entryNames = entries.map(e => e.name)
        const { isProject, isStrong, hasGit } = this.classifyDirectory(entryNames)

        let currentGitIgnore = gitIgnore
        let currentGitRoot = gitRoot
        if (hasGit) {
            currentGitIgnore = await this.loadGitignore(directory)
            currentGitRoot = directory
        }

        const subDirs = this.filterSubDirs(entries, directory, currentGitIgnore, currentGitRoot)

        if (isProject) {
            const subClassifications = await this.classifySubDirs(subDirs)
            const hasSubProjects = subClassifications.some(s => s.isProject)

            if (hasSubProjects && !isStrong) {
                // Weak-only group dir: skip it, recurse into all children
                await Promise.all(subClassifications.map(sub =>
                    this.discoverFromClassified(sub, results, currentGitIgnore, currentGitRoot, subDepth)
                ))
                return
            }

            // Index this project
            results.push(directory)

            // Recurse into subdirectories with subDepth=1 (we're now inside a project)
            await Promise.all(subClassifications.map(sub =>
                this.discoverFromClassified(sub, results, currentGitIgnore, currentGitRoot, 1)
            ))
            return
        }

        // Not a project
        if (subDepth > 0) {
            // We're inside a project's subtree — check depth limit
            if (subDepth >= ProjectScanner.MAX_SUB_DEPTH) return
            await Promise.all(subDirs.map(subPath =>
                this.discoverProjects(subPath, results, currentGitIgnore, currentGitRoot, subDepth + 1)
            ))
        } else {
            // Top-level traversal — no depth limit
            await Promise.all(subDirs.map(subPath =>
                this.discoverProjects(subPath, results, currentGitIgnore, currentGitRoot, 0)
            ))
        }
    }

    // Continue discovery from an already-classified directory
    async discoverFromClassified(classified, results, gitIgnore, gitRoot, subDepth) {
        const { path: dirPath, isProject, isStrong, hasGit, entries } = classified
        if (!entries || entries.length === 0) {
            return this.discoverProjects(dirPath, results, gitIgnore, gitRoot, subDepth)
        }

        let currentGitIgnore = gitIgnore
        let currentGitRoot = gitRoot
        if (hasGit) {
            currentGitIgnore = await this.loadGitignore(dirPath)
            currentGitRoot = dirPath
        }

        const subDirs = this.filterSubDirs(entries, dirPath, currentGitIgnore, currentGitRoot)

        if (isProject) {
            const subClassifications = await this.classifySubDirs(subDirs)
            const hasSubProjects = subClassifications.some(s => s.isProject)

            if (hasSubProjects && !isStrong) {
                await Promise.all(subClassifications.map(sub =>
                    this.discoverFromClassified(sub, results, currentGitIgnore, currentGitRoot, subDepth)
                ))
                return
            }

            // Index this sub-project, reset depth counter
            results.push(dirPath)

            await Promise.all(subClassifications.map(sub =>
                this.discoverFromClassified(sub, results, currentGitIgnore, currentGitRoot, 1)
            ))
            return
        }

        // Not a project — respect depth limit when inside a project subtree
        if (subDepth > 0) {
            if (subDepth >= ProjectScanner.MAX_SUB_DEPTH) return
            await Promise.all(subDirs.map(subPath =>
                this.discoverProjects(subPath, results, currentGitIgnore, currentGitRoot, subDepth + 1)
            ))
        } else {
            await Promise.all(subDirs.map(subPath =>
                this.discoverProjects(subPath, results, currentGitIgnore, currentGitRoot, 0)
            ))
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

        const parentDir = path.dirname(this.syncFile)
        await fs.mkdir(parentDir, { recursive: true })

        const lines = projects.map(p => JSON.stringify(p))
        await fs.writeFile(this.syncFile, lines.join('\n') + '\n')

        this.onProgress({ type: 'synced', file: this.syncFile })
    }

    async cleanupMetadataFiles() {
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

/**
 * Standalone function to get the latest file modification time for a directory.
 * Skips ignored paths (.git, node_modules, .next, etc.)
 */
export async function getLatestMtime(directory) {
    const scanner = new ProjectScanner({ scanRoots: [] })
    const latestMtime = await scanner.getLatestMtime(directory)
    return new Date(latestMtime).toISOString()
}

export default ProjectScanner
