'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatEta } from '@/lib/cc/session-calendar.mjs'

const POLL_MS = 2000
const dismissKey = (k) => `stow.summaryBanner.dismissed:${k}`
function readDismissed(k) { try { return sessionStorage.getItem(dismissKey(k)) === '1' } catch { return false } }
function writeDismissed(k) { try { sessionStorage.setItem(dismissKey(k), '1') } catch { /* private mode */ } }
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const modelLabel = (m) => (/sonnet-5-5/.test(m || '') ? 'Sonnet 5.5' : m || '')

/**
 * "N sessions in this period have no summary" → batch → progress. `ids` are
 * exactly the calendar's visible events without a summary (period + filters),
 * so what the banner counts is what the batch processes. A job already running
 * (e.g. started from MCP) is shown instead of the question.
 */
export function SummaryBanner({ ids, periodKey, onProgress }) {
  const [est, setEst] = useState(null)
  const [job, setJob] = useState(null)
  const [mine, setMine] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState(null)
  const startedAt = useRef(0)
  const idsKey = ids.join(',')

  useEffect(() => { setDismissed(readDismissed(periodKey)) }, [periodKey])

  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        const d = await (await post('/api/sessions/summarize-batch/estimate', { ids })).json()
        if (!alive) return
        setEst(d)
        if (d.job?.status === 'running') setJob((j) => j || d.job)
      } catch { /* offline: no banner */ }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = job?.status === 'running'
  useEffect(() => {
    if (!running) return
    let seen = job.done + job.failed.length
    const iv = setInterval(async () => {
      try {
        const { job: j } = await (await fetch('/api/sessions/summarize-batch')).json()
        if (!j || j.job_id !== job.job_id) return
        setJob(j)
        const n = j.done + j.failed.length
        if (n !== seen || j.status !== 'running') { seen = n; onProgress?.() }
      } catch { /* keep polling */ }
    }, POLL_MS)
    return () => clearInterval(iv)
  }, [job?.job_id, running]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start(runIds) {
    setError(null)
    const r = await post('/api/sessions/summarize-batch', { ids: runIds })
    const d = await r.json()
    if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return }
    startedAt.current = Date.now()
    setMine(true)
    setJob(d.job)
  }

  const box = 'mb-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs'

  if (running) {
    const processed = job.done + job.failed.length
    const elapsed = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0
    const perItem = processed && elapsed ? elapsed / processed : (est?.missing ? est.estimateSeconds / Math.ceil(est.missing / (job.concurrency || 3)) : 30)
    const left = processed && elapsed ? (job.total - processed) * perItem : Math.ceil((job.total - processed) / (job.concurrency || 3)) * perItem
    return (
      <div className={box} role="status">
        <Sparkles className="h-3.5 w-3.5 animate-pulse" />
        <span className="tabular-nums">Summarising {processed} / {job.total} · {formatEta(left)} left{job.failed.length ? ` · ${job.failed.length} failed` : ''}</span>
        <div className="h-1 min-w-24 flex-1 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${job.total ? (processed / job.total) * 100 : 0}%` }} /></div>
      </div>
    )
  }

  if (job && mine && job.status !== 'running') {
    // A not-found transcript fails the same way every time; only offer to retry the rest.
    const failedIds = job.failed.filter((f) => f.kind !== 'not-found').map((f) => f.id)
    return (
      <div className={box} role="status">
        <span>{job.status === 'stopped' ? `Stopped: ${job.error}` : job.status === 'stale' ? 'The batch stopped responding.' : `Done: ${job.done} summarised`}{job.failed.length ? `, ${job.failed.length} failed` : ''}.</span>
        {failedIds.length > 0 && job.status !== 'stopped' && <Button size="sm" variant="outline" onClick={() => start(failedIds)}>Retry failed</Button>}
        <button className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close" onClick={() => { setJob(null); setMine(false) }}><X className="h-3.5 w-3.5" /></button>
      </div>
    )
  }

  if (!est?.missing || dismissed) return error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null
  return (
    <div className={box} role="region" aria-label="Missing summaries">
      <Sparkles className="h-3.5 w-3.5" />
      <span><b>{est.missing}</b> {est.missing === 1 ? 'session' : 'sessions'} in this period {est.missing === 1 ? 'has' : 'have'} no summary. Fill them in? <span className="text-muted-foreground">{formatEta(est.estimateSeconds)} ({modelLabel(est.model)})</span></span>
      <Button size="sm" onClick={() => start(est.ids)}>Fill in</Button>
      <Button size="sm" variant="ghost" onClick={() => { writeDismissed(periodKey); setDismissed(true) }}>Not now</Button>
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  )
}
