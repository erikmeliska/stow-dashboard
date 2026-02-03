'use client'

import * as React from "react"
import {
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, ChevronDown, MoreHorizontal, GitBranch, Github, Gitlab, Check, X, FileText } from 'lucide-react'

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { formatTimeAgo, getGitProvider } from "@/lib/utils"
import { cn } from "@/lib/utils"
import { ReadmeDialog } from "@/components/ReadmeDialog"

const STORAGE_KEY = 'stow-dashboard-table-settings'
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

function loadSettings() {
    if (typeof window === 'undefined') return null
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        return saved ? JSON.parse(saved) : null
    } catch {
        return null
    }
}

function saveSettings(settings) {
    if (typeof window === 'undefined') return
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
        // Ignore storage errors
    }
}

const extractRepoName = (remoteUrl = '') => {
    if (!remoteUrl) return ''
    
    // Podporuje formáty:
    // git@github.com:Pythagora-io/gpt-pilot.git
    // git@gitlab.com:intelimail/learning/tomysymlink.git
    // git@gitlab.com/intelimail/learning/tomysymlink.git
    // https://github.com/Pythagora-io/gpt-pilot.git
    const match = remoteUrl.match(/(?::|\/)([\w-]+)(?:\/|$)/)
    return match ? match[1] : ''
}

function TimeAgo({ date }) {
    const [isMounted, setIsMounted] = React.useState(false)

    React.useEffect(() => {
        setIsMounted(true)
    }, [])

    if (!isMounted) {
        return <div className="animate-pulse bg-muted h-4 w-20 rounded" />
    }

    return (
        <div title={new Date(date).toLocaleString()}>
            {formatTimeAgo(date)}
        </div>
    )
}

