'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isSameMonth, isToday } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  bannerIds, calendarFamilies, calendarSlot, colorBy, COLOR_MODES, DEFAULT_COLOR_MODE, daySegment,
  harnessBadge, layoutDay, periodLabel, periodStats, shiftPeriod,
} from '@/lib/cc/session-calendar.mjs'
import { SummaryBanner } from './summary-banner'
import { ColorLegend, ColorSelect } from './color-controls'
import { displayTitle, OUTCOME_ICON, parseSummary } from '@/lib/cc/summary-view.mjs'

const HOUR_PX = 44
const projectName = (dir) => (dir ? dir.split('/').filter(Boolean).at(-1) : '—')
const fmtCost = (c) => `$${(c || 0).toFixed(2)}`
const fmtHours = (s) => `${(s / 3600).toFixed(1)} h`

/**
 * `loadedKey`/`wantKey` (see loadKey): the families on hand may still be the
 * table's rows or the previous period while this one loads. Until the keys
 * match, stats and the banner stay empty so they never count what isn't shown.
 */
export function CalendarView({ families, range, loadedKey, wantKey, selected, onOpen, onNavigate, onSpan, onRefresh, colorMode = DEFAULT_COLOR_MODE, onColorMode }) {
  const [showAll, setShowAll] = useState(false)
  const events = useMemo(() => calendarFamilies(families, { showAll }), [families, showAll])
  const ready = loadedKey != null && loadedKey === wantKey
  const stats = ready ? periodStats(events.filter((e) => !e.muted)) : null
  const periodKey = `${range.since.toISOString()}|${range.until.toISOString()}`
  const missing = bannerIds({ loadedKey, wantKey, events })
  return (
    <div className="flex h-full min-w-0 flex-col">
      <PeriodHeader range={range} stats={stats} showAll={showAll} onShowAll={setShowAll} onNavigate={onNavigate} onSpan={onSpan}
        colorMode={colorMode} onColorMode={onColorMode} />
      <ColorLegend events={events} mode={colorMode} className="mb-2" />
      <SummaryBanner ids={missing} periodKey={periodKey} onProgress={onRefresh} />
      {range.span === 'week'
        ? <WeekGrid days={range.days} events={events} selected={selected} onOpen={onOpen} colorMode={colorMode} />
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
  const openWeek = (d) => onNavigate(d, 'week')

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
              <button onClick={() => openWeek(d)} className={`flex-none rounded px-1 hover:bg-muted ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'd')}</button>
              {hours > 0 && <span className="truncate tabular-nums text-muted-foreground">{hours.toFixed(1)} h</span>}
            </div>
            <div className="space-y-0.5">
              {list.slice(0, CHIPS_PER_DAY).map((e) => (
                <EventBlock key={e.session_id} e={e} compact colorMode={colorMode} selected={selected === e.session_id} onOpen={onOpen} />
              ))}
              {list.length > CHIPS_PER_DAY && (
                <button onClick={() => openWeek(d)} className="text-[11px] text-muted-foreground hover:text-foreground">+{list.length - CHIPS_PER_DAY} more</button>
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

function PeriodHeader({ range, stats, showAll, onShowAll, onNavigate, onSpan, colorMode, onColorMode }) {
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
        {['week', 'month'].map((s) => (
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
      <span className="ml-auto"><ColorSelect value={colorMode} onChange={onColorMode} /></span>
      <button onClick={() => onShowAll(!showAll)} aria-pressed={showAll}
        className={`rounded-full border px-2 py-0.5 text-xs ${showAll ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title="Also show agent spawns, scheduled runs and trivial sessions (muted)">+ agent/scheduled</button>
    </div>
  )
}

function WeekGrid({ days, events, selected, onOpen, colorMode }) {
  const scroller = useRef(null)
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX }, [])
  const perDay = useMemo(() => days.map((day) => {
    const segs = []
    for (const e of events) {
      const slot = calendarSlot(e)
      const seg = slot && daySegment(slot, day)
      if (seg) segs.push({ ...seg, e })
    }
    const lay = layoutDay(segs.map((s) => ({ id: s.e.session_id, start: s.top, end: s.top + s.height })))
    return segs.map((s) => ({ ...s, ...lay.get(s.e.session_id) }))
  }), [days, events])

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border">
      <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b text-xs">
        <div />
        {days.map((d) => (
          <div key={+d} className={`px-1 py-1 text-center ${isToday(d) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{format(d, 'EEE d.M.')}</div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ top: h * HOUR_PX }}>{h ? `${h}:00` : ''}</div>
            ))}
          </div>
          {perDay.map((segs, i) => (
            <div key={+days[i]} className={`relative border-l ${isToday(days[i]) ? 'bg-muted/30' : ''}`}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-border/50" style={{ top: h * HOUR_PX }} />)}
              {segs.map((s) => (
                <EventBlock key={s.e.session_id} e={s.e} colorMode={colorMode} selected={selected === s.e.session_id} onOpen={onOpen}
                  style={{ top: (s.top / 60) * HOUR_PX, height: Math.max((s.height / 60) * HOUR_PX - 1, 14), left: `calc(${(s.col / s.cols) * 100}% + 1px)`, width: `calc(${100 / s.cols}% - 2px)` }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function HarnessBadge({ e }) {
  const b = harnessBadge(e)
  return <span title={b.label} className="inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm bg-foreground/10 text-[9px] font-bold">{b.letter}</span>
}

function OutcomeMark({ e }) {
  const sum = parseSummary(e)
  if (!sum) return <span title="No summary" className="inline-block h-1.5 w-1.5 flex-none rounded-full bg-muted-foreground" />
  return <span title={sum.outcome} className="flex-none">{OUTCOME_ICON[sum.outcome] || ''}</span>
}

export function EventBlock({ e, style, selected, onOpen, compact = false, colorMode = DEFAULT_COLOR_MODE }) {
  const title = displayTitle(e) || 'Untitled session'
  const bucket = colorBy(e, colorMode)
  const color = bucket.color
  const r = e.rollup || e
  const mins = Math.round((r.active_s || 0) / 60)
  const tip = `${title}\n${projectName(e.project_dir)} · ${format(new Date(e.started_at), 'HH:mm')} · ${mins} min active · ${fmtCost(r.cost_usd)}${e.sub_count ? ` · +${e.sub_count} sub` : ''}\n${COLOR_MODES[colorMode]?.label}: ${bucket.label}`
  return (
    <button onClick={() => onOpen(e.session_id)} title={tip}
      className={`${compact ? 'relative w-full' : 'absolute'} overflow-hidden rounded-sm border-l-4 px-1 py-0.5 text-left text-[11px] leading-tight hover:z-10 hover:shadow ${e.muted ? 'opacity-50' : ''} ${selected ? 'ring-2 ring-ring' : ''}`}
      style={{ ...style, borderLeftColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
      <div className="flex items-center gap-1 font-medium">
        <HarnessBadge e={e} />
        <span className="truncate">{title}</span>
        <OutcomeMark e={e} />
      </div>
      {!compact && <div className="truncate text-muted-foreground">{projectName(e.project_dir)} · {mins} min · {fmtCost(r.cost_usd)}</div>}
    </button>
  )
}
