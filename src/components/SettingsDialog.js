'use client'

import * as React from 'react'
import { Settings, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { DEFAULT_MODELS, HARNESSES } from '@/lib/cc/summary-view.mjs'

const FIELDS = [
    { key: 'SCAN_ROOTS', label: 'Scan roots', help: 'Comma-separated directories scanned for projects' },
    { key: 'BASE_DIR', label: 'Base directory', help: 'Base for relative paths shown in the UI' },
    { key: 'IDE_COMMANDS', label: 'IDE commands', help: 'Comma-separated CLI commands, e.g. code,cursor,zed — first is the default' },
    { key: 'TERMINAL_APPS', label: 'Terminal apps', help: 'Comma-separated app names, e.g. Terminal,Warp,cmux — first is the default' },
]

const HARNESS_LABELS = { claude: 'Claude Code (claude CLI)', codex: 'Codex (codex CLI)' }
const modelHint = (m) => m || 'CLI default'

/** Session-summary engine: which local CLI writes the summaries, and with which model. */
const SUMMARY_FIELDS = [
    { key: 'CC_SUMMARY_MODEL', label: 'Model — single summary', which: 'single', help: 'The Generate button on a session. Empty = the harness default.' },
    { key: 'CC_SUMMARY_BATCH_MODEL', label: 'Model — batch', which: 'batch', help: 'The calendar banner, cc:eval and the MCP summarize_sessions tool. Empty = the harness default.' },
]

export function SettingsDialog() {
    const [open, setOpen] = React.useState(false)
    const [values, setValues] = React.useState({})
    const [loading, setLoading] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState(null)
    const set = (key, value) => setValues(prev => ({ ...prev, [key]: value }))
    const harness = HARNESSES.includes(values.CC_SUMMARY_HARNESS) ? values.CC_SUMMARY_HARNESS : HARNESSES[0]

    React.useEffect(() => {
        if (!open) return
        setLoading(true)
        setError(null)
        fetch('/api/settings')
            .then(r => r.json())
            .then(data => setValues(data || {}))
            .catch(() => setError('Failed to load settings'))
            .finally(() => setLoading(false))
    }, [open])

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values),
            })
            if (!res.ok) throw new Error('Save failed')
            setOpen(false)
        } catch (e) {
            setError(e.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" title="Settings">
                    <Settings className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Stored in this instance&apos;s .env.local — applied immediately, no restart needed.
                    </DialogDescription>
                </DialogHeader>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        {FIELDS.map(({ key, label, help }) => (
                            <div key={key} className="space-y-1">
                                <label className="text-sm font-medium" htmlFor={`setting-${key}`}>{label}</label>
                                <Input
                                    id={`setting-${key}`}
                                    value={values[key] ?? ''}
                                    onChange={e => set(key, e.target.value)}
                                    placeholder={key}
                                />
                                <p className="text-xs text-muted-foreground">{help}</p>
                            </div>
                        ))}
                        <div className="space-y-4 border-t pt-4">
                            <div>
                                <h3 className="text-sm font-semibold">Session summaries</h3>
                                <p className="text-xs text-muted-foreground">Which local CLI writes the AI summaries on /sessions, and with which model.</p>
                            </div>
                            <div className="space-y-1">
                                <label className="text-sm font-medium" htmlFor="setting-CC_SUMMARY_HARNESS">Harness</label>
                                <select
                                    id="setting-CC_SUMMARY_HARNESS"
                                    value={harness}
                                    onChange={e => set('CC_SUMMARY_HARNESS', e.target.value)}
                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                >
                                    {HARNESSES.map(h => <option key={h} value={h}>{HARNESS_LABELS[h] || h}</option>)}
                                </select>
                                <p className="text-xs text-muted-foreground">Model names are the harness&apos;s own: e.g. haiku, claude-sonnet-5-5 for Claude; gpt-… for Codex.</p>
                            </div>
                            {SUMMARY_FIELDS.map(({ key, label, which, help }) => (
                                <div key={key} className="space-y-1">
                                    <label className="text-sm font-medium" htmlFor={`setting-${key}`}>{label}</label>
                                    <Input
                                        id={`setting-${key}`}
                                        value={values[key] ?? ''}
                                        onChange={e => set(key, e.target.value)}
                                        placeholder={modelHint(DEFAULT_MODELS[harness][which])}
                                    />
                                    <p className="text-xs text-muted-foreground">{help}</p>
                                </div>
                            ))}
                        </div>
                        {error && <p className="text-sm text-destructive">{error}</p>}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={save} disabled={saving || loading}>
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
