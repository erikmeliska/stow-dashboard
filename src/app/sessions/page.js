'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, Sparkles } from 'lucide-react'
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

function DetailPanel({ detail, onSummarize, summarizing, summaryError }) {
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
      <Section title="Context" empty="No git/ticket context found in the transcript">
        {[
          s.git_repo && <Row key="repo" label="Repo" value={s.git_repo} />,
          s.git_branch && <Row key="branch" label="Branch" value={s.git_branch} />,
          s.pr && <Row key="pr" label="PR" value={`#${s.pr}`} />,
          s.ticket_id && <Row key="ticket" label={<>Ticket <span className="text-muted-foreground">({s.ticket_source})</span></>} value={s.ticket_id} />,
        ].filter(Boolean)}
      </Section>
      <QualityBlock s={s} />
      <SummaryBlock s={s} onSummarize={onSummarize} summarizing={summarizing} error={summaryError} />
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

function QualityBlock({ s }) {
  let d = null
  try { d = s.quality_detail ? JSON.parse(s.quality_detail) : null } catch { d = null }
  return (
    <div>
      <h3 className="font-medium mb-1">Quality <span className="text-xs font-normal text-muted-foreground">heuristic</span></h3>
      {s.quality_score == null ? <p className="text-xs text-muted-foreground">Not scored — run <code>npm run cc:ingest</code>.</p> : (
        <>
          <div className="text-2xl font-semibold tabular-nums">{s.quality_score}<span className="text-sm font-normal text-muted-foreground">/100</span></div>
          {d && (
            <div className="divide-y">
              <Row label="Verification ran" value={`${d.verified ? 'yes' : 'no'} · ${d.points.verified}`} />
              <Row label="Clean finish" value={`${d.clean_finish ? 'yes' : 'no'} · ${d.points.clean_finish}`} />
              <Row label="Tool error rate" value={`${d.error_rate_pct}% · ${d.points.error_rate}`} />
              <Row label="Loops" value={`${d.loops} · ${d.points.no_loops}`} />
              <Row label="Guard incidents" value={`${d.guard_incidents} · ${d.points.guard_clean}`} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryBlock({ s, onSummarize, summarizing, error }) {
  let sum = null
  try { sum = s.summary ? JSON.parse(s.summary) : null } catch { sum = null }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium">Summary</h3>
        <Button variant="outline" size="sm" onClick={() => onSummarize(s.session_id)} disabled={summarizing}>
          <Sparkles className={`h-3.5 w-3.5 mr-1 ${summarizing ? 'animate-pulse' : ''}`} /> {summarizing ? 'Working…' : sum ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!sum && !error && <p className="text-xs text-muted-foreground">No summary yet — uses your local <code>claude</code> CLI (~1k tokens).</p>}
      {sum && (
        <div className="space-y-1 text-xs">
          <p>{sum.what}</p>
          <Row label="Outcome" value={sum.outcome} />
          {sum.improvements?.length > 0 && <div><span className="text-muted-foreground">Improvements:</span><ul className="list-disc pl-4">{sum.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {sum.followups?.length > 0 && <div><span className="text-muted-foreground">Follow-ups:</span><ul className="list-disc pl-4">{sum.followups.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          <p className="text-muted-foreground">{s.summary_model} · {fmtStart(s.summarized_at)}</p>
        </div>
      )}
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
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState(null)

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
    setSelected(id); setSummaryError(null)
    const r = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`)
    setDetail(await r.json())
  }

  async function summarize(id) {
    setSummarizing(true); setSummaryError(null)
    try {
      const r = await fetch('/api/sessions/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      const d = await r.json()
      if (!r.ok) { setSummaryError(d.error ? `${d.error}${d.detail ? ` — ${d.detail}` : ''}` : `HTTP ${r.status}`); return }
      setDetail(d)
      setSessions((prev) => prev.map((s) => (s.session_id === id ? { ...s, summary: d.session.summary } : s)))
    } catch (e) {
      setSummaryError(String(e?.message || e))
    } finally {
      setSummarizing(false)
    }
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
                <th className="py-2 pr-3 font-medium">Ticket</th>
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium text-right">Turns</th>
                <th className="py-2 pr-3 font-medium text-right">Tokens</th>
                <th className="py-2 pr-3 font-medium text-right">Cost</th>
                <th className="py-2 pr-3 font-medium text-right">Active</th>
                <th className="py-2 pr-3 font-medium text-right" title="Quality score (heuristic)">Q</th>
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
                  <td className="py-1.5 pr-3 whitespace-nowrap font-mono text-xs" title={s.ticket_source ? `from ${s.ticket_source}` : ''}>{s.ticket_id || ''}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">{s.model || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.turns}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens((s.input_tokens || 0) + (s.output_tokens || 0))}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCost(s.cost_usd)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtDuration(s.active_s)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{s.quality_score ?? '—'}</td>
                  <td className="py-1.5">{s.status !== 'done' && <span className="text-xs text-muted-foreground">{s.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="w-96 flex-none border-l overflow-auto p-4">
          <DetailPanel detail={detail} onSummarize={summarize} summarizing={summarizing} summaryError={summaryError} />
        </aside>
      </div>
    </div>
  )
}
