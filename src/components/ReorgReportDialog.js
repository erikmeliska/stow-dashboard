'use client'

import * as React from "react"
import { FolderTree, Eye, Archive, ArrowRight } from "lucide-react"

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CopyButton } from "@/components/CopyButton"
import { formatTimeAgo } from "@/lib/utils"

// Group label for a misplaced project: category, plus client for _Bizz.
function groupLabel(ai) {
    const category = ai?.category || '_Uncategorized'
    if (category === '_Bizz' && ai?.client) {
        const client = ai.client.replace(/^new:/, '')
        return `${category}/${client}`
    }
    return category
}

function LowConfidenceTag() {
    return (
        <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-muted text-muted-foreground">
            low confidence
        </span>
    )
}

export function ReorgReportDialog({ open, onOpenChange, projects, onOpenProject }) {
    const { groups, archives, summary } = React.useMemo(() => {
        const list = projects || []
        let misplaced = 0
        let unanalyzed = 0
        const groupMap = new Map()
        const archives = []

        for (const p of list) {
            const ai = p.ai_analysis
            const derived = p.ai_derived
            const analyzed = ai && !ai.error
            if (!analyzed) unanalyzed++

            if (derived && derived.placement_ok === false) {
                misplaced++
                const label = groupLabel(ai)
                if (!groupMap.has(label)) groupMap.set(label, [])
                groupMap.get(label).push(p)
            }

            if (derived && derived.status === 'archive-candidate') {
                archives.push(p)
            }
        }

        archives.sort((a, b) => (a.scc?.total_code ?? 0) - (b.scc?.total_code ?? 0))

        const groups = [...groupMap.entries()]
            .map(([label, items]) => ({ label, items }))
            .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))

        return {
            groups,
            archives,
            summary: { misplaced, archives: archives.length, unanalyzed },
        }
    }, [projects])

    const handleOpenProject = (project) => {
        onOpenProject?.(project)
        onOpenChange?.(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FolderTree className="h-5 w-5" />
                        Reorganization report
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        {summary.misplaced} misplaced · {summary.archives} archive candidates · {summary.unanalyzed} unanalyzed
                    </p>
                </DialogHeader>

                <TooltipProvider>
                    <div className="max-h-[70vh] overflow-y-auto space-y-6 pr-1">
                        {/* Moves */}
                        <section className="space-y-3">
                            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                                Moves
                            </h3>
                            {groups.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No misplaced projects.</p>
                            ) : (
                                groups.map((group) => (
                                    <div key={group.label} className="space-y-1.5">
                                        <div className="flex items-center gap-1.5 text-sm font-medium">
                                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                                            <span>{group.label}</span>
                                            <span className="text-xs text-muted-foreground">({group.items.length})</span>
                                        </div>
                                        <div className="space-y-1.5">
                                            {group.items.map((p) => {
                                                const derived = p.ai_derived
                                                const lowConf = p.ai_analysis?.confidence === 'low'
                                                return (
                                                    <div
                                                        key={p.id ?? p.directory}
                                                        className="flex items-center gap-2 bg-muted/40 rounded-lg p-2 pl-3"
                                                    >
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm font-medium truncate flex items-center">
                                                                {p.project_name}
                                                                {lowConf && <LowConfidenceTag />}
                                                            </p>
                                                            <p className="text-xs text-muted-foreground font-mono break-all">
                                                                {p.directory}
                                                                {' → '}
                                                                <span className="text-foreground/70">{derived?.suggested_path}</span>
                                                            </p>
                                                        </div>
                                                        <CopyButton
                                                            text={`mv "${p.directory}" "${derived?.suggested_path}"`}
                                                            tooltip="Copy mv command"
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            className="h-8 w-8"
                                                            onClick={() => handleOpenProject(p)}
                                                            title="Open details"
                                                        >
                                                            <Eye className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                ))
                            )}
                        </section>

                        {/* Archive candidates */}
                        <section className="space-y-3">
                            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Archive className="h-4 w-4" />
                                Archive candidates
                            </h3>
                            {archives.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No archive candidates.</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {archives.map((p) => {
                                        const lowConf = p.ai_analysis?.confidence === 'low'
                                        const code = p.scc?.total_code ?? 0
                                        return (
                                            <div
                                                key={p.id ?? p.directory}
                                                className="flex items-center gap-2 bg-muted/40 rounded-lg p-2 pl-3"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium truncate flex items-center">
                                                        {p.project_name}
                                                        {lowConf && <LowConfidenceTag />}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground font-mono break-all">
                                                        {p.directory}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {code} lines, last activity {formatTimeAgo(p.last_modified)}
                                                    </p>
                                                </div>
                                                <Button
                                                    variant="outline"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    onClick={() => handleOpenProject(p)}
                                                    title="Open details"
                                                >
                                                    <Eye className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </section>
                    </div>
                </TooltipProvider>
            </DialogContent>
        </Dialog>
    )
}
