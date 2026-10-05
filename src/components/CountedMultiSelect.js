'use client'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/**
 * Toolbar multi-select with per-value counts (Groups, Client, Role on the
 * projects page). `stats` = [{ value, label, count }].
 */
export function CountedMultiSelect({ label, icon: Icon, stats, selected, onToggle, onClear, clearLabel = 'Clear all filters' }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className={selected.length > 0 ? "border-primary" : ""}>
                    {Icon && <Icon className="mr-1.5 h-4 w-4" />}
                    <span className="hidden sm:inline">{label}</span>
                    {selected.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                            {selected.length}
                        </span>
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 max-h-80 overflow-y-auto">
                {selected.length > 0 && (
                    <div
                        className="px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:text-foreground"
                        onClick={onClear}
                    >
                        {clearLabel}
                    </div>
                )}
                {stats.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">Nothing to filter</div>
                )}
                {stats.map(({ value, label: text, count }) => (
                    <DropdownMenuCheckboxItem
                        key={value}
                        checked={selected.includes(value)}
                        onCheckedChange={() => onToggle(value)}
                    >
                        <span className="flex-1 truncate">{text}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{count}</span>
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
