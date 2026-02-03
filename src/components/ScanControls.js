'use client'

import * as React from 'react'
import { RefreshCw, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatTimeAgo } from '@/lib/utils'

export function ScanControls({ lastSyncTime }) {
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanType, setScanType] = React.useState(null)
    const [lastSync, setLastSync] = React.useState(lastSyncTime)
    const [isMounted, setIsMounted] = React.useState(false)

    React.useEffect(() => {
        setIsMounted(true)
    }, [])

    const handleScan = async (force = false) => {
        setIsScanning(true)
        setScanType(force ? 'force' : 'normal')

        try {
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force })
            })

            const result = await response.json()

            if (result.success) {
                // Update last sync time and reload the page to show new data
                setLastSync(new Date().toISOString())
                window.location.reload()
            } else {
                console.error('Scan failed:', result.error)
                alert('Scan failed: ' + result.error)
            }
        } catch (error) {
            console.error('Scan error:', error)
            alert('Scan error: ' + error.message)
        } finally {
            setIsScanning(false)
            setScanType(null)
        }
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
                    <RefreshCw className={`mr-2 h-4 w-4 ${isScanning && scanType === 'normal' ? 'animate-spin' : ''}`} />
                    {isScanning && scanType === 'normal' ? 'Scanning...' : 'Scan'}
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScan(true)}
                    disabled={isScanning}
                >
                    <Zap className={`mr-2 h-4 w-4 ${isScanning && scanType === 'force' ? 'animate-pulse' : ''}`} />
                    {isScanning && scanType === 'force' ? 'Scanning...' : 'Force Scan'}
                </Button>
            </div>
            <div className="text-sm text-muted-foreground">
                {isMounted && lastSync ? (
                    <span title={new Date(lastSync).toLocaleString()}>
                        Last sync: {formatTimeAgo(lastSync)}
                    </span>
                ) : (
                    <span>Last sync: -</span>
                )}
            </div>
        </div>
    )
}
