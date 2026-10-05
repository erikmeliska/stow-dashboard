'use client'

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ROLES, locationMeta } from "@/lib/virtual-projects.mjs"
import { formatTimeAgo, cn } from "@/lib/utils"

const CLIENT_SOURCE_LABEL = { manual: 'manual', ai: 'AI', owner: 'remote owner', path: 'path' }

async function patchMeta(body) {
    const res = await fetch('/api/projects/meta', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
}

/**
 * Locations section of the details sheet (#10): the project's client and its
 * checkouts with copy role and primary. Edits go to PATCH /api/projects/meta
 * (→ .stow/project.json); `onSaved` re-renders the page from the register.
 */
export function ProjectLocations({ virtualProject: vp, clients, activeDirectory, onShowLocation, onSaved }) {
    const [busy, setBusy] = React.useState(null)   // key of the control being saved
    const [error, setError] = React.useState(null) // { key, message }
    const [newClient, setNewClient] = React.useState('')

    const run = async (key, body) => {
        setBusy(key)
        setError(null)
        try {
            await patchMeta(body)
            onSaved()
        } catch (e) {
            setError({ key, message: e.message })
        } finally {
            setBusy(null)
        }
    }

    const saveNewClient = () => {
        const name = newClient.trim()
        if (!name) return
        run('client', { projectId: vp.vpId, client: name })
        setNewClient('')
    }

    const manual = vp.clientSource === 'manual'
    const options = manual && vp.client && !clients.includes(vp.client) ? [vp.client, ...clients] : clients

    return (
        <section className="mt-4 space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Locations <span className="normal-case">({vp.copyCount})</span>
            </h3>

            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Client</span>
                <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="Client"
                    disabled={busy !== null}
                    value={manual ? vp.client : ''}
                    onChange={e => run('client', { projectId: vp.vpId, client: e.target.value || null })}
                >
                    <option value="">Automatic{!manual && vp.client ? ` (${vp.client})` : !manual ? ' (unassigned)' : ''}</option>
                    {options.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <Input
                    className="h-8 w-36"
                    placeholder="New client…"
                    aria-label="New client"
                    value={newClient}
                    disabled={busy !== null}
                    onChange={e => setNewClient(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveNewClient() }}
                />
                {newClient.trim() && (
                    <Button variant="outline" size="sm" className="h-8" disabled={busy !== null} onClick={saveNewClient}>Set</Button>
                )}
                {vp.clientSource && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs" title="Where the client comes from">
                        {CLIENT_SOURCE_LABEL[vp.clientSource] || vp.clientSource}
                    </span>
                )}
                {error?.key === 'client' && <span className="w-full text-xs text-red-600 dark:text-red-400">{error.message}</span>}
            </div>

            <ul className="divide-y rounded-md border">
                {vp.locations.map(loc => {
                    const meta = locationMeta(loc)
                    const key = `role:${loc.directory}`
                    const auto = loc.vp?.role_source === 'derived'
                    // The tail tells checkouts apart (blog vs blog-test); the full path is the tooltip
                    const path = loc.directory.split('/').filter(Boolean).slice(-2).join('/')
                    return (
                        <li
                            key={loc.directory}
                            className={cn("flex flex-wrap items-center gap-2 px-3 py-2 text-sm", loc.directory === activeDirectory && "bg-muted/40")}
                        >
                            <input
                                type="radio"
                                name={`primary-${vp.vpId}`}
                                aria-label={`Make ${path} primary`}
                                title="Primary checkout"
                                checked={meta.role === 'primary'}
                                disabled={busy !== null}
                                onChange={() => run(key, { directory: loc.directory, role: 'primary' })}
                            />
                            <span className="flex-1 min-w-[8rem] truncate font-mono text-xs" title={loc.directory}>{path}</span>
                            {loc.locationMembers > 1 && (
                                <span className="text-xs text-muted-foreground" title="Indexed directories inside this checkout">
                                    {loc.locationMembers} dirs
                                </span>
                            )}
                            {loc.git_info?.current_branch && loc.git_info.current_branch !== 'unknown' && (
                                <span className="text-xs text-muted-foreground">{loc.git_info.current_branch}</span>
                            )}
                            {loc.git_info?.is_clean === false && (
                                <span className="h-2 w-2 rounded-full bg-amber-500" title="Uncommitted changes" />
                            )}
                            {loc.last_modified && (
                                <span className="text-xs text-muted-foreground" title={new Date(loc.last_modified).toLocaleString()}>
                                    {formatTimeAgo(loc.last_modified)}
                                </span>
                            )}
                            <select
                                className="h-7 rounded-md border border-input bg-background px-1 text-xs"
                                aria-label={`Role of ${path}`}
                                title={auto ? 'Derived automatically — pick one to set it manually' : 'Set manually'}
                                value={meta.role ?? ''}
                                disabled={busy !== null}
                                onChange={e => run(key, { directory: loc.directory, role: e.target.value })}
                            >
                                {meta.role === null && <option value="">no role</option>}
                                {ROLES.map(r => <option key={r} value={r}>{r}{auto && r === meta.role ? ' (auto)' : ''}</option>)}
                            </select>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                disabled={loc.directory === activeDirectory}
                                onClick={() => onShowLocation(loc.directory)}
                            >
                                Show
                            </Button>
                            {error?.key === key && <span className="w-full text-xs text-red-600 dark:text-red-400">{error.message}</span>}
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
