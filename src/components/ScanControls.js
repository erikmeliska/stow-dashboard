'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { RefreshCw, Zap, CheckCircle, XCircle, Loader2, Activity, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
}

const SCAN_SETTINGS_KEY = 'stow-dashboard-scan-settings'

function loadScanSettings() {
    if (typeof window === 'undefined') return null
    try {
        const saved = localStorage.getItem(SCAN_SETTINGS_KEY)
        return saved ? JSON.parse(saved) : null
    } catch {
        return null
    }
}

function saveScanSettings(settings) {
    if (typeof window === 'undefined') return
    try {
        localStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(settings))
    } catch {
        // Ignore storage errors
    }
}

export function ScanControls({ lastSyncTime }) {
    const router = useRouter()
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanType, setScanType] = React.useState(null)
    const [lastSync, setLastSync] = React.useState(lastSyncTime)
    const [isMounted, setIsMounted] = React.useState(false)
    const [progress, setProgress] = React.useState(null)
    const [logs, setLogs] = React.useState([])
    const [scanStats, setScanStats] = React.useState({ current: 0, total: 0 })
    const [elapsedTime, setElapsedTime] = React.useState(0)
    const [autoRefresh, setAutoRefresh] = React.useState(false)
    const [syncAgo, setSyncAgo] = React.useState('')
    const startTimeRef = React.useRef(null)
    const timerRef = React.useRef(null)
    const autoRefreshRef = React.useRef(null)
    const syncTimerRef = React.useRef(null)
    const analyzePollRef = React.useRef(null)

    React.useEffect(() => {
        setIsMounted(true)
        // Load autoRefresh setting
        const settings = loadScanSettings()
        if (settings?.autoRefresh) {
            setAutoRefresh(true)
        }
    }, [])

    // Save autoRefresh setting
    React.useEffect(() => {
        if (!isMounted) return
        saveScanSettings({ autoRefresh })
    }, [autoRefresh, isMounted])

    // Live sync time counter
    React.useEffect(() => {
        const updateSyncAgo = () => {
            if (!lastSync) {
                setSyncAgo('')
                return
            }
            const seconds = Math.floor((Date.now() - new Date(lastSync).getTime()) / 1000)
            if (seconds < 60) {
                setSyncAgo(`${seconds}s ago`)
            } else if (seconds < 3600) {
                const mins = Math.floor(seconds / 60)
                setSyncAgo(`${mins}m ago`)
            } else {
                const hours = Math.floor(seconds / 3600)
                setSyncAgo(`${hours}h ago`)
            }
        }

        updateSyncAgo()
        syncTimerRef.current = setInterval(updateSyncAgo, 1000)

        return () => {
            if (syncTimerRef.current) {
                clearInterval(syncTimerRef.current)
            }
        }
    }, [lastSync])

    // Elapsed time timer
    React.useEffect(() => {
        if (isScanning) {
            startTimeRef.current = Date.now()
            setElapsedTime(0)
            timerRef.current = setInterval(() => {
                setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000))
            }, 1000)
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current)
                timerRef.current = null
            }
        }
        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current)
            }
        }
    }, [isScanning])

    // Auto-refresh timer (60s interval)
    React.useEffect(() => {
        if (autoRefresh && !isScanning) {
            autoRefreshRef.current = setInterval(() => {
                handleScan('quick')
            }, 60000)
        } else {
            if (autoRefreshRef.current) {
                clearInterval(autoRefreshRef.current)
                autoRefreshRef.current = null
            }
        }
        return () => {
            if (autoRefreshRef.current) {
                clearInterval(autoRefreshRef.current)
            }
        }
    }, [autoRefresh, isScanning])

    // Resume analyze progress after a view switch: on mount, ask the server
    // whether a batch is still running and, if so, re-attach the poller.
    React.useEffect(() => {
        let cancelled = false
        fetch('/api/analyze/status')
            .then(r => r.json())
            .then(s => { if (!cancelled && s.running) startAnalysisPolling() })
            .catch(() => {})
        return () => {
            cancelled = true
            if (analyzePollRef.current) {
                window.clearInterval(analyzePollRef.current)
                analyzePollRef.current = null
            }
        }
    }, [])

    // Reflect an /api/analyze/status snapshot into the progress UI; when the
    // batch is no longer running, stop polling and show the summary.
    const applyAnalysisStatus = (s) => {
        setScanStats({ current: s.current, total: s.total })
        if (s.running) {
            setProgress({ message: `AI: ${s.lastProject ?? '…'}` })
            return
        }
        if (analyzePollRef.current) {
            window.clearInterval(analyzePollRef.current)
            analyzePollRef.current = null
        }
        setProgress({
            message: `AI analysis done: ${s.analyzed} analyzed, ${s.skipped} cached, ${s.errors} error${s.errors === 1 ? '' : 's'}`,
            success: true,
        })
        setIsScanning(false)
        setScanType(null)
        setLastSync(new Date().toISOString())
        router.refresh()
    }

    // Poll the background analyze job every 2s until it finishes. Idempotent:
    // used both to attach after a POST and to resume after a view switch.
    const startAnalysisPolling = () => {
        setIsScanning(true)
        setScanType('analyze')
        if (analyzePollRef.current) return
        analyzePollRef.current = window.setInterval(async () => {
            try {
                const res = await fetch('/api/analyze/status')
                applyAnalysisStatus(await res.json())
            } catch (e) {
                console.error('Analysis poll error:', e)
            }
        }, 2000)
    }

    const handleScan = async (type = 'normal') => {
        if (type === 'analyze' || type === 'analyze-force') {
            setIsScanning(true)
            setScanType('analyze')
            setProgress({ message: 'Starting AI analysis…' })
            setLogs([])
            setScanStats({ current: 0, total: 0 })
            try {
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(type === 'analyze-force' ? { force: true } : {}),
                })
                if (res.status === 202) {
                    startAnalysisPolling()
                } else if (res.status === 409) {
                    // Batch already running (e.g. started elsewhere) — attach to it.
                    setProgress({ message: 'AI analysis already running' })
                    startAnalysisPolling()
                } else {
                    const data = await res.json().catch(() => ({}))
                    setProgress({ message: `Error: ${data.error || res.statusText}`, error: true })
                    setIsScanning(false)
                    setScanType(null)
                }
            } catch (error) {
                console.error('Analyze error:', error)
                setProgress({ message: `Error: ${error.message}`, error: true })
                setIsScanning(false)
                setScanType(null)
            }
            return
        }

        setIsScanning(true)
        setScanType(type)
        setProgress({ message: 'Connecting...' })
        setLogs([])
        setScanStats({ current: 0, total: 0 })

        const endpoint = type === 'quick' ? '/api/scan/quick' : '/api/scan'
        const body = type === 'force'
            ? { force: true }
            : {}

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
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
                            handleProgressEvent(data)
                        } catch (e) {
                            console.error('Failed to parse SSE data:', e)
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Scan error:', error)
            setProgress({ message: `Error: ${error.message}`, error: true })
        } finally {
            setIsScanning(false)
            setScanType(null)
        }
    }

    const handleProgressEvent = (data) => {
        // Update stats if present
        if (data.total !== undefined) {
            setScanStats(prev => ({
                current: data.current || prev.current,
                total: data.total || prev.total
            }))
        }

        switch (data.type) {
            case 'status':
                setProgress({ message: data.message })
                if (data.total) {
                    setScanStats(prev => ({ ...prev, total: data.total }))
                }
                break
            case 'updated':
                setProgress({ message: `Scanning: ${getShortPath(data.directory)}` })
                setLogs(prev => [...prev.slice(-9), { type: 'updated', path: getShortPath(data.directory), time: data.processingTime }])
                break
            case 'existing':
                setProgress({ message: `Checking: ${getShortPath(data.directory)}` })
                break
            case 'refreshing':
                setProgress({ message: `Refreshing: ${getShortPath(data.directory)}` })
                break
            case 'discovered':
                setProgress({ message: `Discovered: ${getShortPath(data.directory)}` })
                setLogs(prev => [...prev.slice(-9), { type: 'discovered', path: getShortPath(data.directory), time: '' }])
                break
            case 'discover_error':
                setLogs(prev => [...prev.slice(-9), { type: 'error', path: getShortPath(data.directory), time: '' }])
                break
            case 'complete':
                if (data.success) {
                    const scanDurationMsg = data.duration ? ` in ${formatDuration(data.duration)}` : ''
                    const discoveredMsg = data.discovered?.length ? `, +${data.discovered.length} discovered` : ''
                    setProgress({ message: `Done! ${data.projectCount || 0} projects${discoveredMsg}${scanDurationMsg}`, success: true })
                    setLastSync(new Date().toISOString())
                    if (data.processes) {
                        window.dispatchEvent(new CustomEvent('stow:processes', {
                            detail: { projects: data.processes, timestamp: new Date().toISOString() }
                        }))
                    }
                    router.refresh()
                }
                break
            case 'error':
                setProgress({ message: `Error: ${data.message}`, error: true })
                break
            case 'synced':
                setProgress({ message: 'Syncing complete' })
                break
        }
    }

    const getShortPath = (fullPath) => {
        const parts = fullPath.split('/')
        return parts.slice(-2).join('/')
    }

    // Portal target for logs (below header, in table area)
    const [logsPortal, setLogsPortal] = React.useState(null)
    React.useEffect(() => {
        setLogsPortal(document.getElementById('scan-logs-portal'))
    }, [])

    return (
        <>
            <div className="flex items-center gap-2">
                {/* Progress indicator (when scanning) */}
                {isScanning && progress && (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                        {progress.error ? (
                            <XCircle className="h-4 w-4 text-destructive" />
                        ) : progress.success ? (
                            <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {scanStats.total > 0 && !progress.success && (
                            <span className="font-mono text-xs">
                                {scanStats.current}/{scanStats.total}
                            </span>
                        )}
                        <span className="max-w-[200px] truncate">{progress.message}</span>
                        {!progress.success && !progress.error && (
                            <span className="text-xs opacity-70">
                                {formatDuration(elapsedTime)}
                            </span>
                        )}
                    </div>
                )}
                {/* Sync status (when not scanning) */}
                {!isScanning && isMounted && (
                    <span className="text-sm text-muted-foreground" title={lastSync ? new Date(lastSync).toLocaleString() : ''}>
                        {lastSync ? `Synced ${syncAgo}` : 'Not synced'}
                    </span>
                )}
                <Button
                    variant={autoRefresh ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                        if (!autoRefresh) {
                            setAutoRefresh(true)
                            handleScan('quick') // Run immediately when enabled
                        } else {
                            setAutoRefresh(false)
                        }
                    }}
                    disabled={isScanning && !autoRefresh}
                    title={autoRefresh ? "Auto-refresh enabled (60s): processes, discovery, git — click to disable" : "Enable 60s auto-refresh (processes, discovery, git)"}
                >
                    {isScanning && scanType === 'quick' ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Activity className={`mr-2 h-4 w-4 ${autoRefresh ? 'animate-pulse' : ''}`} />
                    )}
                    {autoRefresh ? 'Auto' : 'Auto off'}
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScan('quick')}
                    disabled={isScanning}
                    title="Refresh now: processes, project discovery, git status of active projects"
                >
                    {isScanning && scanType === 'quick' ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Refresh
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={isScanning} title="Maintenance scans">
                            {isScanning && (scanType === 'normal' || scanType === 'force') ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <MoreHorizontal className="h-4 w-4" />
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleScan('normal')}>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Full scan
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleScan('force')}>
                            <Zap className="mr-2 h-4 w-4" />
                            Force rescan
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleScan('analyze')}>
                            AI analyze
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleScan('analyze-force')}>
                            AI analyze (force)
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Recent updates log - rendered via portal to table area, right aligned */}
            {logsPortal && isScanning && logs.length > 0 && createPortal(
                <div className="text-xs text-muted-foreground text-right">
                    {logs.slice(-3).map((log, i) => (
                        <div key={i}>
                            <span className={log.type === 'discovered' ? 'text-blue-500' : 'text-green-600'}>
                                {log.type === 'discovered' ? '+' : '✓'}
                            </span> {log.path}{log.time ? ` (${log.time}s)` : ''}
                        </div>
                    ))}
                </div>,
                logsPortal
            )}
        </>
    )
}
