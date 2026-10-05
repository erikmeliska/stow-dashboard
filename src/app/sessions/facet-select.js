'use client'

import { ChevronDown, X } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Multi-select filter for /sessions (#13): a checkbox list with counts, the same
 * dropdown idiom as the project table's AI facet filters. Empty selection = any.
 * The trigger reads `Client: any` / `Client: Intelimail` / `Client: 3 selected`.
 */
export function FacetSelect({ label, options, selected, onChange, title }) {
  const pick = selected.length === 1 ? options.find((o) => o.value === selected[0])?.label || selected[0] : null
  const text = selected.length === 0 ? 'any' : pick || `${selected.length} selected`
  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button title={title || label}
          className={`h-7 max-w-[14rem] inline-flex items-center gap-1 rounded-md border bg-transparent px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring ${selected.length ? 'border-primary text-foreground' : 'text-foreground'}`}>
          <span className="truncate">{label}: {text}</span>
          <ChevronDown className="h-3 w-3 flex-none opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {options.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">Nothing in the loaded sessions</div>}
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={selected.includes(o.value)}
            onCheckedChange={() => toggle(o.value)} onSelect={(e) => e.preventDefault()} title={o.title}>
            <span className={`flex-1 truncate ${o.muted ? 'text-muted-foreground' : ''}`}>{o.label}</span>
            <span className="ml-3 text-xs tabular-nums text-muted-foreground">{o.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 && (<>
          <DropdownMenuSeparator />
          <button onClick={() => onChange([])} className="w-full px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        </>)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