export function ProjectTable({ projects, ownRepos }) {
    const [isHydrated, setIsHydrated] = React.useState(false)
    const [sorting, setSorting] = React.useState([])
    const [columnFilters, setColumnFilters] = React.useState([])
    const [columnVisibility, setColumnVisibility] = React.useState({})
    const [globalFilter, setGlobalFilter] = React.useState("")
    const [readmeDialog, setReadmeDialog] = React.useState({ open: false, project: null })
    const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 20 })

    // Load settings from localStorage on mount
    React.useEffect(() => {
        const settings = loadSettings()
        if (settings) {
            if (settings.sorting) setSorting(settings.sorting)
            if (settings.columnVisibility) setColumnVisibility(settings.columnVisibility)
            if (settings.pageSize) setPagination(prev => ({ ...prev, pageSize: settings.pageSize }))
        }
        setIsHydrated(true)
    }, [])

    // Save settings to localStorage on change
    React.useEffect(() => {
        if (!isHydrated) return
        saveSettings({ sorting, columnVisibility, pageSize: pagination.pageSize })
    }, [sorting, columnVisibility, pagination.pageSize, isHydrated])
    
    const columns = [
        {
            accessorKey: "project_name",
            header: "Project Name",
            cell: ({ row }) => {
                const name = row.getValue("project_name")
                const displayName = name.length > 40 ? `${name.slice(0, 40)}...` : name
                return (
                    <div className="capitalize" title={name}>
                        {displayName}
                    </div>
                )
            },
        },
        {
            accessorKey: "groupParts",
            header: "Group",
            cell: ({ row }) => {
                const parts = row.getValue("groupParts")
                return (
                    <div className="flex gap-1 flex-wrap">
                        {parts.map((part, index) => (
                            <span 
                                key={index}
                                className="px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-xs"
                            >
                                {part}
                            </span>
                        ))}
                    </div>
                )
            },
        },
        {
            accessorKey: "projectDir",
            header: "Directory",
            cell: ({ row }) => <div className="text-sm text-muted-foreground">{row.getValue("projectDir")}</div>,
        },
        {
            accessorKey: "git_info.git_detected",
            header: "Git",
            cell: ({ row }) => {
                const gitInfo = row.original.git_info
                const hasGit = gitInfo?.git_detected
                const remotes = gitInfo?.remotes || []
                const provider = remotes.length > 0 ? getGitProvider(remotes[0]) : null

                return (
                    <div className="flex items-center gap-2">
                        {hasGit ? (
                            <>
                                <Check className="w-4 h-4 text-green-500" />
                                {provider && (
                                    <span title={remotes[0]}>
                                        {provider === 'github' && <Github className="w-4 h-4" />}
                                        {provider === 'gitlab' && <Gitlab className="w-4 h-4" />}
                                        {provider === 'bitbucket' && <GitBranch className="w-4 h-4" />}
                                    </span>
                                )}
                            </>
                        ) : (
                            <X className="w-4 h-4 text-red-500" />
                        )}
                    </div>
                )
            },
        },
        {
            accessorKey: "git_info.remotes",
            header: "Repository",
            cell: ({ row }) => {
                const gitInfo = row.original.git_info
                const remotes = gitInfo?.remotes || []
                if (!gitInfo?.git_detected || remotes.length === 0) return <div></div>
                
                const repoName = extractRepoName(remotes[0])
                const isOwnRepo = ownRepos.includes(repoName)
                
                return (
                    <div>
                        <span className={cn(
                            "px-2 py-1 rounded-full text-xs",
                            isOwnRepo 
                                ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100" 
                                : "bg-secondary text-secondary-foreground"
                        )}>
                            {repoName}
                        </span>
                    </div>
                )
            },
        },
        {
            accessorKey: "last_modified",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Last Modified
                        <ArrowUpDown className="ml-2 h-4 w-4" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const date = row.getValue("last_modified")
                return <TimeAgo date={date} />
            },
        },
        {
            accessorKey: "content_size_bytes",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Code Size
                        <ArrowUpDown className="ml-2 h-4 w-4" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const bytes = row.getValue("content_size_bytes")
                if (!bytes) return <div className="text-muted-foreground">-</div>
                return <div>{(bytes / 1024 / 1024).toFixed(2)} MB</div>
            },
        },
        {
            accessorKey: "total_size_bytes",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Total Size
                        <ArrowUpDown className="ml-2 h-4 w-4" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const bytes = row.getValue("total_size_bytes")
                if (!bytes) return <div className="text-muted-foreground">-</div>
                return <div>{(bytes / 1024 / 1024).toFixed(2)} MB</div>
            },
        },
        {
            accessorKey: "git_info.total_commits",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Total Commits
                        <ArrowUpDown className="ml-2 h-4 w-4" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const gitInfo = row.original.git_info
                
                if (!gitInfo?.git_detected || !gitInfo?.total_commits) {
                    return <div></div>
                }

                const totalCommits = gitInfo.total_commits
                const userCommits = gitInfo.user_commits || 0

                return (
                    <div className="flex items-center gap-2">
                        <span className="px-2 py-1 bg-secondary text-secondary-foreground rounded-full text-xs">
                            {totalCommits}
                        </span>
                        {userCommits > 0 && (
                            <span className="px-2 py-1 bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100 rounded-full text-xs">
                                {userCommits}
                            </span>
                        )}
                    </div>
                )
            },
        },
        {
            id: "readme",
            header: "README",
            cell: ({ row }) => {
                const project = row.original
                if (!project.hasReadme) return null

                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setReadmeDialog({ open: true, project })}
                    >
                        <FileText className="h-4 w-4" />
                    </Button>
                )
            },
        },
        {
            id: "actions",
            enableHiding: false,
            cell: ({ row }) => {
                const project = row.original

                return (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuItem
                                onClick={() => navigator.clipboard.writeText(project.directory)}
                            >
                                Copy project path
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem>View details</DropdownMenuItem>
                            <DropdownMenuItem>Delete project</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )
            },
        },
    ]

    const table = useReactTable({
        data: projects,
        columns,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        onColumnVisibilityChange: setColumnVisibility,
        state: {
            sorting,
            columnFilters,
            columnVisibility,
            globalFilter,
            pagination,
        },
        onPaginationChange: setPagination,
        onGlobalFilterChange: setGlobalFilter,
        globalFilterFn: (row, columnId, filterValue) => {
            const searchValue = filterValue.toLowerCase()
            
            // Vyhľadávanie v názve projektu
            if (row.getValue("project_name").toLowerCase().includes(searchValue)) return true
            
            // Vyhľadávanie v adresári
            if (row.getValue("projectDir").toLowerCase().includes(searchValue)) return true
            
            // Vyhľadávanie v groupParts
            const groupParts = row.getValue("groupParts")
            if (groupParts.some(part => part.toLowerCase().includes(searchValue))) return true
            
            // Vyhľadávanie v git remotes
            const gitRemotes = row.original.git_info?.remotes || []
            if (gitRemotes.some(remote => remote.toLowerCase().includes(searchValue))) return true
            
            return false
        },
    })

    return (
        <>
        <ReadmeDialog
            open={readmeDialog.open}
            onOpenChange={(open) => setReadmeDialog({ open, project: open ? readmeDialog.project : null })}
            projectName={readmeDialog.project?.project_name}
            directory={readmeDialog.project?.directory}
        />
        <div className="w-full">
            <div className="flex items-center py-4">
                <Input
                    placeholder="Search projects..."
                    value={globalFilter ?? ""}
                    onChange={(event) => setGlobalFilter(event.target.value)}
                    className="max-w-sm"
                />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="ml-auto">
                            Columns <ChevronDown className="ml-2 h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {table
                            .getAllColumns()
                            .filter((column) => column.getCanHide())
                            .map((column) => {
                                return (
                                    <DropdownMenuCheckboxItem
                                        key={column.id}
                                        className="capitalize"
                                        checked={column.getIsVisible()}
                                        onCheckedChange={(value) => column.toggleVisibility(!!value)}
                                    >
                                        {column.id}
                                    </DropdownMenuCheckboxItem>
                                )
                            })}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    )
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No results.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
            <div className="flex items-center justify-between space-x-2 py-4">
                <div className="flex-1 text-sm text-muted-foreground">
                    {table.getFilteredRowModel().rows.length} project(s) total
                </div>
                <div className="flex items-center space-x-6 lg:space-x-8">
                    <div className="flex items-center space-x-2">
                        <p className="text-sm text-muted-foreground">Rows per page</p>
                        <select
                            className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm"
                            value={pagination.pageSize}
                            onChange={(e) => setPagination(prev => ({ ...prev, pageIndex: 0, pageSize: Number(e.target.value) }))}
                        >
                            {PAGE_SIZE_OPTIONS.map((size) => (
                                <option key={size} value={size}>
                                    {size}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center space-x-2">
                        <p className="text-sm font-medium">
                            Page {table.getState().pagination.pageIndex + 1} of{" "}
                            {table.getPageCount()}
                        </p>
                    </div>
                    <div className="flex items-center space-x-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            Previous
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            Next
                        </Button>
                    </div>
                </div>
            </div>
        </div>
        </>
    )
}