'use client'

import * as React from "react"
import { useRouter } from "next/navigation"
import { FolderTree, Eye, Archive, Building2, Copy as CopyIcon, Ghost, MoreHorizontal, Loader2, TriangleAlert, Truck } from "lucide-react"

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { formatTimeAgo } from "@/lib/utils"

// Reorg report over the virtual-project register (#11). Every primary button
// only changes the register (.stow client/role, or drops vanished ledger rows);
// a physical move sits behind ⋯ → "Move on disk…" and always shows a dry-run.

// Long sections (hundreds of dead experiments are normal) start collapsed.
const SECTION_LIMIT = 25

const SECTIONS = [
    { kind: 'client-placement', title: 'Client placement', icon: Building2, empty: 'Every client project sits under its _Bizz folder.' },
    { kind: 'stale-copy', title: 'Stale copies', icon: CopyIcon, empty: 'No stale copies.' },
    { kind: 'abandoned', title: 'Abandoned experiments', icon: Archive, empty: 'No abandoned experiments.' },
    { kind: 'orphan', title: 'Orphans', icon: Ghost, empty: 'No orphaned projects.' },
]

function actionLabel(action) {
    switch (action?.type) {
        case 'confirm-client': return `Confirm client ${action.client}`
        case 'set-role': return 'Mark as stale'
        case 'archive-project': return 'Archive'
        case 'remove-project': return 'Remove from register'
        default: return 'Apply'
    }
}

function evidenceLine(s) {
    const e = s.evidence || {}
    switch (s.kind) {
        case 'client-placement':
            return s.move ? `suggested folder: ${s.move.to}` : 'target folder already exists — confirm only'
        case 'stale-copy':
            return [
                e.behind != null ? `behind ${e.behind}` : null,
                `last activity ${formatTimeAgo(e.lastActivity)} vs primary ${formatTimeAgo(e.primaryLastActivity)}`,
            ].filter(Boolean).join(' · ')
        case 'abandoned':
            return `${e.code ?? 0} lines · ${e.status}${e.maturity ? ` · ${e.maturity}` : ''}`
        case 'orphan':
            return [
                `last at ${(e.directories || []).join(', ') || '—'}`,
                e.manualClient ? 'has a manual client' : null,
                e.manualRoles ? 'has manual roles' : null,
            ].filter(Boolean).join(' · ')
        default:
            return null
    }
}

async function postJson(url, body, method = 'POST') {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
}

