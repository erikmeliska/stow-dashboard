'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Split button: main segment opens with the last-used app (persisted per
 * browser in localStorage), chevron opens the picker. `apps` order comes
 * from settings; a stored value no longer configured falls back to apps[0].
 */
export function SplitOpenButton({ icon: Icon, label, apps, storageKey, onOpen }) {
    const [lastUsed, setLastUsed] = React.useState(null)

    React.useEffect(() => {
        try {
            const saved = localStorage.getItem(storageKey)
            if (saved) setLastUsed(saved)
        } catch {
            // localStorage unavailable — session-only behavior
        }
    }, [storageKey])

    if (!apps || apps.length === 0) return null
    const current = apps.includes(lastUsed) ? lastUsed : apps[0]

    const openApp = (app) => {
        try {
            localStorage.setItem(storageKey, app)
        } catch {
            // localStorage unavailable — session-only behavior
        }
        setLastUsed(app)
        onOpen(app)
    }

    return (
        <div className="flex">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        className={`h-8 w-8 ${apps.length > 1 ? 'rounded-r-none' : ''}`}
                        onClick={() => openApp(current)}
                    >
                        <Icon className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent><p>{label}: {current}</p></TooltipContent>
            </Tooltip>
            {apps.length > 1 && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" className="h-8 w-5 rounded-l-none border-l-0 px-0">
                            <ChevronDown className="h-3 w-3" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {apps.map(app => (
                            <DropdownMenuItem
                                key={app}
                                onClick={() => openApp(app)}
                                className={app === current ? 'font-medium' : ''}
                            >
                                {app}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    )
}
