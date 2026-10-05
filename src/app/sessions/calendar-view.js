'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isSameMonth, isToday } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  absorbPoints, bannerIds, calendarFamilies, calendarSlot, clusterColor, clusterDay, clusterStats, colorBy, COLOR_MODES,
  DEFAULT_COLOR_MODE, DEFAULT_MERGE, daySegment, layoutDay, layoutPoints, MAX_COLS, MERGE_MODES, periodLabel,
  periodStats, shiftPeriod, workspaceLanes,
} from '@/lib/cc/session-calendar.mjs'
import { SummaryBanner } from './summary-banner'
import { DayTimeline } from './timeline-view'
import { ColorLegend, ColorSelect } from './color-controls'
import { displayTitle } from '@/lib/cc/summary-view.mjs'
import { sessionProjectLabel } from '@/lib/cc/session-project.mjs'
import { WorkspaceBadge } from './workspace-badge'
import { DOT_PX, EventDot, eventTip, fmtCost, HarnessBadge, OutcomeMark } from './event-marks'

const HOUR_PX = 44
const fmtHours = (s) => `${(s / 3600).toFixed(1)} h`
const MERGE_KEY = 'stow.calendar.mergeBy'
const MERGE_LABEL = { project: 'Project', client: 'Client', none: 'None' }

/**
 * Week-view merge level for concurrent sessions (#30). Per-viewer preference in
 * localStorage, read after mount so the server render stays stable. Its own key:
 * `stow.calendar.colorBy` holds the Color by choice.
 */
function useMergeMode() {
  const [mode, setMode] = useState(DEFAULT_MERGE)
  useEffect(() => {
    try { const v = localStorage.getItem(MERGE_KEY); if (MERGE_MODES.includes(v)) setMode(v) } catch { /* storage blocked */ }
  }, [])
  function pick(v) {
    setMode(v)
    try { localStorage.setItem(MERGE_KEY, v) } catch { /* storage blocked */ }
  }
  return [mode, pick]
}

/**
 * `loadedKey`/`wantKey` (see loadKey): the families on hand may still be the
 * table's rows or the previous period while this one loads. Until the keys
 * match, stats and the banner stay empty so they never count what isn't shown.
 */
export function CalendarView({ families, range, loadedKey, wantKey, selected, onOpen, onNavigate, onSpan, onRefresh, colorMode = DEFAULT_COLOR_MODE, onColorMode }) {
  const [showAll, setShowAll] = useState(false)
  const [mergeBy, setMergeBy] = useMergeMode()
  const events = useMemo(() => calendarFamilies(families, { showAll }), [families, showAll])
  const ready = loadedKey != null && loadedKey === wantKey
  const stats = ready ? periodStats(events.filter((e) => !e.muted)) : null
  const periodKey = `${range.since.toISOString()}|${range.until.toISOString()}`
  const missing = bannerIds({ loadedKey, wantKey, events })
  return (
    <div className="flex h-full min-w-0 flex-col">
      <PeriodHeader range={range} stats={stats} showAll={showAll} onShowAll={setShowAll} onNavigate={onNavigate} onSpan={onSpan}
        colorMode={colorMode} onColorMode={onColorMode} mergeBy={mergeBy} onMergeBy={setMergeBy} />
      <ColorLegend events={events} mode={colorMode} className="mb-2" />
      <SummaryBanner ids={missing} periodKey={periodKey} onProgress={onRefresh} />
      {range.span === 'day'
        ? <DayTimeline day={range.since} events={events} ready={ready} selected={selected} onOpen={onOpen} colorMode={colorMode} />
        : range.span === 'week'
        ? <WeekGrid days={range.days} events={events} selected={selected} onOpen={onOpen} onNavigate={onNavigate} colorMode={colorMode} mergeBy={mergeBy} />
        : <MonthGrid range={range} events={events} selected={selected} onOpen={onOpen} onNavigate={onNavigate} colorMode={colorMode} />}
    </div>
  )
}

const CHIPS_PER_DAY = 4

