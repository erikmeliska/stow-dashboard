'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckSquare, Clock, AlertCircle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ThemeToggle'

const PRIORITY_COLORS = {
  P0: 'bg-red-500/20 text-red-600 dark:text-red-400',
  P1: 'bg-orange-500/20 text-orange-600 dark:text-orange-400',
  P2: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
  P3: 'bg-muted text-muted-foreground',
}

function PriorityBadge({ priority }) {
  const cls = PRIORITY_COLORS[priority] || PRIORITY_COLORS.P2
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cls}`}>
      {priority}
    </span>
  )
}

function groupTasksByProject(tasks) {
  const map = {}
  for (const t of tasks) {
    if (!map[t.project]) {
      map[t.project] = { project: t.project, directory: t.directory, group: t.group, tasks: [] }
    }
    map[t.project].tasks.push(t)
  }
  // Sort projects: by group path then project name
  return Object.values(map).sort((a, b) => {
    const ag = (a.group || []).join('/') + '/' + a.project
    const bg = (b.group || []).join('/') + '/' + b.project
    return ag.localeCompare(bg)
  })
}

function ProjectGroup({ entry, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  const groupLabel = (entry.group || []).filter(g => !g.startsWith('_')).join(' / ')

  return (
    <div className="border rounded-md mb-3 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="font-medium text-sm">{entry.project}</span>
        {groupLabel && (
          <span className="text-xs text-muted-foreground">{groupLabel}</span>
        )}
        <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
          {entry.tasks.length} {entry.tasks.length === 1 ? 'task' : 'tasks'}
        </span>
      </button>

      {open && (
        <div className="divide-y">
          {entry.tasks.map((t, i) => (
            <div key={`${t.id ?? i}`} className="flex items-start gap-3 px-4 py-2.5 text-sm hover:bg-muted/20 transition-colors">
              <PriorityBadge priority={t.priority} />
              {t.id && (
                <code className="text-xs text-muted-foreground font-mono shrink-0 pt-0.5">{t.id}</code>
              )}
              <span className="flex-1 min-w-0">
                {t.text}
                {t.source && (
                  <span className="block text-xs text-muted-foreground mt-0.5">from {t.source}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TasksPage() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('open')
  const [priority, setPriority] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const fetchTasks = useCallback(async (opts = {}) => {
    if (opts.refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      let qs = `status=${encodeURIComponent(status)}`
      if (priority) qs += `&priority=${encodeURIComponent(priority)}`
      const res = await fetch(`/api/tasks?${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTasks(data.tasks || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [status, priority])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const groups = groupTasksByProject(tasks)
  const totalCount = tasks.length

  const StatusButton = ({ value, label }) => (
    <button
      onClick={() => setStatus(value)}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        status === value
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
      }`}
    >
      {label}
    </button>
  )

  const PriorityButton = ({ value, label }) => (
    <button
      onClick={() => setPriority(prev => prev === value ? '' : value)}
      className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
        priority === value
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-none px-4 py-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <CheckSquare className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-xl font-bold">Tasks</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => fetchTasks({ refresh: true })}
              disabled={refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex-none px-4 py-2 border-b bg-muted/20">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Status:</span>
            <StatusButton value="open" label="Open" />
            <StatusButton value="done" label="Done" />
            <StatusButton value="all" label="All" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Priority:</span>
            <PriorityButton value="P0" label="P0" />
            <PriorityButton value="P1" label="P1" />
            <PriorityButton value="P2" label="P2" />
            <PriorityButton value="P3" label="P3" />
          </div>
          {totalCount > 0 && !loading && (
            <span className="ml-auto text-xs text-muted-foreground">
              {totalCount} {totalCount === 1 ? 'task' : 'tasks'} across {groups.length} {groups.length === 1 ? 'project' : 'projects'}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && (
          <div className="flex flex-col gap-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm p-4 border border-destructive/30 rounded-md bg-destructive/10">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load tasks: {error}
          </div>
        )}

        {!loading && !error && tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3">
            <Clock className="h-8 w-8 opacity-40" />
            <p className="text-sm">
              {status === 'open' ? 'No open tasks across any project.' : `No ${status} tasks found.`}
            </p>
            {priority && (
              <p className="text-xs">Try clearing the priority filter.</p>
            )}
          </div>
        )}

        {!loading && !error && groups.length > 0 && (
          <div>
            {groups.map(entry => (
              <ProjectGroup
                key={entry.project + entry.directory}
                entry={entry}
                defaultOpen={entry.tasks.length <= 10}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
