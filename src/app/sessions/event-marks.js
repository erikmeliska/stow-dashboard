'use client'

import { format } from 'date-fns'
import { colorBy, COLOR_MODES, harnessBadge } from '@/lib/cc/session-calendar.mjs'
import { displayTitle, OUTCOME_ICON, parseSummary } from '@/lib/cc/summary-view.mjs'
import { sessionProjectLabel } from '@/lib/cc/session-project.mjs'
import { formatWorkspace } from '@/lib/cc/workspace.mjs'

// Small session marks shared by the week grid, the month grid and the day timeline.

export const DOT_PX = 9
export const fmtCost = (c) => `$${(c || 0).toFixed(2)}`

export function HarnessBadge({ e }) {
  const b = harnessBadge(e)
  return <span title={b.label} className="inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm bg-foreground/10 text-[9px] font-bold">{b.letter}</span>
}

export function OutcomeMark({ e }) {
  const sum = parseSummary(e)
  if (!sum) return <span title="No summary" className="inline-block h-1.5 w-1.5 flex-none rounded-full bg-muted-foreground" />
  return <span title={sum.outcome} className="flex-none">{OUTCOME_ICON[sum.outcome] || ''}</span>
}

export function eventTip(e, title, bucket, colorMode) {
  const r = e.rollup || e
  const mins = Math.round((r.active_s || 0) / 60)
  return `${title}\n${sessionProjectLabel(e)}${e.workspace ? ` · ${formatWorkspace(e.workspace)}` : ''} · ${format(new Date(e.started_at), 'HH:mm')} · ${mins} min active · ${fmtCost(r.cost_usd)}${e.sub_count ? ` · +${e.sub_count} sub` : ''}\n${COLOR_MODES[colorMode]?.label}: ${bucket.label}`
}

/**
 * A session with ~no active time: a dot at its start time instead of a 15-min
 * block. `inline` = a row in a cluster's session list (dot + title), still a dot.
 */
export function EventDot({ e, style, selected, onOpen, colorMode, inline = false }) {
  const title = displayTitle(e) || 'Untitled session'
  const bucket = colorBy(e, colorMode)
  if (inline) {
    return (
      <button onClick={() => onOpen(e.session_id)} title={eventTip(e, title, bucket, colorMode)}
        className={`flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-muted ${e.muted ? 'opacity-50' : ''} ${selected ? 'ring-2 ring-ring' : ''}`}>
        <span className="flex-none rounded-full ring-1 ring-background" style={{ width: DOT_PX, height: DOT_PX, background: bucket.color }} aria-hidden />
        <span className="truncate">{title}</span>
      </button>
    )
  }
  return (
    <button onClick={() => onOpen(e.session_id)} title={eventTip(e, title, bucket, colorMode)} aria-label={title}
      className={`absolute z-[5] rounded-full ring-1 ring-background hover:z-10 hover:scale-150 ${e.muted ? 'opacity-50' : ''} ${selected ? 'outline outline-2 outline-ring' : ''}`}
      style={{ ...style, width: DOT_PX, height: DOT_PX, background: bucket.color }} />
  )
}