function MonthGrid({ range, events, selected, onOpen, onNavigate, colorMode }) {
  const byDay = useMemo(() => {
    const m = new Map()
    for (const e of events) {
      const slot = calendarSlot(e)
      if (!slot) continue
      const k = format(slot.start, 'yyyy-MM-dd')
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(e)
    }
    for (const list of m.values()) list.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    return m
  }, [events])
  const openDay = (d) => onNavigate(d, 'day')

  // The scroll lives on a wrapper, not on the grid: a grid that is itself the
  // flex-item scroll container gets its rows stretched evenly instead of sized
  // to their content, and chips then draw over the next week. The min width
  // keeps cells legible in a narrow window (scroll sideways instead); the
  // weekday header sits in the same box so its columns always line up.
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border">
      <div className="min-w-[36rem]">
      <div className="sticky top-0 z-20 grid grid-cols-7 bg-background">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b px-1 py-1 text-center text-xs text-muted-foreground">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 auto-rows-[minmax(6rem,auto)]">
      {range.days.map((d) => {
        const inMonth = isSameMonth(d, range.since)
        const list = inMonth ? byDay.get(format(d, 'yyyy-MM-dd')) || [] : []
        const work = list.filter((e) => !e.muted)
        const hours = work.reduce((a, e) => a + ((e.rollup || e).active_s || 0), 0) / 3600
        const heat = Math.min(hours / 8, 1) * 18
        return (
          <div key={+d} className={`min-w-0 border-b border-l p-1 ${inMonth ? '' : 'opacity-40'}`}
            style={hours > 0 ? { background: `color-mix(in srgb, var(--viz-1) ${heat}%, transparent)` } : undefined}>
            <div className="mb-0.5 flex min-w-0 items-center justify-between gap-1 whitespace-nowrap text-[11px]">
              <button onClick={() => openDay(d)} title="Open the day timeline" className={`flex-none rounded px-1 hover:bg-muted ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'd')}</button>
              {hours > 0 && <span className="truncate tabular-nums text-muted-foreground">{hours.toFixed(1)} h</span>}
            </div>
            <div className="space-y-0.5">
              {list.slice(0, CHIPS_PER_DAY).map((e) => (
                <EventBlock key={e.session_id} e={e} compact colorMode={colorMode} selected={selected === e.session_id} onOpen={onOpen} />
              ))}
              {list.length > CHIPS_PER_DAY && (
                <button onClick={() => openDay(d)} className="text-[11px] text-muted-foreground hover:text-foreground">+{list.length - CHIPS_PER_DAY} more</button>
              )}
            </div>
          </div>
        )
      })}
      </div>
      </div>
    </div>
  )
}

function PeriodHeader({ range, stats, showAll, onShowAll, onNavigate, onSpan, colorMode, onColorMode, mergeBy, onMergeBy }) {
  const doneShare = stats?.described ? Math.round((stats.done / stats.described) * 100) : null
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" aria-label="Previous" onClick={() => onNavigate(shiftPeriod(range.since, range.span, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="sm" onClick={() => onNavigate(new Date())}>Today</Button>
        <Button variant="outline" size="sm" aria-label="Next" onClick={() => onNavigate(shiftPeriod(range.since, range.span, 1))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
      <h2 className="text-sm font-semibold">{periodLabel(range)}</h2>
      <div className="inline-flex rounded-md border p-0.5">
        {['day', 'week', 'month'].map((s) => (
          <button key={s} onClick={() => onSpan(s)} aria-pressed={range.span === s}
            className={`rounded px-2 py-0.5 text-xs capitalize ${range.span === s ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{s}</button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {stats ? <>
          {stats.sessions} sessions · {fmtHours(stats.active_s)} active · {fmtCost(stats.cost_usd)}
          {doneShare != null && ` · ${doneShare}% done, ${stats.partial} partial`}
        </> : 'Loading…'}
      </span>
      {range.span === 'week' && (
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground"
          title="Merge overlapping sessions of one project or client into one block">
          Merge
          <span className="inline-flex rounded-md border p-0.5">
            {MERGE_MODES.map((m) => (
              <button key={m} onClick={() => onMergeBy(m)} aria-pressed={mergeBy === m}
                className={`rounded px-2 py-0.5 text-xs ${mergeBy === m ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{MERGE_LABEL[m]}</button>
            ))}
          </span>
        </span>
      )}
      <span className={range.span === 'week' ? '' : 'ml-auto'}><ColorSelect value={colorMode} onChange={onColorMode} /></span>
      <button onClick={() => onShowAll(!showAll)} aria-pressed={showAll}
        className={`rounded-full border px-2 py-0.5 text-xs ${showAll ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title="Also show agent spawns, scheduled runs and trivial sessions (muted)">+ agent/scheduled</button>
    </div>
  )
}

function WeekGrid({ days, events, selected, onOpen, onNavigate, colorMode, mergeBy }) {
  const scroller = useRef(null)
  const [pop, setPop] = useState(null)
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX }, [])
  useEffect(() => { setPop(null) }, [days, events, mergeBy])
  const perDay = useMemo(() => days.map((day) => {
    const segs = [], points = []
    for (const e of events) {
      const slot = calendarSlot(e)
      const seg = slot && daySegment(slot, day)
      if (seg) (seg.point ? points : segs).push({ ...seg, e })
    }
    // Dots take no height and stay out of the column layout: one inside a same-key
    // cluster/block is counted there (absorbPoints), the rest only dodge each other.
    const absorbed = absorbPoints(clusterDay(segs, mergeBy), points, mergeBy)
    const items = absorbed.items
    const { placed, overflow } = layoutDay(items, { maxCols: MAX_COLS })
    const byId = new Map(items.map((it) => [it.id, it]))
    const dots = layoutPoints(absorbed.points.map((p) => ({ id: p.e.session_id, top: p.top })), (DOT_PX / HOUR_PX) * 60)
    return {
      items: items.filter((it) => placed.has(it.id)).map((it) => ({ ...it, ...placed.get(it.id) })),
      overflow: overflow.map((o) => ({ ...o, events: o.ids.flatMap((id) => byId.get(id).segs.map((sg) => sg.e)) })),
      points: absorbed.points.map((p) => ({ ...p, slot: dots.get(p.e.session_id) })),
    }
  }), [days, events, mergeBy])

  const box = (it) => ({
    top: (it.start / 60) * HOUR_PX,
    height: Math.max(((it.end - it.start) / 60) * HOUR_PX - 1, 14),
    left: `calc(${(it.col / it.cols) * 100}% + 1px)`,
    width: `calc(${100 / it.cols}% - 2px)`,
  })
  const openPop = (dayIndex, it, title, list) => setPop((p) => (p?.id === it.id && p.dayIndex === dayIndex ? null : {
    id: it.id, dayIndex, top: (it.start / 60) * HOUR_PX, col: it.col, cols: it.cols, title,
    events: [...list].sort((x, y) => String(x.started_at).localeCompare(String(y.started_at))),
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border">
      <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b text-xs">
        <div />
        {days.map((d) => (
          <button key={+d} onClick={() => onNavigate(d, 'day')} title="Open the day timeline"
            className={`px-1 py-1 text-center hover:bg-muted hover:text-foreground ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'EEE d.M.')}</button>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ top: h * HOUR_PX }}>{h ? `${h}:00` : ''}</div>
            ))}
          </div>
          {perDay.map(({ items, overflow, points }, i) => (
            <div key={+days[i]} className={`relative border-l ${isToday(days[i]) ? 'bg-muted/30' : ''}`}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-border/50" style={{ top: h * HOUR_PX }} />)}
              {items.map((it) => (it.segs.length === 1
                ? <EventBlock key={it.id} e={it.segs[0].e} colorMode={colorMode} selected={selected === it.id} onOpen={onOpen} style={box(it)} />
                : <ClusterBlock key={it.id} item={it} mergeBy={mergeBy} colorMode={colorMode} selected={selected} style={box(it)}
                    open={pop?.id === it.id && pop.dayIndex === i}
                    onExpand={(title) => openPop(i, it, title, it.segs.map((sg) => sg.e))} />))}
              {overflow.map((o) => (
                <button key={o.id} style={box(o)} aria-expanded={pop?.id === o.id && pop.dayIndex === i}
                  onClick={() => openPop(i, o, `${o.events.length} more sessions`, o.events)}
                  title={`${o.events.length} more overlapping sessions — click to list them`}
                  className={`absolute flex items-start justify-center overflow-hidden rounded-sm border border-dashed bg-muted/60 px-0.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:z-10 hover:bg-muted hover:text-foreground ${o.events.some((e) => e.session_id === selected) ? 'ring-2 ring-ring' : ''}`}>
                  +{o.events.length}
                </button>
              ))}
              {points.map((p) => (
                <EventDot key={p.e.session_id} e={p.e} colorMode={colorMode} selected={selected === p.e.session_id} onOpen={onOpen}
                  style={{ top: (p.top / 60) * HOUR_PX - DOT_PX / 2, right: 2 + p.slot * (DOT_PX + 2) }} />
              ))}
              {pop?.dayIndex === i && (
                <SessionPopover pop={pop} alignRight={i >= 4} colorMode={colorMode} selected={selected}
                  onClose={() => setPop(null)} onOpen={(id) => { setPop(null); onOpen(id) }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Overlapping sessions of one project (or client) as one block: label, count
 * and cost, coloured by the members' majority Color by bucket (striped when
 * there is none), with one thin lane per workspace showing when each ran.
 */
function ClusterBlock({ item, mergeBy, colorMode, selected, style, open, onExpand }) {
  const members = item.segs.map((sg) => sg.e)
  const first = members[0]
  const label = mergeBy === 'client' ? (first.client_id ? first.client_name || first.client_id : 'Unassigned') : sessionProjectLabel(first)
  const stats = clusterStats(members)
  const tone = clusterColor(members, colorMode)
  const lanes = workspaceLanes(item.segs, item.start, item.end)
  const muted = members.every((e) => e.muted)
  const bg = tone.mixed
    ? `repeating-linear-gradient(135deg, ${tone.colors.map((c, k) => `color-mix(in srgb, ${c} 22%, transparent) ${k * 6}px ${(k + 1) * 6}px`).join(', ')})`
    : `color-mix(in srgb, ${tone.color} 16%, transparent)`
  const span = `${format(new Date(Math.min(...members.map((e) => Date.parse(e.started_at)))), 'HH:mm')}`
  const tip = `${label} · ${stats.sessions} sessions in ${lanes.length} workspace${lanes.length === 1 ? '' : 's'} · from ${span} · ${fmtCost(stats.cost_usd)}\n${COLOR_MODES[colorMode]?.label}: ${tone.label}\nClick to list the sessions`
  return (
    <button onClick={() => onExpand(`${label} · ${stats.sessions} sessions · ${fmtCost(stats.cost_usd)}`)} title={tip} aria-expanded={open}
      className={`absolute flex flex-col justify-start overflow-hidden rounded-sm border-l-4 py-0.5 pl-1 text-left text-[11px] leading-tight hover:z-10 hover:shadow ${muted ? 'opacity-50' : ''} ${members.some((e) => e.session_id === selected) || open ? 'ring-2 ring-ring' : ''}`}
      style={{ ...style, borderLeftColor: tone.color, background: bg }}>
      <div className="pointer-events-none absolute inset-0.5 flex gap-px opacity-30" aria-hidden>
        {lanes.map((l) => (
          <div key={l.workspace || 'main'} className="relative min-w-0 flex-1" style={{ maxWidth: 6 }}>
            {l.spans.map((sp, k) => (
              <div key={k} className={`absolute inset-x-0 rounded-full ${sp.point ? 'aspect-square -translate-y-1/2' : ''}`}
                style={{ top: `${sp.top * 100}%`, height: sp.point ? undefined : `max(${sp.height * 100}%, 2px)`, background: tone.color }} />
            ))}
          </div>
        ))}
      </div>
      <div className="relative truncate pr-1 font-medium">{label}</div>
      <div className="relative truncate pr-1 text-muted-foreground tabular-nums">{stats.sessions} sessions · {fmtCost(stats.cost_usd)}</div>
    </button>
  )
}

/** The sessions behind a cluster or a "+N" chip; closes on Escape, an outside click or opening one. */
function SessionPopover({ pop, alignRight, colorMode, selected, onClose, onOpen }) {
  const ref = useRef(null)
  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
    const onDown = (ev) => { if (ref.current && !ref.current.contains(ev.target) && !ev.target.closest?.('[aria-expanded="true"]')) onClose() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [onClose])
  const side = alignRight
    ? { right: `calc(${(1 - (pop.col + 1) / pop.cols) * 100}% + 1px)` }
    : { left: `calc(${(pop.col / pop.cols) * 100}% + 1px)` }
  return (
    <div ref={ref} role="dialog" aria-label={pop.title}
      className="absolute z-30 w-64 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg"
      style={{ top: pop.top, ...side }}>
      <div className="mb-1 truncate px-0.5 text-xs font-medium">{pop.title}</div>
      <div className="max-h-80 space-y-0.5 overflow-y-auto">
        {pop.events.map((e) => (
          <div key={e.session_id} className="flex items-center gap-1">
            <span className="w-9 flex-none text-[10px] tabular-nums text-muted-foreground">{format(new Date(e.started_at), 'HH:mm')}</span>
            <div className="min-w-0 flex-1">
              {calendarSlot(e)?.point
                ? <EventDot e={e} inline colorMode={colorMode} selected={selected === e.session_id} onOpen={onOpen} />
                : <EventBlock e={e} compact colorMode={colorMode} selected={selected === e.session_id} onOpen={onOpen} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function EventBlock({ e, style, selected, onOpen, compact = false, colorMode = DEFAULT_COLOR_MODE }) {
  const title = displayTitle(e) || 'Untitled session'
  const bucket = colorBy(e, colorMode)
  const color = bucket.color
  const r = e.rollup || e
  const mins = Math.round((r.active_s || 0) / 60)
  const tip = eventTip(e, title, bucket, colorMode)
  return (
    <button onClick={() => onOpen(e.session_id)} title={tip}
      className={`${compact ? 'relative w-full' : 'absolute'} overflow-hidden rounded-sm border-l-4 px-1 py-0.5 text-left text-[11px] leading-tight hover:z-10 hover:shadow ${e.muted ? 'opacity-50' : ''} ${selected ? 'ring-2 ring-ring' : ''}`}
      style={{ ...style, borderLeftColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
      <div className="flex items-center gap-1 font-medium">
        <HarnessBadge e={e} />
        <span className="truncate">{title}</span>
        <OutcomeMark e={e} />
      </div>
      {!compact && <div className="truncate text-muted-foreground">{sessionProjectLabel(e)} <WorkspaceBadge workspace={e.workspace} className="ml-1" /> · {mins} min · {fmtCost(r.cost_usd)}</div>}
    </button>
  )
}
