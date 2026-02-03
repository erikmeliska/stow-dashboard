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
import { ArrowUpDown, ChevronDown, GitBranch, Github, Gitlab, Check, X, FileText, Eye, Filter, Play, Circle } from 'lucide-react'

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
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
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"
import { ReadmeDialog } from "@/components/ReadmeDialog"
import { ProjectDetailsSheet } from "@/components/ProjectDetailsSheet"
import { useProcesses } from "@/hooks/useProcesses"

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
    const [selectedGroups, setSelectedGroups] = React.useState([])
    const [readmeDialog, setReadmeDialog] = React.useState({ open: false, project: null })
    const [detailsSheet, setDetailsSheet] = React.useState({ open: false, project: null })
    const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 20 })

    // Quick filters (null = any, true = yes, false = no)
    const [filters, setFilters] = React.useState({
        running: null,
        hasGit: null,
        hasRemote: null,
        uncommitted: null,
        behind: null,
        ahead: null,
        hasOwnCommits: null,
        hasReadme: null,
    })

    // Cycle through: null -> true -> false -> null
    const cycleFilter = (key) => {
        setFilters(prev => {
            const current = prev[key]
            const next = current === null ? true : current === true ? false : null
            return { ...prev, [key]: next }
        })
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    const activeFiltersCount = Object.values(filters).filter(v => v !== null).length

    const clearAllFilters = () => {
        setFilters({
            running: null,
            hasGit: null,
            hasRemote: null,
            uncommitted: null,
            behind: null,
            ahead: null,
            hasOwnCommits: null,
            hasReadme: null,
        })
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    // Helper to get filter button style
    const getFilterStyle = (value, activeColor = "") => {
        if (value === true) return activeColor || "bg-primary text-primary-foreground hover:bg-primary/90"
        if (value === false) return "bg-muted text-muted-foreground line-through"
        return ""
    }

    const getFilterLabel = (value, label) => {
        if (value === false) return `!${label}`
        return label
    }

    // Process monitoring
    const { processes, getPortsForProject, isProjectRunning } = useProcesses(30000)

    // Search filter function (same logic as globalFilterFn)
    const matchesSearch = React.useCallback((project, searchValue) => {
        if (!searchValue) return true
        const search = searchValue.toLowerCase()

        if (project.project_name?.toLowerCase().includes(search)) return true
        if (project.description?.toLowerCase().includes(search)) return true
        if (project.directory?.toLowerCase().includes(search)) return true
        if (project.stack?.some(tech => tech.toLowerCase().includes(search))) return true
        if (project.groupParts?.some(part => part.toLowerCase().includes(search))) return true
        if (project.git_info?.remotes?.some(remote => remote.toLowerCase().includes(search))) return true

        return false
    }, [])

    // Projects filtered by search (for group stats calculation)
    const searchFilteredProjects = React.useMemo(() => {
        if (!globalFilter) return projects
        return projects.filter(project => matchesSearch(project, globalFilter))
    }, [projects, globalFilter, matchesSearch])

    // Extract groups with counts from search-filtered projects
    const groupStats = React.useMemo(() => {
        const counts = {}
        searchFilteredProjects.forEach(project => {
            (project.groupParts || []).forEach(group => {
                counts[group] = (counts[group] || 0) + 1
            })
        })
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count }))
    }, [searchFilteredProjects])

    // Final filtered projects (search + groups + quick filters)
    const filteredProjects = React.useMemo(() => {
        let result = searchFilteredProjects

        // Group filter
        if (selectedGroups.length > 0) {
            result = result.filter(project =>
                selectedGroups.some(group => (project.groupParts || []).includes(group))
            )
        }

        // Quick filters (null = any, true = must have, false = must not have)
        if (filters.running !== null) {
            result = result.filter(project => {
                const ports = getPortsForProject(project.directory)
                const isRunning = ports.length > 0
                return filters.running ? isRunning : !isRunning
            })
        }

        if (filters.hasGit !== null) {
            result = result.filter(project => {
                const hasGit = project.git_info?.git_detected
                return filters.hasGit ? hasGit : !hasGit
            })
        }

        if (filters.hasRemote !== null) {
            result = result.filter(project => {
                const hasRemote = project.git_info?.remotes && project.git_info.remotes.length > 0
                return filters.hasRemote ? hasRemote : !hasRemote
            })
        }

        if (filters.uncommitted !== null) {
            result = result.filter(project => {
                const hasUncommitted = project.git_info?.uncommitted_changes > 0 || project.git_info?.is_clean === false
                return filters.uncommitted ? hasUncommitted : !hasUncommitted
            })
        }

        if (filters.behind !== null) {
            result = result.filter(project => {
                const isBehind = project.git_info?.behind > 0
                return filters.behind ? isBehind : !isBehind
            })
        }

        if (filters.ahead !== null) {
            result = result.filter(project => {
                const isAhead = project.git_info?.ahead > 0
                return filters.ahead ? isAhead : !isAhead
            })
        }

        if (filters.hasOwnCommits !== null) {
            result = result.filter(project => {
                const hasOwn = project.git_info?.user_commits > 0
                return filters.hasOwnCommits ? hasOwn : !hasOwn
            })
        }

        if (filters.hasReadme !== null) {
            result = result.filter(project => {
                const hasReadme = project.hasReadme
                return filters.hasReadme ? hasReadme : !hasReadme
            })
        }

        return result
    }, [searchFilteredProjects, selectedGroups, filters, getPortsForProject])

    const toggleGroup = (groupName) => {
        setSelectedGroups(prev =>
            prev.includes(groupName)
                ? prev.filter(g => g !== groupName)
                : [...prev, groupName]
        )
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    const clearGroups = () => {
        setSelectedGroups([])
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    // Auto-remove selected groups that no longer exist in filtered results
    React.useEffect(() => {
        const availableGroups = new Set(groupStats.map(g => g.name))
        const validGroups = selectedGroups.filter(g => availableGroups.has(g))
        if (validGroups.length !== selectedGroups.length) {
            setSelectedGroups(validGroups)
        }
    }, [groupStats, selectedGroups])

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
                const isClean = gitInfo?.is_clean !== false
                const uncommitted = gitInfo?.uncommitted_changes || 0
                const ahead = gitInfo?.ahead || 0
                const behind = gitInfo?.behind || 0

                return (
                    <div className="flex items-center gap-1.5">
                        {hasGit ? (
                            <>
                                <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                                {provider && (
                                    <span title={remotes[0]} className="flex-shrink-0">
                                        {provider === 'github' && <Github className="w-4 h-4" />}
                                        {provider === 'gitlab' && <Gitlab className="w-4 h-4" />}
                                        {provider === 'bitbucket' && <GitBranch className="w-4 h-4" />}
                                    </span>
                                )}
                                {!isClean && (
                                    <span
                                        className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 dark:text-yellow-400"
                                        title={`${uncommitted} uncommitted changes`}
                                    >
                                        {uncommitted}✎
                                    </span>
                                )}
                                {behind > 0 && (
                                    <span
                                        className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 dark:text-red-400"
                                        title={`${behind} commits behind remote`}
                                    >
                                        ↓{behind}
                                    </span>
                                )}
                                {ahead > 0 && (
                                    <span
                                        className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400"
                                        title={`${ahead} commits ahead of remote`}
                                    >
                                        ↑{ahead}
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
            id: "running",
            header: "Running",
            cell: ({ row }) => {
                const project = row.original
                const ports = getPortsForProject(project.directory)

                if (ports.length === 0) return null

                return (
                    <TooltipProvider delayDuration={300}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 dark:text-green-400 cursor-default">
                                    <Circle className="h-2 w-2 fill-current" />
                                    {ports.slice(0, 2).join(', ')}
                                    {ports.length > 2 && '...'}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>Running on port{ports.length > 1 ? 's' : ''}: {ports.join(', ')}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )
            },
        },
        {
            id: "actions",
            header: "Actions",
            enableHiding: false,
            cell: ({ row }) => {
                const project = row.original

                return (
                    <TooltipProvider delayDuration={300}>
                        <div className="flex items-center gap-1">
                            {project.hasReadme && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0"
                                            onClick={() => setReadmeDialog({ open: true, project })}
                                        >
                                            <FileText className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>View README</p>
                                    </TooltipContent>
                                </Tooltip>
                            )}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0"
                                        onClick={() => setDetailsSheet({ open: true, project })}
                                    >
                                        <Eye className="h-4 w-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>View details</p>
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    </TooltipProvider>
                )
            },
        },
    ]

    const table = useReactTable({
        data: filteredProjects,
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

    if (!isHydrated) {
        return (
            <div className="w-full">
                <div className="flex items-center py-4">
                    <div className="h-10 w-80 max-w-sm animate-pulse rounded-md bg-muted" />
                    <div className="ml-auto h-10 w-24 animate-pulse rounded-md bg-muted" />
                </div>
                <div className="rounded-md border">
                    <div className="h-[400px] animate-pulse bg-muted/50" />
                </div>
            </div>
        )
    }

    return (
        <>
        <ReadmeDialog
            open={readmeDialog.open}
            onOpenChange={(open) => setReadmeDialog({ open, project: open ? readmeDialog.project : null })}
            projectName={readmeDialog.project?.project_name}
            directory={readmeDialog.project?.directory}
        />
        <ProjectDetailsSheet
            open={detailsSheet.open}
            onOpenChange={(open) => setDetailsSheet({ open, project: open ? detailsSheet.project : null })}
            project={detailsSheet.project}
        />
        <div className="w-full">
            <div className="flex flex-col gap-4 py-4">
                <div className="flex items-center gap-2">
                    <div className="relative max-w-sm">
                        <Input
                            placeholder="Search projects..."
                            value={globalFilter ?? ""}
                            onChange={(event) => setGlobalFilter(event.target.value)}
                            className="pr-8"
                        />
                        {globalFilter && (
                            <button
                                onClick={() => setGlobalFilter("")}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className={selectedGroups.length > 0 ? "border-primary" : ""}>
                                <Filter className="mr-2 h-4 w-4" />
                                Groups
                                {selectedGroups.length > 0 && (
                                    <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                                        {selectedGroups.length}
                                    </span>
                                )}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 max-h-80 overflow-y-auto">
                            {selectedGroups.length > 0 && (
                                <div
                                    className="px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:text-foreground"
                                    onClick={clearGroups}
                                >
                                    Clear all filters
                                </div>
                            )}
                            {groupStats.map(({ name, count }) => (
                                <DropdownMenuCheckboxItem
                                    key={name}
                                    checked={selectedGroups.includes(name)}
                                    onCheckedChange={() => toggleGroup(name)}
                                >
                                    <span className="flex-1">{name}</span>
                                    <span className="ml-2 text-xs text-muted-foreground">{count}</span>
                                </DropdownMenuCheckboxItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Quick Filters - click cycles: any -> yes -> no -> any */}
                    <div className="flex items-center gap-1 flex-wrap">
                        {[
                            { key: 'running', label: 'Running', icon: Circle },
                            { key: 'uncommitted', label: 'Uncommitted' },
                            { key: 'behind', label: 'Behind' },
                            { key: 'ahead', label: 'Ahead' },
                            { key: 'hasGit', label: 'Git' },
                            { key: 'hasRemote', label: 'Remote' },
                            { key: 'hasOwnCommits', label: 'My Commits' },
                            { key: 'hasReadme', label: 'README' },
                        ].map(({ key, label, icon: Icon }) => {
                            const value = filters[key]
                            return (
                                <Button
                                    key={key}
                                    variant="outline"
                                    size="sm"
                                    onClick={() => cycleFilter(key)}
                                    className={cn(
                                        "gap-1.5",
                                        value === true && "border-green-500 bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20",
                                        value === false && "border-red-500 bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20"
                                    )}
                                >
                                    {value === true && <Check className="h-3 w-3" />}
                                    {value === false && <X className="h-3 w-3" />}
                                    {Icon && value === null && <Icon className="h-2.5 w-2.5" />}
                                    {label}
                                </Button>
                            )
                        })}
                        {activeFiltersCount > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={clearAllFilters}
                                className="text-muted-foreground"
                            >
                                <X className="mr-1 h-3 w-3" />
                                Clear ({activeFiltersCount})
                            </Button>
                        )}
                    </div>

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
                {/* Selected groups as chips */}
                {selectedGroups.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {selectedGroups.map(group => (
                            <span
                                key={group}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded-md text-sm cursor-pointer hover:bg-primary/20 transition-colors"
                                onClick={() => toggleGroup(group)}
                            >
                                {group}
                                <X className="h-3 w-3" />
                            </span>
                        ))}
                        <button
                            className="text-sm text-muted-foreground hover:text-foreground"
                            onClick={clearGroups}
                        >
                            Clear all
                        </button>
                    </div>
                )}
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
                    {table.getFilteredRowModel().rows.length} project(s)
                    {selectedGroups.length > 0 && ` (filtered from ${projects.length})`}
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