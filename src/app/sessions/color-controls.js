'use client'

import { useEffect, useState } from 'react'
import { colorLegend, COLOR_MODES } from '@/lib/cc/session-calendar.mjs'

const COLOR_KEY = 'stow.calendar.colorBy'

/**
 * "Color by" choice shared by the table and the calendar. Per-viewer
 * preference in localStorage, read after mount so the server render stays stable.
 * The mode is null while the viewer has never picked one — the caller then
 * falls back to `defaultColorMode(shown events)`; a stored pick always wins.
 */
export function useColorMode() {
  const [mode, setMode] = useState(null)
  useEffect(() => {
    try { const v = localStorage.getItem(COLOR_KEY); if (v && COLOR_MODES[v]) setMode(v) } catch { /* storage blocked */ }
  }, [])
  function pick(v) {
    setMode(v)
    try { localStorage.setItem(COLOR_KEY, v) } catch { /* storage blocked */ }
  }
  return [mode, pick]
}

export function ColorSelect({ value, onChange }) {
  return (
    <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      Color by
      <select value={value} onChange={(ev) => onChange(ev.target.value)}
        className="h-7 rounded-md border bg-transparent px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
        {Object.entries(COLOR_MODES).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
      </select>
    </label>
  )
}

/** What the colours currently mean: one swatch per bucket, with how many shown sessions fall in it. */
export function ColorLegend({ events, mode, className = '' }) {
  const items = colorLegend(events, mode)
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${className}`} aria-label={`Colour legend: ${COLOR_MODES[mode]?.label}`}>
      <span className="font-medium text-foreground">{COLOR_MODES[mode]?.label}:</span>
      {items.map((b) => (
        <span key={b.key} className={`inline-flex items-center gap-1 ${b.count === 0 ? 'opacity-50' : ''}`}>
          {b.color && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: b.color }} />}
          {b.label} <span className="tabular-nums">{b.count}</span>
        </span>
      ))}
    </div>
  )
}
