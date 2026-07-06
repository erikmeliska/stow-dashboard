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

const FIELDS = [
    { key: 'SCAN_ROOTS', label: 'Scan roots', help: 'Comma-separated directories scanned for projects' },
    { key: 'BASE_DIR', label: 'Base directory', help: 'Base for relative paths shown in the UI' },
    { key: 'IDE_COMMANDS', label: 'IDE commands', help: 'Comma-separated CLI commands, e.g. code,cursor,zed — first is the default' },
    { key: 'TERMINAL_APPS', label: 'Terminal apps', help: 'Comma-separated app names, e.g. Terminal,Warp,cmux — first is the default' },
]

export function SettingsDialog() {
    const [open, setOpen] = React.useState(false)
    const [values, setValues] = React.useState({})
    const [loading, setLoading] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState(null)

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
            <DialogContent className="sm:max-w-[480px]">
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
                                    onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))}
                                    placeholder={key}
                                />
                                <p className="text-xs text-muted-foreground">{help}</p>
                            </div>
                        ))}
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
