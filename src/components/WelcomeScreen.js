'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { FolderSearch, Loader2, CheckCircle, XCircle, Zap, Pencil, Save, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function WelcomeScreen({ initialConfig = {} }) {
    const router = useRouter()
    const [isScanning, setIsScanning] = React.useState(false)
    const [progress, setProgress] = React.useState(null)
    const [projectCount, setProjectCount] = React.useState(0)
    const [isEditing, setIsEditing] = React.useState(!initialConfig.SCAN_ROOTS)
    const [isSaving, setIsSaving] = React.useState(false)
    const [config, setConfig] = React.useState({
        SCAN_ROOTS: initialConfig.SCAN_ROOTS || '',
        BASE_DIR: initialConfig.BASE_DIR || '',
        TERMINAL_APP: initialConfig.TERMINAL_APP || 'Terminal',
        IDE_COMMAND: initialConfig.IDE_COMMAND || 'code'
    })

    const hasConfig = config.SCAN_ROOTS.trim().length > 0
    const scanDirs = config.SCAN_ROOTS.split(',').map(d => d.trim()).filter(Boolean)

    const handleSave = async () => {
        setIsSaving(true)
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            })
            if (res.ok) {
                setIsEditing(false)
            }
        } catch {
            // Ignore save errors
        } finally {
            setIsSaving(false)
        }
    }

    const handleScan = async () => {
        setIsScanning(true)
        setProgress({ message: 'Connecting...' })

        try {
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            })

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n\n')
                buffer = lines.pop() || ''

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6))
                            switch (data.type) {
                                case 'status':
                                    setProgress({ message: data.message })
                                    break
                                case 'updated':
                                case 'existing':
                                    setProgress({ message: `Found: ${data.directory.split('/').slice(-2).join('/')}` })
                                    break
                                case 'complete':
                                    if (data.success) {
                                        setProjectCount(data.projectCount || 0)
                                        setProgress({ message: `Found ${data.projectCount || 0} projects!`, success: true })
                                        setTimeout(() => router.refresh(), 1000)
                                    }
                                    break
                                case 'error':
                                    setProgress({ message: data.message, error: true })
                                    break
                            }
                        } catch {
                            // Skip parse errors
                        }
                    }
                }
            }
        } catch (error) {
            setProgress({ message: error.message, error: true })
        } finally {
            setIsScanning(false)
        }
    }

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="max-w-lg w-full text-center space-y-6 px-4">
                <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
                    <FolderSearch className="w-8 h-8 text-muted-foreground" />
                </div>

                <div className="space-y-2">
                    <h2 className="text-2xl font-semibold tracking-tight">Welcome to Stow Dashboard</h2>
                    <p className="text-muted-foreground">
                        {hasConfig && !isEditing
                            ? 'No projects found yet. Run your first scan to discover projects.'
                            : 'Set up your scan directories to get started.'
                        }
                    </p>
                </div>

                {/* Config display / edit */}
                {isEditing ? (
                    <div className="space-y-3 text-left">
                        <div>
                            <label className="text-sm font-medium mb-1 block">Scan Directories</label>
                            <Input
                                placeholder="/Users/you/projects,/Users/you/work"
                                value={config.SCAN_ROOTS}
                                onChange={e => setConfig(c => ({ ...c, SCAN_ROOTS: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground mt-1">Comma-separated paths to scan for projects</p>
                        </div>
                        <div>
                            <label className="text-sm font-medium mb-1 block">Base Directory</label>
                            <Input
                                placeholder="/Users/you/projects"
                                value={config.BASE_DIR}
                                onChange={e => setConfig(c => ({ ...c, BASE_DIR: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground mt-1">Used for relative path display in the dashboard</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-sm font-medium mb-1 block">Terminal App</label>
                                <Input
                                    placeholder="Terminal"
                                    value={config.TERMINAL_APP}
                                    onChange={e => setConfig(c => ({ ...c, TERMINAL_APP: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-sm font-medium mb-1 block">IDE Command</label>
                                <Input
                                    placeholder="code"
                                    value={config.IDE_COMMAND}
                                    onChange={e => setConfig(c => ({ ...c, IDE_COMMAND: e.target.value }))}
                                />
                            </div>
                        </div>
                        <Button
                            className="w-full"
                            onClick={handleSave}
                            disabled={isSaving || !config.SCAN_ROOTS.trim()}
                        >
                            {isSaving ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                            ) : (
                                <><Save className="mr-2 h-4 w-4" />Save Configuration</>
                            )}
                        </Button>
                    </div>
                ) : hasConfig ? (
                    <div className="space-y-2">
                        <div className="bg-muted rounded-lg p-3 text-left text-sm space-y-1.5">
                            {scanDirs.map((dir, i) => (
                                <div key={i} className="flex items-center gap-2 text-muted-foreground">
                                    <FolderOpen className="h-4 w-4 shrink-0" />
                                    <span className="font-mono text-xs truncate">{dir}</span>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={() => setIsEditing(true)}
                            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
                        >
                            <Pencil className="h-3 w-3" />
                            Edit configuration
                        </button>
                    </div>
                ) : null}

                {/* Progress */}
                {progress && (
                    <div className="flex items-center justify-center gap-2 text-sm">
                        {progress.error ? (
                            <XCircle className="h-4 w-4 text-destructive shrink-0" />
                        ) : progress.success ? (
                            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                        ) : (
                            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                        )}
                        <span className={progress.error ? 'text-destructive' : progress.success ? 'text-green-500' : 'text-muted-foreground'}>
                            {progress.message}
                        </span>
                    </div>
                )}

                {/* Scan button - only when config exists and not editing */}
                {hasConfig && !isEditing && (
                    <Button
                        size="lg"
                        onClick={handleScan}
                        disabled={isScanning || progress?.success}
                        className="min-w-[200px]"
                    >
                        {isScanning ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scanning...</>
                        ) : progress?.success ? (
                            <><CheckCircle className="mr-2 h-4 w-4" />{projectCount} Projects Found</>
                        ) : (
                            <><Zap className="mr-2 h-4 w-4" />Run First Scan</>
                        )}
                    </Button>
                )}
            </div>
        </div>
    )
}
