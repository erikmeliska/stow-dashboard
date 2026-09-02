'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, PieChart, Pie, Cell,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ThemeToggle'

const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All']]
const VIZ = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']

function fmtNum(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtCost(c) {
  if (c == null) return '—'
  if (c >= 1e9) return `$${(c / 1e9).toFixed(1)}B`
  if (c >= 1e6) return `$${(c / 1e6).toFixed(1)}M`
  if (c >= 1e3) return `$${(c / 1e3).toFixed(1)}K`
  return `$${c.toFixed(c >= 100 ? 0 : 2)}`
}
function fmtMin(s) {
  if (s == null) return '—'
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
function fmtDay(d) { return d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '' }
function shortModel(m) { return (m || '').replace(/^claude-/, '') }

// Shared axis/grid chrome: recessive hairlines, muted ticks
const tick = { fill: 'var(--viz-axis)', fontSize: 11 }
const gridProps = { stroke: 'var(--viz-grid)', strokeWidth: 1, vertical: false }

function VizTooltip({ active, payload, label, labelFormatter, valueFormatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border bg-popover text-popover-foreground px-2.5 py-1.5 text-xs shadow-md">
      {label != null && <div className="font-medium mb-0.5">{labelFormatter ? labelFormatter(label) : label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color || p.payload?.fill }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto pl-3 tabular-nums">{(valueFormatter || fmtNum)(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

function Card({ title, subtitle, children, className = '' }) {
  return (
    <div className={`rounded-lg border bg-card p-4 ${className}`}>
      <h3 className="text-sm font-medium">{title}</h3>
      {subtitle && <p className="text-xs text-muted-foreground mb-2">{subtitle}</p>}
      {!subtitle && <div className="mb-2" />}
      {children}
    </div>
  )
}

function StatTile({ label, value, hint }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-0.5">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}

/** Single-series horizontal bar list (one hue — the series is not an identity). */
function HBar({ data, nameKey, valueKey, valueFormatter = fmtNum, height }) {
  return (
    <ResponsiveContainer width="100%" height={height || Math.max(120, data.length * 28 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--viz-grid)" strokeWidth={1} horizontal={false} />
        <XAxis type="number" tick={tick} axisLine={false} tickLine={false} tickFormatter={valueFormatter} />
        <YAxis type="category" dataKey={nameKey} width={130} tick={tick} axisLine={false} tickLine={false}
          tickFormatter={(v) => (String(v).length > 16 ? String(v).slice(0, 15) + '…' : v)} />
        <Tooltip content={<VizTooltip valueFormatter={valueFormatter} />} cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} />
        <Bar isAnimationActive={false} dataKey={valueKey} name={valueKey} fill="var(--viz-1)" barSize={16} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Single-series column chart over days or buckets. */
function Columns({ data, xKey, yKey, xFormatter, valueFormatter = fmtNum, height = 200, allTicks = false }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} tick={tick} axisLine={false} tickLine={false} tickFormatter={xFormatter}
          {...(allTicks ? { interval: 0 } : { minTickGap: 24 })} />
        <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={valueFormatter} width={44} />
        <Tooltip content={<VizTooltip labelFormatter={xFormatter} valueFormatter={valueFormatter} />} cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} />
        <Bar isAnimationActive={false} dataKey={yKey} name={yKey} fill="var(--viz-1)" maxBarSize={18} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ModelDonut({ byModel }) {
  const total = byModel.reduce((a, m) => a + m.sessions, 0)
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <PieChart width={200} height={200}>
          <Pie isAnimationActive={false} data={byModel} dataKey="sessions" nameKey="model" cx="50%" cy="50%"
            innerRadius={58} outerRadius={84} stroke="hsl(var(--background))" strokeWidth={2}>
            {byModel.map((m, i) => <Cell key={m.model} fill={VIZ[i % VIZ.length]} />)}
          </Pie>
          <Tooltip content={<VizTooltip />} />
        </PieChart>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-2xl font-semibold">{total}</div>
          <div className="text-xs text-muted-foreground">sessions</div>
        </div>
      </div>
      <ul className="text-xs space-y-1.5 min-w-0">
        {byModel.map((m, i) => (
          <li key={m.model} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: VIZ[i % VIZ.length] }} />
            <span className="truncate">{shortModel(m.model)}</span>
            <span className="text-muted-foreground tabular-nums ml-auto pl-2">{m.sessions}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TokensByModel({ byModel }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={byModel} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="model" tick={tick} axisLine={false} tickLine={false} tickFormatter={shortModel} interval={0} />
        <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmtNum} width={48} />
        <Tooltip content={<VizTooltip labelFormatter={shortModel} />} cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Bar isAnimationActive={false} dataKey="input_tokens" name="Input" stackId="t" fill="var(--viz-1)" maxBarSize={22}
          stroke="hsl(var(--background))" strokeWidth={1} />
        <Bar isAnimationActive={false} dataKey="output_tokens" name="Output" stackId="t" fill="var(--viz-2)" maxBarSize={22} radius={[4, 4, 0, 0]}
          stroke="hsl(var(--background))" strokeWidth={1} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState('30d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load(r) {
    setLoading(true)
    try {
      // Bring the session store up to date first (incremental, ~0.1 s when idle).
      await fetch('/api/sessions/ingest', { method: 'POST' }).catch(() => {})
      const res = await fetch(`/api/analytics?range=${r}`)
      setData(await res.json())
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load(range) }, [range]) // eslint-disable-line react-hooks/exhaustive-deps

  const s = data?.sessions
  const p = data?.portfolio

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="flex-none px-4 py-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors"><ArrowLeft className="h-5 w-5" /></Link>
            <h1 className="text-xl font-bold">Analytics</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load(range)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Reload
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Previous render held at reduced opacity while refetching — no skeleton flash */}
      <div className={`flex-1 overflow-auto p-4 space-y-6 transition-opacity ${loading && data ? 'opacity-60' : ''}`}>
        {!data && <p className="text-sm text-muted-foreground">Loading…</p>}

        {s && (
          <section>
            <div className="flex items-center gap-4 mb-3">
              <h2 className="text-base font-semibold">Agentic sessions</h2>
              {/* One filter row above everything it scopes (the session charts) */}
              <div className="flex rounded-md border overflow-hidden text-xs">
                {RANGES.map(([r, label]) => (
                  <button key={r} onClick={() => setRange(r)}
                    className={`px-2.5 py-1 transition-colors ${range === r ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">
              <StatTile label="Sessions" value={s.kpis.sessions} />
              <StatTile label="Cost (list price)" value={fmtCost(s.kpis.cost_usd)} />
              <StatTile label="Tokens in / out" value={`${fmtNum(s.kpis.input_tokens)} / ${fmtNum(s.kpis.output_tokens)}`} />
              <StatTile label="Avg active time" value={fmtMin(s.kpis.avg_active_s)} />
              <StatTile label="Tool calls" value={fmtNum(s.kpis.tool_calls)} />
              <StatTile label="Guard hits" value={s.kpis.guard_hits} />
              <StatTile label="Avg quality" value={s.kpis.avg_quality != null ? `${s.kpis.avg_quality}/100` : '—'} hint="heuristic" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              <Card title="Sessions per day">
                <Columns data={s.perDay} xKey="day" yKey="sessions" xFormatter={fmtDay} />
              </Card>
              <Card title="Cost per day" subtitle="list price, USD">
                <Columns data={s.perDay} xKey="day" yKey="cost_usd" xFormatter={fmtDay} valueFormatter={fmtCost} />
              </Card>
              <Card title="Model distribution" subtitle="sessions per model">
                <ModelDonut byModel={s.byModel} />
              </Card>
              <Card title="Input vs output tokens by model">
                <TokensByModel byModel={s.byModel} />
              </Card>
              <Card title="Top tools" subtitle="calls, all sessions in range">
                <HBar data={s.topTools} nameKey="tool" valueKey="count" />
              </Card>
              <Card title="Top skills" subtitle="invocations">
                <HBar data={s.topSkills} nameKey="skill" valueKey="count" />
              </Card>
              <Card title="Top projects by cost" subtitle="list price, USD">
                <HBar data={s.topProjects} nameKey="project" valueKey="cost_usd" valueFormatter={fmtCost} />
              </Card>
              <Card title="Quality score distribution" subtitle="heuristic, 0–100">
                <Columns data={s.quality} xKey="bucket" yKey="count" height={200} allTicks />
              </Card>
            </div>
          </section>
        )}

        {p && (
          <section>
            <h2 className="text-base font-semibold mb-3">Project portfolio</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
              <StatTile label="Projects" value={p.kpis.projects} />
              <StatTile label="Lines of code" value={fmtNum(p.kpis.total_code)} />
              <StatTile label="Estimated value" value={fmtCost(p.kpis.est_value)} hint="COCOMO" />
              <StatTile label="Dirty repos" value={p.kpis.dirty} />
              <StatTile label="AI cost (all time)" value={fmtCost(p.kpis.ai_cost)} hint="list price" />
              <StatTile label="AI sessions (ledger)" value={p.kpis.ai_sessions} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              <Card title="Projects by category" subtitle="AI analysis">
                <HBar data={p.byCategory} nameKey="category" valueKey="count" />
              </Card>
              <Card title="Top languages" subtitle="lines of code">
                <HBar data={p.topLanguages} nameKey="name" valueKey="code" />
              </Card>
              <Card title="Top projects by AI cost" subtitle="list price, USD, all time">
                <HBar data={p.topAiCost} nameKey="project" valueKey="cost_usd" valueFormatter={fmtCost} />
              </Card>
              <Card title="Projects by maturity" subtitle="AI analysis">
                <HBar data={p.byMaturity} nameKey="maturity" valueKey="count" />
              </Card>
              <Card title="Commit activity" subtitle="time since last commit">
                <Columns data={p.activity} xKey="bucket" yKey="count" height={200} allTicks />
              </Card>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
