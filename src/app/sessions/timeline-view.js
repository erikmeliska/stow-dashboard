'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { format, isToday } from 'date-fns'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { colorBy, COLOR_MODES } from '@/lib/cc/session-calendar.mjs'
import { buildTimeline, concurrencyProfile, timelineBars, timeWindow } from '@/lib/cc/session-timeline.mjs'
import { displayTitle } from '@/lib/cc/summary-view.mjs'
import { DOT_PX, EventDot, eventTip, fmtCost, HarnessBadge, OutcomeMark } from './event-marks'

const HOUR_W = 72 // min px per hour; the axis stretches to the available width
const LABEL_W = 224
const BAR_H = 16
const SUB_H = 3
const TRACK_H = BAR_H + SUB_H + 4
const DEPTHS = [['workspace', 'Workspaces'], ['project', 'Projects'], ['client', 'Clients']]

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`

/**
 * Day view (#31): time runs left → right, one swimlane per workspace, grouped
 * client → project → workspace. Client and project rows show how many sessions
 * ran at once (a step chart, peak in the label), so a collapsed group still
 * reads. Bars follow the week view's placement and the shared Color by.
 */
export function DayTimeline({ day, events, ready = true, selected, onOpen, colorMode }) {
  const clients = useMemo(() => buildTimeline(events, day), [events, day])
  const bars = useMemo(() => timelineBars(events, day), [events, day])
  const win = useMemo(() => timeWindow(bars), [bars])
  const dayPeak = useMemo(() => concurrencyProfile(bars.filter((b) => !b.e.muted)), [bars])
  const scale = Math.max(1, ...clients.map((c) => c.peak))
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [depth, setDepth] = useState('workspace')
  useEffect(() => { setCollapsed(new Set()); setDepth('workspace') }, [day])

  const x0 = win.startHour * 60
  const width = (win.endHour - win.startHour) * 60
  const pos = (start, end) => ({ left: `${((start - x0) / width) * 100}%`, width: `${(Math.max(end - start, 0) / width) * 100}%` })
  const now = isToday(day) ? (Date.now() - day.getTime()) / 60000 : null
  const hours = Array.from({ length: win.endHour - win.startHour }, (_, i) => win.startHour + i)
  const grid = { backgroundImage: 'linear-gradient(to right, hsl(var(--border) / 0.6) 1px, transparent 1px)', backgroundSize: `${100 / hours.length}% 100%` }

  const isOpen = (k, level) => {
    const byDepth = level === 'client' ? depth !== 'client' : depth === 'workspace'
    return collapsed.has(k) ? !byDepth : byDepth
  }
  const toggle = (k) => setCollapsed((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  const pickDepth = (d) => { setDepth(d); setCollapsed(new Set()) }
  const peakAt = dayPeak.steps.find((s) => s.count === dayPeak.peak)

  if (!clients.length) {
    // While another period's rows are still on hand (`ready` false), say nothing rather than "no sessions".
    return ready ? <p className="py-6 text-sm text-muted-foreground">No sessions on this day with the current filters.</p> : null
  }

  const nowLeft = now != null && now >= x0 && now <= x0 + width ? `${((now - x0) / width) * 100}%` : null
  const area = { grid, nowLeft }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 pb-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          Peak <span className="font-semibold text-foreground">{dayPeak.peak}</span> session{dayPeak.peak === 1 ? '' : 's'} at once
          {peakAt && <> ({hhmm(peakAt.start)}–{hhmm(peakAt.end)})</>}
        </span>
        <span className="inline-flex items-center gap-1">
          Show
          <span className="inline-flex rounded-md border p-0.5">
            {DEPTHS.map(([d, label]) => (
              <button key={d} onClick={() => pickDepth(d)} aria-pressed={depth === d}
                className={`rounded px-2 py-0.5 text-xs ${depth === d ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
            ))}
          </span>
        </span>
        <span>Rows: client → project → workspace · grey steps = sessions running at once</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <div className="grid" style={{ gridTemplateColumns: `${LABEL_W}px minmax(${hours.length * HOUR_W}px, 1fr)` }}>
          <div className="sticky left-0 top-0 z-30 border-b border-r bg-background px-2 py-1 text-xs text-muted-foreground">{format(day, 'EEE d.M.')}</div>
          <div className="sticky top-0 z-20 h-6 border-b bg-background text-[10px] text-muted-foreground">
            {hours.map((h, i) => <span key={h} className="absolute -translate-x-1/2 tabular-nums first:translate-x-0" style={{ left: `${(i / hours.length) * 100}%`, top: 5 }}>{h}:00</span>)}
          </div>

          {clients.map((c) => {
            const ck = `c:${c.id}`
            const cOpen = isOpen(ck, 'client')
            return (
              <Fragment key={ck}>
                <GroupLabel level={0} open={cOpen} onToggle={() => toggle(ck)} name={c.name} muted={c.unassigned} stats={c.stats} peak={c.peak} />
                <Area {...area} height={26} className="bg-muted/40"><Profile steps={c.profile} scale={scale} pos={pos} /></Area>
                {cOpen && c.projects.map((p) => {
                  const pk = `p:${c.id}|${p.key}`
                  const pOpen = isOpen(pk, 'project')
                  const lanes = p.lanes.length
                  return (
                    <Fragment key={pk}>
                      <GroupLabel level={1} open={pOpen} onToggle={() => toggle(pk)} name={p.name} title={p.key} stats={p.stats} peak={p.peak}
                        extra={`${lanes} workspace${lanes === 1 ? '' : 's'}`} />
                      <Area {...area} height={24} className="bg-muted/15"><Profile steps={p.profile} scale={scale} pos={pos} /></Area>
                      {pOpen && p.lanes.map((l) => (
                        <Fragment key={`${pk}|${l.workspace || ''}`}>
                          <div className="sticky left-0 z-10 flex items-start truncate border-b border-r border-border/50 bg-background py-1 pl-10 pr-2 text-[11px] text-muted-foreground" title={l.workspace || 'main checkout'}>
                            <span className="truncate">{l.label}</span>
                          </div>
                          <Area {...area} height={l.tracks.length * TRACK_H + 2}>
                            {l.tracks.map((track, ti) => track.map((b) => (
                              <Bar key={b.id} b={b} top={ti * TRACK_H + 2} pos={pos} colorMode={colorMode} selected={selected} onOpen={onOpen} />
                            )))}
                          </Area>
                        </Fragment>
                      ))}
                    </Fragment>
                  )
                })}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The time column of one row: hour grid, its content and the now-line. */
function Area({ children, height, className = '', grid, nowLeft }) {
  return (
    <div className={`relative border-b border-border/50 ${className}`} style={{ ...grid, height }}>
      {children}
      {nowLeft && <div className="pointer-events-none absolute inset-y-0 w-px bg-red-500/70" style={{ left: nowLeft }} />}
    </div>
  )
}

function GroupLabel({ level, open, onToggle, name, title, muted = false, stats, peak, extra }) {
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <button onClick={onToggle} aria-expanded={open} title={title || name}
      className={`sticky left-0 z-10 flex min-w-0 flex-col items-start border-b border-r bg-background py-0.5 pr-2 text-left hover:bg-muted ${level === 0 ? 'pl-1 font-semibold' : 'pl-5 font-medium'}`}>
      <span className={`flex w-full min-w-0 items-center gap-1 text-xs ${muted ? 'text-muted-foreground' : ''}`}>
        <Icon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        <span className="truncate">{name}</span>
        <span className="ml-auto flex-none rounded bg-muted px-1 text-[10px] font-normal tabular-nums text-muted-foreground" title="Most sessions running at once">×{peak}</span>
      </span>
      <span className="truncate pl-4 text-[10px] font-normal tabular-nums text-muted-foreground">
        {stats.sessions} session{stats.sessions === 1 ? '' : 's'} · {fmtCost(stats.cost_usd)}{extra ? ` · ${extra}` : ''}
      </span>
    </button>
  )
}

/** Sessions running at once as a step chart, on one scale for the whole day so rows compare. */
function Profile({ steps, scale, pos }) {
  return (
    <div className="absolute inset-x-0 bottom-0 top-1">
      {steps.map((s, i) => (
        <div key={i} className="absolute bottom-0 bg-foreground/25" title={`${s.count} at once · ${hhmm(s.start)}–${hhmm(s.end)}`}
          style={{ ...pos(s.start, s.end), height: `${(s.count / scale) * 100}%` }} />
      ))}
    </div>
  )
}

/** One session: a bar (or a dot for a zero-minute one), with its linked children and subagents as thin strips under it. */
function Bar({ b, top, pos, colorMode, selected, onOpen }) {
  const e = b.e
  const subs = b.subs.map((s) => (
    <div key={`${s.kind}:${s.id}`} className={`absolute rounded-full ${s.kind === 'child' ? 'bg-amber-500/80' : 'bg-foreground/40'}`}
      title={s.kind === 'child' ? `Linked ${s.row.kind || 'session'} · ${hhmm(s.start)}` : `Subagent${s.row.agent_type ? ` ${s.row.agent_type}` : ''} · ${hhmm(s.start)}`}
      style={{ ...pos(s.start, s.point ? s.start + 3 : s.end), minWidth: 3, top: top + BAR_H + 1, height: SUB_H }} />
  ))
  if (b.point) {
    return (<>
      <EventDot e={e} colorMode={colorMode} selected={selected === e.session_id} onOpen={onOpen}
        style={{ left: `calc(${pos(b.start, b.start).left} - ${DOT_PX / 2}px)`, top: top + (BAR_H - DOT_PX) / 2 }} />
      {subs}
    </>)
  }
  const title = displayTitle(e) || 'Untitled session'
  const bucket = colorBy(e, colorMode)
  return (<>
    <button onClick={() => onOpen(e.session_id)} title={`${eventTip(e, title, bucket, colorMode)}${b.continued ? '\nStarted the day before' : ''}`}
      className={`absolute flex items-center gap-1 overflow-hidden whitespace-nowrap border-l-4 px-0.5 text-left text-[11px] leading-none hover:z-10 hover:shadow ${b.continued ? 'rounded-r-sm' : 'rounded-sm'} ${e.muted ? 'opacity-50' : ''} ${selected === e.session_id ? 'z-10 ring-2 ring-ring' : ''}`}
      style={{ ...pos(b.start, b.end), minWidth: 4, top, height: BAR_H, borderLeftColor: bucket.color, background: `color-mix(in srgb, ${bucket.color} 22%, transparent)` }}
      aria-label={`${title} — ${COLOR_MODES[colorMode]?.label}: ${bucket.label}`}>
      <HarnessBadge e={e} />
      <span className="truncate">{title}</span>
      <OutcomeMark e={e} />
    </button>
    {subs}
  </>)
}
