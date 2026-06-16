'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckCircle2, AlertTriangle, Clock, AlertCircle, ChevronDown, ChevronRight, RefreshCw, ListChecks } from 'lucide-react'
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
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${cls}`}>
      {priority}
    </span>
  )
}

function EvidenceIndicator({ hasEvidence, commits }) {
  if (hasEvidence) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        {commits.map((c, i) => (
          <span
            key={i}
            title={`${c.date} — ${c.subject}`}
            className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded font-mono"
          >
            <CheckCircle2 className="h-3 w-3 shrink-0" />
            {c.hash}
          </span>
        ))}
      </div>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      no commit
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
  return Object.values(map).sort((a, b) => {
    const ag = (a.group || []).join('/') + '/' + a.project
    const bg = (b.group || []).join('/') + '/' + b.project
    return ag.localeCompare(bg)
  })
}

function ProjectGroup({ entry, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  const groupLabel = (entry.group || []).filter(g => !g.startsWith('_')).join(' / ')
  const flaggedCount = entry.tasks.filter(t => !t.hasEvidence).length

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
        <div className="ml-auto flex items-center gap-2">
          {flaggedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
              <AlertTriangle className="h-3 w-3" />
              {flaggedCount}
            </span>
          )}
          <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
            {entry.tasks.length} {entry.tasks.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
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
              <EvidenceIndicator hasEvidence={t.hasEvidence} commits={t.commits || []} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CompletedPage() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [evidence, setEvidence] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const fetchTasks = useCallback(async (opts = {}) => {
    if (opts.refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      let qs = ''
      if (evidence) qs = `evidence=${encodeURIComponent(evidence)}`
      const res = await fetch(`/api/completed${qs ? '?' + qs : ''}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTasks(data.tasks || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [evidence])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const groups = groupTasksByProject(tasks)
  const totalCount = tasks.length
  const flaggedTotal = tasks.filter(t => !t.hasEvidence).length

  const EvidenceButton = ({ value, label }) => (
    <button
      onClick={() => setEvidence(prev => prev === value ? '' : value)}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        evidence === value
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
              <ListChecks className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-xl font-bold">Completed</h1>
            </div>
            {!loading && flaggedTotal > 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
                <AlertTriangle className="h-3 w-3" />
                {flaggedTotal} without commit
              </span>
            )}
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
            <span className="text-xs text-muted-foreground mr-1">Evidence:</span>
            <EvidenceButton value="" label="All" />
            <EvidenceButton value="verified" label="Verified" />
            <EvidenceButton value="flagged" label="Flagged" />
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
            Failed to load completed tasks: {error}
          </div>
        )}

        {!loading && !error && tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3">
            <Clock className="h-8 w-8 opacity-40" />
            <p className="text-sm">
              {evidence === 'verified'
                ? 'No verified completed tasks found.'
                : evidence === 'flagged'
                  ? 'No flagged tasks found — all done tasks have commit evidence.'
                  : 'No completed tasks across any project.'}
            </p>
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