function MoveDialog({ suggestion, onClose, onMoved }) {
    const open = !!suggestion
    const [plan, setPlan] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [force, setForce] = React.useState(false)
    const [running, setRunning] = React.useState(false)
    const [result, setResult] = React.useState(null)
    const move = suggestion?.move

    React.useEffect(() => {
        if (!move) return
        let stale = false
        setPlan(null); setError(null); setResult(null)
        postJson('/api/reorg/relocate', { from: move.from, to: move.to, dryRun: true, force })
            .then(p => { if (!stale) setPlan(p) })
            .catch(e => { if (!stale) setError(e.message) })
        return () => { stale = true }
    }, [move, force])

    // Force only overrides a dirty tree, so offer it only when that is the sole blocker.
    const onlyDirty = plan && plan.blockers.length > 0 && plan.blockers.every(b => /uncommitted/.test(b))
    const forceOffered = onlyDirty || (force && plan?.ok)

    const run = async () => {
        setRunning(true); setError(null)
        try {
            const r = await postJson('/api/reorg/relocate', { from: move.from, to: move.to, planHash: plan.planHash, force })
            setResult(r)
            if (r.ok) onMoved?.()
        } catch (e) {
            setError(e.message)
        } finally {
            setRunning(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Truck className="h-5 w-5" />
                        Move on disk
                    </DialogTitle>
                    {move && (
                        <p className="text-xs text-muted-foreground font-mono break-all">
                            {move.from} → {move.to}
                        </p>
                    )}
                </DialogHeader>

                <div className="max-h-[60vh] overflow-y-auto space-y-4 text-sm">
                    {!plan && !error && (
                        <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Planning (dry-run)…</p>
                    )}
                    {error && <p className="text-destructive break-words">{error}</p>}
                    {plan && (
                        <>
                            {plan.blockers.length > 0 && (
                                <div className="space-y-1">
                                    <p className="font-medium text-destructive">Blocked</p>
                                    <ul className="list-disc pl-5 text-destructive break-words">
                                        {plan.blockers.map(b => <li key={b}>{b}</li>)}
                                    </ul>
                                </div>
                            )}
                            {plan.warnings.length > 0 && (
                                <div className="space-y-1">
                                    <p className="font-medium flex items-center gap-1.5"><TriangleAlert className="h-4 w-4" /> Warnings</p>
                                    <ul className="list-disc pl-5 text-muted-foreground break-words">
                                        {plan.warnings.map(w => <li key={w}>{w}</li>)}
                                    </ul>
                                </div>
                            )}
                            <div className="space-y-1">
                                <p className="font-medium">Steps</p>
                                <ol className="list-decimal pl-5 space-y-0.5 break-words">
                                    {plan.steps.map((s, i) => <li key={i}>{s.description}</li>)}
                                </ol>
                            </div>
                        </>
                    )}
                    {result && (
                        result.ok ? (
                            <p className="text-foreground">Moved. Journal: <span className="font-mono text-xs break-all">{result.journal}</span></p>
                        ) : (
                            <div className="text-destructive space-y-1 break-words">
                                <p>Failed at {result.failed?.kind}: {result.failed?.error}</p>
                                {result.journal && (result.rolledBack
                                    ? <p>Everything was rolled back. Journal: <span className="font-mono text-xs">{result.journal}</span></p>
                                    : <p>Rollback did not finish — manual fix needed, then <span className="font-mono text-xs">npm run relocate -- --resume {result.journal}</span></p>)}
                            </div>
                        )
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
                    {forceOffered && (
                        <label className="mr-auto flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                            Move with uncommitted changes
                        </label>
                    )}
                    <Button variant="ghost" onClick={onClose}>{result?.ok ? 'Close' : 'Cancel'}</Button>
                    {!result?.ok && (
                        <Button variant="destructive" disabled={!plan?.ok || running} onClick={run}>
                            {running && <Loader2 className="h-4 w-4 animate-spin" />}
                            Move
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function SuggestionRow({ s, busy, project, onApply, onDismiss, onOpenProject, onMove }) {
    const Icon = s.kind === 'orphan' ? Ghost : null
    return (
        <div className="flex flex-col sm:flex-row sm:items-start gap-2 bg-muted/40 rounded-lg p-2 pl-3">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate flex items-center gap-1.5">
                    {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                    {s.projectName || s.projectId}
                </p>
                {s.location && <p className="text-xs text-muted-foreground font-mono break-all">{s.location}</p>}
                <p className="text-xs">{s.reason}</p>
                <p className="text-xs text-muted-foreground break-all">{evidenceLine(s)}</p>
            </div>
            <div className="flex flex-wrap items-center sm:justify-end gap-1.5 shrink-0">
                <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => onApply(s)}>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {actionLabel(s.action)}
                </Button>
                <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => onDismiss(s)}>
                    Dismiss
                </Button>
                {project && (
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onOpenProject(project)} title="Open details">
                        <Eye className="h-4 w-4" />
                    </Button>
                )}
                {s.move && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="More">
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => onMove(s)}>Move on disk…</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
        </div>
    )
}

export function ReorgReportDialog({ open, onOpenChange, projects, runningDirs, onOpenProject, onChanged }) {
    const router = useRouter()
    const [state, setState] = React.useState({ loading: false, error: null, report: null })
    const [includeDismissed, setIncludeDismissed] = React.useState(false)
    const [busyId, setBusyId] = React.useState(null)
    const [actionError, setActionError] = React.useState(null)
    const [moving, setMoving] = React.useState(null)
    const [expanded, setExpanded] = React.useState({})

    const running = React.useMemo(() => runningDirs || [], [runningDirs])
    const runningKey = JSON.stringify(running)

    const load = React.useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }))
        try {
            const q = new URLSearchParams({ running: runningKey })
            if (includeDismissed) q.set('includeDismissed', '1')
            const res = await fetch(`/api/reorg?${q}`)
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
            setState({ loading: false, error: null, report: data })
        } catch (e) {
            setState(s => ({ ...s, loading: false, error: e.message }))
        }
    }, [runningKey, includeDismissed])

    React.useEffect(() => { if (open) load() }, [open, load])
    React.useEffect(() => { if (!open) { setIncludeDismissed(false); setActionError(null); setExpanded({}) } }, [open])

    const changed = () => { onChanged?.(); router.refresh() }

    const act = async (s, url, method = 'POST') => {
        setBusyId(s.id); setActionError(null)
        try {
            const report = await postJson(url, { id: s.id, running }, method)
            setState({ loading: false, error: null, report })
            if (url.endsWith('/apply')) changed()
        } catch (e) {
            setActionError(e.message)
        } finally {
            setBusyId(null)
        }
    }

    const byDir = React.useMemo(() => new Map((projects || []).map(p => [p.directory, p])), [projects])
    const report = state.report
    const groups = React.useMemo(() => {
        const g = Object.fromEntries(SECTIONS.map(s => [s.kind, []]))
        for (const s of report?.suggestions || []) g[s.kind]?.push(s)
        return g
    }, [report])

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
                        {report
                            ? `${report.summary['client-placement']} client placement · ${report.summary['stale-copy']} stale copies · ${report.summary.abandoned} abandoned · ${report.summary.orphan} orphans · ${report.summary.unassigned} projects without a client`
                            : 'Suggestions over the virtual-project register. Actions change the register only; nothing moves on disk.'}
                    </p>
                </DialogHeader>

                <div className="max-h-[70vh] overflow-y-auto space-y-6 pr-1">
                    {state.loading && !report && (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
                    )}
                    {state.error && <p className="text-sm text-destructive">{state.error}</p>}
                    {report?.error && <p className="text-sm text-destructive">{report.error}</p>}
                    {actionError && <p className="text-sm text-destructive">{actionError}</p>}

                    {report && SECTIONS.map(({ kind, title, icon: Icon, empty }) => (
                        <section key={kind} className="space-y-3">
                            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Icon className="h-4 w-4" />
                                {title}
                                <span className="text-xs normal-case">({groups[kind].length})</span>
                            </h3>
                            {groups[kind].length === 0 ? (
                                <p className="text-sm text-muted-foreground">{empty}</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {(expanded[kind] ? groups[kind] : groups[kind].slice(0, SECTION_LIMIT)).map(s => (
                                        <SuggestionRow
                                            key={s.id}
                                            s={s}
                                            busy={busyId === s.id}
                                            project={s.location ? byDir.get(s.location) : null}
                                            onApply={(x) => act(x, '/api/reorg/apply')}
                                            onDismiss={(x) => act(x, '/api/reorg/dismiss')}
                                            onOpenProject={handleOpenProject}
                                            onMove={setMoving}
                                        />
                                    ))}
                                    {!expanded[kind] && groups[kind].length > SECTION_LIMIT && (
                                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setExpanded(e => ({ ...e, [kind]: true }))}>
                                            Show all {groups[kind].length}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </section>
                    ))}
                </div>

                {report && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                        <span>
                            {report.dismissedCount} dismissed
                            {!includeDismissed && report.dismissedCount > 0 && (
                                <> · <button type="button" className="underline hover:text-foreground" onClick={() => setIncludeDismissed(true)}>show them</button></>
                            )}
                        </span>
                        {state.loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </div>
                )}
            </DialogContent>

            {/* Keyed per suggestion: force/plan/result never carry over to another move. */}
            <MoveDialog
                key={moving?.id ?? 'none'}
                suggestion={moving}
                onClose={() => setMoving(null)}
                onMoved={() => { changed(); load() }}
            />
        </Dialog>
    )
}
