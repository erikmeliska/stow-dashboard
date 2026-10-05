'use client'
import { GitBranch } from 'lucide-react'
import { formatWorkspace } from '@/lib/cc/workspace.mjs'

/** Where a session ran when that wasn't the project's own checkout (#12). */
export function WorkspaceBadge({ workspace, className = '' }) {
  const text = formatWorkspace(workspace)
  if (!text) return null
  return (
    <span title={`Ran in ${text}`} className={`inline-flex items-center gap-0.5 rounded border px-1 text-[10px] leading-4 text-muted-foreground whitespace-nowrap ${className}`}>
      <GitBranch className="h-2.5 w-2.5" />{text}
    </span>
  )
}
