'use client'

import * as React from "react"
import {
    Copy,
    Check,
    Terminal,
    FolderOpen,
    Code,
    GitBranch,
    ExternalLink,
    Loader2,
    AlertCircle,
    Circle,
    Square,
    Container
} from "lucide-react"

import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"

function formatBytes(bytes) {
    if (!bytes) return '-'
    const mb = bytes / 1024 / 1024
    if (mb >= 1) return `${mb.toFixed(2)} MB`
    const kb = bytes / 1024
    return `${kb.toFixed(1)} KB`
}

function CopyButton({ text, tooltip }) {
    const [copied, setCopied] = React.useState(false)

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleCopy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                <p>{copied ? 'Copied!' : tooltip}</p>
            </TooltipContent>
        </Tooltip>
    )
}

function Section({ title, children }) {
    return (
        <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{title}</h3>
            {children}
        </div>
    )
}

function StatItem({ label, value, className = "" }) {
    return (
        <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className={`text-sm font-medium ${className}`}>{value}</span>
        </div>
    )
}

export function ProjectDetailsSheet({ open, onOpenChange, project }) {
    const [gitDetails, setGitDetails] = React.useState(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [processes, setProcesses] = React.useState([])
    const [processesLoading, setProcessesLoading] = React.useState(false)

    React.useEffect(() => {
        if (open && project?.directory) {
            setLoading(true)
            setError(null)
            setGitDetails(null)

            fetch(`/api/project-details?directory=${encodeURIComponent(project.directory)}`)
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        setError(data.error)
                    } else {
                        setGitDetails(data)
                    }
                })
                .catch(() => {
                    setError('Failed to load details')
                })
                .finally(() => {
                    setLoading(false)
                })

            // Fetch running processes
            setProcessesLoading(true)
            fetch(`/api/processes?directory=${encodeURIComponent(project.directory)}`)
                .then(res => res.json())
                .then(data => {
                    setProcesses(data.processes || [])
                })
                .catch(() => {
                    setProcesses([])
                })
                .finally(() => {
                    setProcessesLoading(false)
                })
        }
    }, [open, project?.directory])

    if (!project) return null

    const gitInfo = project.git_info
    const remotes = gitInfo?.remotes || []

    const openWith = async (action) => {
        try {
            await fetch('/api/open-with', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ directory: project.directory, action })
            })
        } catch (e) {
            console.error(`Failed to open with ${action}:`, e)
        }
    }

    const openInTerminal = () => openWith('terminal')
    const openInVSCode = () => openWith('vscode')
    const openInFinder = () => openWith('finder')

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
                <SheetHeader>
                    <SheetTitle>{project.project_name}</SheetTitle>
                    <SheetDescription className="font-mono text-xs break-all">
                        {project.directory}
                    </SheetDescription>
                </SheetHeader>

                {/* Quick Actions - right under header */}
                <TooltipProvider>
                    <div className="flex gap-1 mt-4">
                        <CopyButton text={project.directory} tooltip="Copy path" />
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="outline" size="icon" className="h-8 w-8" onClick={openInVSCode}>
                                    <Code className="h-4 w-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Open in IDE</p></TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="outline" size="icon" className="h-8 w-8" onClick={openInFinder}>
                                    <FolderOpen className="h-4 w-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Open in Finder</p></TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="outline" size="icon" className="h-8 w-8" onClick={openInTerminal}>
                                    <Terminal className="h-4 w-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Open in Terminal</p></TooltipContent>
                        </Tooltip>
                    </div>
                </TooltipProvider>

                <div className="mt-6 space-y-6">
                    {/* Running Processes & Docker Containers */}
                    {processesLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Checking running processes...
                        </div>
                    ) : processes.length > 0 && (() => {
                        const regularProcesses = processes.filter(p => p.type !== 'docker')
                        const dockerContainers = processes.filter(p => p.type === 'docker')

                        const refreshProcesses = async () => {
                            setProcessesLoading(true)
                            const res = await fetch(`/api/processes?directory=${encodeURIComponent(project.directory)}`)
                            const data = await res.json()
                            setProcesses(data.processes || [])
                            setProcessesLoading(false)
                        }

                        const killProcess = async (pid) => {
                            await fetch('/api/processes/kill', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ pids: [pid] })
                            })
                            await refreshProcesses()
                        }

                        const killAllProcesses = async () => {
                            const pids = regularProcesses.map(p => p.pid).filter(Boolean)
                            if (pids.length > 0) {
                                await fetch('/api/processes/kill', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ pids })
                                })
                            }
                            await refreshProcesses()
                        }

                        const stopContainer = async (id) => {
                            await fetch('/api/processes/docker', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'stop', ids: [id] })
                            })
                            await refreshProcesses()
                        }

                        const stopAllContainers = async () => {
                            const ids = dockerContainers.map(c => c.id)
                            await fetch('/api/processes/docker', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'stop', ids })
                            })
                            await refreshProcesses()
                        }

                        return (
                            <>
                                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-green-600 dark:text-green-400 flex items-center gap-2">
                                            <Circle className="h-3 w-3 fill-current" />
                                            {processes.length} running
                                            {regularProcesses.length > 0 && ` (${regularProcesses.length} process${regularProcesses.length > 1 ? 'es' : ''})`}
                                            {dockerContainers.length > 0 && ` (${dockerContainers.length} container${dockerContainers.length > 1 ? 's' : ''})`}
                                        </p>
                                    </div>

                                    {/* Regular Processes */}
                                    {regularProcesses.length > 0 && (
                                        <div className="mt-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-xs text-muted-foreground uppercase tracking-wide">Processes</span>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-6 text-xs text-red-600 hover:text-red-700 hover:bg-red-500/10"
                                                    onClick={killAllProcesses}
                                                >
                                                    <Square className="h-3 w-3 mr-1" />
                                                    Kill All
                                                </Button>
                                            </div>
                                            <div className="space-y-2">
                                                {regularProcesses.map((proc, index) => (
                                                    <div key={index} className="text-xs bg-background/50 rounded p-2">
                                                        <div className="flex items-center justify-between">
                                                            <span className="font-mono font-medium">{proc.command}</span>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-muted-foreground">PID: {proc.pid}</span>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-6 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-500/10"
                                                                    onClick={() => killProcess(proc.pid)}
                                                                >
                                                                    Kill
                                                                </Button>
                                                            </div>
                                                        </div>
                                                        {proc.ports && proc.ports.length > 0 && (
                                                            <div className="mt-1 text-green-600 dark:text-green-400">
                                                                Port{proc.ports.length > 1 ? 's' : ''}: {proc.ports.join(', ')}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Docker Containers */}
                                    {dockerContainers.length > 0 && (
                                        <div className="mt-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                                                    <Container className="h-3 w-3" />
                                                    Docker
                                                </span>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-6 text-xs text-red-600 hover:text-red-700 hover:bg-red-500/10"
                                                    onClick={stopAllContainers}
                                                >
                                                    <Square className="h-3 w-3 mr-1" />
                                                    Stop All
                                                </Button>
                                            </div>
                                            <div className="space-y-2">
                                                {dockerContainers.map((container, index) => (
                                                    <div key={index} className="text-xs bg-blue-500/10 border border-blue-500/20 rounded p-2">
                                                        <div className="flex items-center justify-between">
                                                            <span className="font-mono font-medium">{container.name}</span>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-muted-foreground">{container.id.slice(0, 12)}</span>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-6 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-500/10"
                                                                    onClick={() => stopContainer(container.id)}
                                                                >
                                                                    Stop
                                                                </Button>
                                                            </div>
                                                        </div>
                                                        <div className="mt-1 text-muted-foreground">{container.image}</div>
                                                        {container.ports && container.ports.length > 0 && (
                                                            <div className="mt-1 text-blue-600 dark:text-blue-400">
                                                                Port{container.ports.length > 1 ? 's' : ''}: {container.ports.join(', ')}
                                                            </div>
                                                        )}
                                                        {container.status && (
                                                            <div className="mt-1 text-green-600 dark:text-green-400 text-xs">
                                                                {container.status}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <Separator />
                            </>
                        )
                    })()}

                    {/* Credentials Warning - show first if exists */}
                    {project.credentials && project.credentials.length > 0 && (
                        <>
                            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                                <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                                    {project.credentials.length} credential file(s) detected
                                </p>
                                <ul className="mt-2 space-y-1">
                                    {project.credentials.map((cred, index) => (
                                        <li key={index} className="text-xs text-muted-foreground font-mono">
                                            {cred}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <Separator />
                        </>
                    )}

                    {/* Description */}
                    {project.description && (
                        <>
                            <Section title="Description">
                                <p className="text-sm">{project.description}</p>
                            </Section>
                            <Separator />
                        </>
                    )}

                    {/* Stack / Technologies */}
                    {project.stack && project.stack.length > 0 && (
                        <>
                            <Section title="Stack">
                                <div className="flex flex-wrap gap-2">
                                    {project.stack.map((tech, index) => (
                                        <span
                                            key={index}
                                            className="px-2 py-1 bg-primary/10 text-primary rounded-md text-xs font-medium"
                                        >
                                            {tech}
                                        </span>
                                    ))}
                                </div>
                            </Section>
                            <Separator />
                        </>
                    )}

                    {/* Git Information */}
                    {gitInfo?.git_detected && (
                        <>
                            <Section title="Git">
                                <div className="space-y-4">
                                    <div className="space-y-2 bg-muted/50 rounded-lg p-3">
                                        <StatItem
                                            label="Branch"
                                            value={
                                                <span className="flex items-center gap-1">
                                                    <GitBranch className="h-3 w-3" />
                                                    {gitInfo.current_branch || 'unknown'}
                                                </span>
                                            }
                                        />
                                        <StatItem label="Total Commits" value={gitInfo.total_commits || 0} />
                                        <StatItem label="Your Commits" value={gitInfo.user_commits || 0} />
                                    </div>

                                    {/* Live Git Status */}
                                    {loading ? (
                                        <div className="flex items-center justify-center py-4">
                                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                        </div>
                                    ) : error ? (
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <AlertCircle className="h-4 w-4" />
                                            {error}
                                        </div>
                                    ) : gitDetails ? (
                                        <div className="space-y-3">
                                            <div className="space-y-2 bg-muted/50 rounded-lg p-3">
                                                <StatItem
                                                    label="Working Tree"
                                                    value={gitDetails.isClean ? 'Clean' : `${gitDetails.uncommittedChanges} changes`}
                                                    className={gitDetails.isClean ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}
                                                />
                                                {!gitDetails.isClean && (
                                                    <>
                                                        <StatItem label="Staged" value={gitDetails.staged} />
                                                        <StatItem label="Modified" value={gitDetails.modified} />
                                                        <StatItem label="Untracked" value={gitDetails.untracked} />
                                                    </>
                                                )}
                                                {gitDetails.tracking ? (
                                                    <StatItem
                                                        label="Remote Sync"
                                                        value={
                                                            gitDetails.ahead === 0 && gitDetails.behind === 0
                                                                ? 'Up to date'
                                                                : `${gitDetails.ahead > 0 ? `↑${gitDetails.ahead}` : ''}${gitDetails.ahead > 0 && gitDetails.behind > 0 ? ' ' : ''}${gitDetails.behind > 0 ? `↓${gitDetails.behind}` : ''}`
                                                        }
                                                        className={
                                                            gitDetails.ahead === 0 && gitDetails.behind === 0
                                                                ? 'text-green-600 dark:text-green-400'
                                                                : gitDetails.behind > 0
                                                                    ? 'text-red-600 dark:text-red-400'
                                                                    : 'text-yellow-600 dark:text-yellow-400'
                                                        }
                                                    />
                                                ) : (
                                                    <StatItem
                                                        label="Remote Sync"
                                                        value="No tracking"
                                                        className="text-muted-foreground"
                                                    />
                                                )}
                                            </div>

                                            {gitDetails.lastCommitMessage && (
                                                <div className="bg-muted/50 rounded-lg p-3">
                                                    <p className="text-xs text-muted-foreground mb-1">Last Commit</p>
                                                    <p className="text-sm">{gitDetails.lastCommitMessage}</p>
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        by {gitDetails.lastCommitAuthor}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    ) : null}

                                    {/* Remote URLs */}
                                    {remotes.length > 0 && (
                                        <div className="space-y-2">
                                            <p className="text-xs text-muted-foreground">Remote URLs</p>
                                            {remotes.map((remote, index) => {
                                                const httpUrl = remote
                                                    .replace(/^git@([^:]+):/, 'https://$1/')
                                                    .replace(/\.git$/, '')

                                                return (
                                                    <a
                                                        key={index}
                                                        href={httpUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-2 text-sm text-primary hover:underline break-all"
                                                    >
                                                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                                                        {remote}
                                                    </a>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            </Section>
                            <Separator />
                        </>
                    )}

                    {/* Size & Files */}
                    <Section title="Size & Files">
                        <div className="space-y-4">
                            <div className="space-y-2 bg-muted/50 rounded-lg p-3">
                                <StatItem label="Code & Content" value={formatBytes(project.content_size_bytes)} />
                                <StatItem label="Dependencies" value={formatBytes(project.libs_size_bytes)} />
                                <Separator className="my-2" />
                                <StatItem
                                    label="Total"
                                    value={formatBytes(project.total_size_bytes)}
                                    className="font-semibold"
                                />
                            </div>

                            {/* File Types */}
                            {project.file_types && Object.keys(project.file_types).length > 0 && (
                                <div className="bg-muted/50 rounded-lg p-3 max-h-48 overflow-y-auto">
                                    <p className="text-xs text-muted-foreground mb-2">File Types</p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                        {Object.entries(project.file_types)
                                            .sort((a, b) => b[1] - a[1])
                                            .slice(0, 20)
                                            .map(([ext, count]) => (
                                                <div key={ext} className="flex justify-between text-sm">
                                                    <span className="text-muted-foreground font-mono">
                                                        {ext === 'no_extension' ? '(no ext)' : ext}
                                                    </span>
                                                    <span className="font-medium">{count}</span>
                                                </div>
                                            ))}
                                    </div>
                                    {Object.keys(project.file_types).length > 20 && (
                                        <p className="text-xs text-muted-foreground mt-2">
                                            +{Object.keys(project.file_types).length - 20} more types
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </Section>

                    <Separator />

                    {/* Timestamps */}
                    <Section title="Timestamps">
                        <div className="space-y-2 bg-muted/50 rounded-lg p-3">
                            <StatItem
                                label="Last Modified"
                                value={project.last_modified ? new Date(project.last_modified).toLocaleString() : '-'}
                            />
                            <StatItem
                                label="Created"
                                value={project.created ? new Date(project.created).toLocaleString() : '-'}
                            />
                            <StatItem
                                label="Last Accessed"
                                value={project.last_accessed ? new Date(project.last_accessed).toLocaleString() : '-'}
                            />
                            {gitInfo?.project_created && (
                                <StatItem
                                    label="First Commit"
                                    value={new Date(gitInfo.project_created).toLocaleString()}
                                />
                            )}
                        </div>
                    </Section>
                </div>
            </SheetContent>
        </Sheet>
    )
}
