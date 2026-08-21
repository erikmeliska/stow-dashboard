'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ThemeToggle'

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k'
  return String(n)
}
function fmtCost(c) { return c == null ? '—' : `$${c.toFixed(2)}` }
function fmtDuration(s) {
  if (!s) return '—'
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
function fmtStart(iso) { return iso ? iso.slice(0, 16).replace('T', ' ') : '—' }
function projectName(dir) { return dir ? dir.split('/').filter(Boolean).slice(-1)[0] : '—' }

const ACTION_CLS = {
  deny: 'bg-red-500/20 text-red-600 dark:text-red-400',
  warn: 'bg-orange-500/20 text-orange-600 dark:text-orange-400',
  override: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
}

function DetailPanel({ detail }) {
  if (!detail) return <p className="text-sm text-muted-foreground">Select a session to see its tools, skills and guard hits.</p>
  if (!detail.session) return <p className="text-sm text-muted-foreground">Session not found.</p>
  const s = detail.session
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="font-mono text-xs text-muted-foreground break-all">{s.session_id}</div>
        <div className="font-medium mt-1">{projectName(s.project_dir)}</div>
        <div className="text-xs text-muted-foreground break-all">{s.project_dir}</div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Model</dt><dd>{s.model || '—'}</dd>
        <dt className="text-muted-foreground">Started</dt><dd>{fmtStart(s.started_at)}</dd>
        <dt className="text-muted-foreground">Duration / active</dt><dd>{fmtDuration(s.duration_s)} / {fmtDuration(s.active_s)}</dd>
        <dt className="text-muted-foreground">Turns</dt><dd>{s.turns}</dd>
        <dt className="text-muted-foreground">Input / output</dt><dd>{fmtTokens(s.input_tokens)} / {fmtTokens(s.output_tokens)}</dd>
        <dt className="text-muted-foreground">Cache read / write</dt><dd>{fmtTokens(s.cache_read)} / {fmtTokens((s.cache_write_5m || 0) + (s.cache_write_1h || 0))}</dd>
        <dt className="text-muted-foreground">Cost (list price)</dt><dd>{fmtCost(s.cost_usd)}</dd>
      </dl>
      <Section title="Tools" empty="No tool calls">
        {detail.tools.map((t) => <Row key={t.tool} label={t.tool} value={t.count} />)}
      </Section>
      <Section title="Skills" empty="No skills used">
        {detail.skills.map((k) => (
          <Row key={k.skill} label={<>{k.skill}{k.edited ? <span className="ml-1 text-xs text-green-600 dark:text-green-400">edited</span> : null}</>} value={k.count} />
        ))}
      </Section>
      <Section title="Guard hits" empty="No guard hits">
        {detail.guard_hits.map((g, i) => (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${ACTION_CLS[g.action] || 'bg-muted text-muted-foreground'}`}>{g.action}</span>
            <code className="text-xs break-all">{g.command}</code>
          </div>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, empty, children }) {
  const items = Array.isArray(children) ? children : [children]
  return (
    <div>
      <h3 className="font-medium mb-1">{title}</h3>
      {items.length ? <div className="divide-y">{items}</div> : <p className="text-xs text-muted-foreground">{empty}</p>}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-2 py-0.5 text-xs">
      <span className="truncate">{label}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/sessions?limit=1000')
      const d = await r.json()
      setSessions(d.sessions || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function open(id) {
    setSelected(id)
    const r = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`)
    setDetail(await r.json())
  }

  const totalCost = sessions.reduce((a, s) => a + (s.cost_usd || 0), 0)

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="flex-none px-4 py-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors"><ArrowLeft className="h-5 w-5" /></Link>
            <h1 className="text-xl font-bold">Sessions</h1>
            <span className="text-sm text-muted-foreground">
              {sessions.length} sessions · {fmtCost(totalCost)} list price
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Reload
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto px-4">
          {!loading && sessions.length === 0 && (
            <p className="text-sm text-muted-foreground py-6">No sessions yet — run <code>npm run cc:ingest</code>.</p>
          )}
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 pr-3 font-medium">Project</th>
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium text-right">Turns</th>
                <th className="py-2 pr-3 font-medium text-right">Tokens</th>
                <th className="py-2 pr-3 font-medium text-right">Cost</th>
                <th className="py-2 pr-3 font-medium text-right">Active</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.session_id}
                  onClick={() => open(s.session_id)}
                  className={`border-b cursor-pointer hover:bg-muted/40 ${selected === s.session_id ? 'bg-muted/60' : ''}`}
                >
                  <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{fmtStart(s.started_at)}</td>
                  <td className="py-1.5 pr-3 truncate max-w-[16rem]" title={s.project_dir || ''}>{projectName(s.project_dir)}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">{s.model || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.turns}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens((s.input_tokens || 0) + (s.output_tokens || 0))}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCost(s.cost_usd)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtDuration(s.active_s)}</td>
                  <td className="py-1.5">{s.status !== 'done' && <span className="text-xs text-muted-foreground">{s.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="w-96 flex-none border-l overflow-auto p-4">
          <DetailPanel detail={detail} />
        </aside>
      </div>
    </div>
  )
}
