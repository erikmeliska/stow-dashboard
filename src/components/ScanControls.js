'use client'

import * as React from 'react'
import { RefreshCw, Zap, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatTimeAgo } from '@/lib/utils'

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
}

export function ScanControls({ lastSyncTime }) {
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanType, setScanType] = React.useState(null)
    const [lastSync, setLastSync] = React.useState(lastSyncTime)
    const [lastDuration, setLastDuration] = React.useState(null)
    const [isMounted, setIsMounted] = React.useState(false)
    const [progress, setProgress] = React.useState(null)
    const [logs, setLogs] = React.useState([])
    const [scanStats, setScanStats] = React.useState({ current: 0, total: 0 })
    const [elapsedTime, setElapsedTime] = React.useState(0)
    const startTimeRef = React.useRef(null)
    const timerRef = React.useRef(null)

    React.useEffect(() => {
        setIsMounted(true)
    }, [])

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

    const handleScan = async (force = false) => {
        setIsScanning(true)
        setScanType(force ? 'force' : 'normal')
        setProgress({ message: 'Connecting...' })
        setLogs([])
        setScanStats({ current: 0, total: 0 })

        try {
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force })
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
            case 'complete':
                if (data.success) {
                    const durationMsg = data.duration ? ` in ${formatDuration(data.duration)}` : ''
                    setProgress({ message: `Done! ${data.projectCount || 0} projects${durationMsg}`, success: true })
                    setLastSync(new Date().toISOString())
                    setLastDuration(data.duration || null)
                    // Reload after a short delay to show success message
                    setTimeout(() => window.location.reload(), 2000)
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

    return (
        <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScan(false)}
                    disabled={isScanning}
                >
                    {isScanning && scanType === 'normal' ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {isScanning && scanType === 'normal' ? 'Scanning...' : 'Scan'}
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScan(true)}
                    disabled={isScanning}
                >
                    {isScanning && scanType === 'force' ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Zap className="mr-2 h-4 w-4" />
                    )}
                    {isScanning && scanType === 'force' ? 'Scanning...' : 'Force Scan'}
                </Button>
            </div>

            {/* Progress indicator */}
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
                    <span className="max-w-[250px] truncate">{progress.message}</span>
                    {!progress.success && !progress.error && (
                        <span className="text-xs opacity-70">
                            {formatDuration(elapsedTime)}
                        </span>
                    )}
                </div>
            )}

            {/* Recent updates log */}
            {isScanning && logs.length > 0 && (
                <div className="text-xs text-muted-foreground max-h-[100px] overflow-y-auto w-full max-w-[300px]">
                    {logs.slice(-5).map((log, i) => (
                        <div key={i} className="truncate">
                            <span className="text-green-600">✓</span> {log.path} ({log.time}s)
                        </div>
                    ))}
                </div>
            )}

            {/* Last sync time */}
            {!isScanning && (
                <div className="text-sm text-muted-foreground">
                    {isMounted && lastSync ? (
                        <span title={new Date(lastSync).toLocaleString()}>
                            Last sync: {formatTimeAgo(lastSync)}
                            {lastDuration && <span className="text-xs opacity-70"> ({formatDuration(lastDuration)})</span>}
                        </span>
                    ) : (
                        <span>Last sync: -</span>
                    )}
                </div>
            )}
        </div>
    )
}
