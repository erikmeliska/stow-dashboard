'use client'

import { useState, useEffect, useCallback } from 'react'

export function useProcesses(pollInterval = 30000) {
    const [processes, setProcesses] = useState({})
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [lastUpdate, setLastUpdate] = useState(null)

    const fetchProcesses = useCallback(async () => {
        try {
            const response = await fetch('/api/processes')
            if (!response.ok) throw new Error('Failed to fetch processes')

            const data = await response.json()
            setProcesses(data.projects || {})
            setLastUpdate(data.timestamp)
            setError(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchProcesses()

        if (pollInterval > 0) {
            const interval = setInterval(fetchProcesses, pollInterval)
            return () => clearInterval(interval)
        }
    }, [fetchProcesses, pollInterval])

    const getProcessesForProject = useCallback((directory) => {
        return processes[directory] || []
    }, [processes])

    const getPortsForProject = useCallback((directory) => {
        const procs = processes[directory] || []
        const ports = []
        for (const proc of procs) {
            ports.push(...(proc.ports || []))
        }
        return [...new Set(ports)]
    }, [processes])

    const isProjectRunning = useCallback((directory) => {
        const procs = processes[directory] || []
        return procs.some(p => p.ports && p.ports.length > 0)
    }, [processes])

    const hasDockerContainers = useCallback((directory) => {
        const procs = processes[directory] || []
        return procs.some(p => p.type === 'docker')
    }, [processes])

    const getRunningInfo = useCallback((directory) => {
        const procs = processes[directory] || []
        const regularProcesses = procs.filter(p => p.type !== 'docker')
        const dockerContainers = procs.filter(p => p.type === 'docker')
        const allPorts = []
        for (const proc of procs) {
            allPorts.push(...(proc.ports || []))
        }
        return {
            processes: regularProcesses,
            docker: dockerContainers,
            ports: [...new Set(allPorts)],
            hasProcesses: regularProcesses.length > 0,
            hasDocker: dockerContainers.length > 0,
            isRunning: procs.length > 0
        }
    }, [processes])

    return {
        processes,
        loading,
        error,
        lastUpdate,
        refresh: fetchProcesses,
        getProcessesForProject,
        getPortsForProject,
        isProjectRunning,
        hasDockerContainers,
        getRunningInfo
    }
}
