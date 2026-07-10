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
import { ArrowUpDown, ChevronDown, GitBranch, Github, Gitlab, Check, X, FileText, Eye, Filter, Play, Circle, Container, RotateCcw, Sparkles, SquareTerminal, CheckSquare, FolderTree } from 'lucide-react'

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
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
import { formatTimeAgo, getGitProvider, docScoreColor, formatUsd } from "@/lib/utils"
import { cn } from "@/lib/utils"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"
import { ReadmeDialog } from "@/components/ReadmeDialog"
import { ProjectDetailsSheet } from "@/components/ProjectDetailsSheet"
import { ReorgReportDialog } from "@/components/ReorgReportDialog"
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

// Defaults (outside component to avoid recreation)
const defaultColumnVisibility = {
    'total_size_bytes': false,
    'git_info.remotes': false,
    'git_info.total_commits': false,
    'content_size_bytes': false,
    'scc.estimated_cost': false,
    'ai_type': false,
    'ai_status': false,
}

// Literal Tailwind classes for doc-score bar (interpolated names are stripped by Tailwind)
const DOC_SCORE_BAR_CLASS = {
    green: 'bg-green-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
}

const AI_STATUS_PILL_CLASS = {
    active: 'bg-green-500/20 text-green-600 dark:text-green-400',
    dormant: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
    dead: 'bg-muted text-muted-foreground',
    'archive-candidate': 'bg-red-500/20 text-red-600 dark:text-red-400',
}
const defaultSorting = [{ id: 'last_modified', desc: true }]

// AI facet accessors — each returns the list of values a project contributes to the facet.
// Unanalyzed / errored records contribute nothing, so they never match a selected value.
const FACET_ACCESSORS = {
    category: p => p.ai_analysis?.category ? [p.ai_analysis.category] : [],
    type:     p => p.ai_analysis?.project_type ? [p.ai_analysis.project_type] : [],
    domain:   p => p.ai_analysis?.domain ? [p.ai_analysis.domain] : [],
    maturity: p => p.ai_analysis?.maturity ? [p.ai_analysis.maturity] : [],
    tech:     p => p.ai_derived?.tech ?? [],
}
const FACET_KEYS = ['category', 'type', 'domain', 'maturity', 'tech']
const FACET_LABELS = {
    category: 'Category',
    type: 'Type',
    domain: 'Domain',
    maturity: 'Maturity',
    tech: 'Tech',
}
const TECH_FACET_CAP = 30
const emptyAiFacets = () => ({ category: [], type: [], domain: [], maturity: [], tech: [] })

// Quick filter defaults (null = any) — single source for init, clear and settings restore
const defaultFilters = () => ({
    running: null,
    hasGit: null,
    hasRemote: null,
    uncommitted: null,
    behind: null,
    ahead: null,
    hasOwnCommits: null,
    hasReadme: null,
    hasTasks: null,
    analyzed: null,
    misplaced: null,
    poorDocs: null,
})

export function ProjectTable({ projects, ownRepos }) {
    const [isHydrated, setIsHydrated] = React.useState(false)
    const [sorting, setSorting] = React.useState(defaultSorting)
    const [columnFilters, setColumnFilters] = React.useState([])
    const [columnVisibility, setColumnVisibility] = React.useState(defaultColumnVisibility)
    const [globalFilter, setGlobalFilter] = React.useState("")
    const [selectedGroups, setSelectedGroups] = React.useState([])
    const [aiFacets, setAiFacets] = React.useState(emptyAiFacets)
    const [readmeDialog, setReadmeDialog] = React.useState({ open: false, project: null })
    const [detailsSheet, setDetailsSheet] = React.useState({ open: false, project: null })
    const [reorgOpen, setReorgOpen] = React.useState(false)
    const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 20 })

    // Quick filters (null = any, true = yes, false = no)
    const [filters, setFilters] = React.useState(defaultFilters)

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
        setFilters(defaultFilters())
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    const resetToDefaults = () => {
        // Clear localStorage
        if (typeof window !== 'undefined') {
            localStorage.removeItem(STORAGE_KEY)
        }
        // Reset all states to defaults
        setSorting(defaultSorting)
        setColumnVisibility(defaultColumnVisibility)
        setPagination({ pageIndex: 0, pageSize: 20 })
        setGlobalFilter("")
        setSelectedGroups([])
        setAiFacets(emptyAiFacets())
        clearAllFilters()
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
    const { getPortsForProject, getRunningInfo, isProjectRunning } = useProcesses()

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
        if (project.ai_analysis?.generated_description?.toLowerCase().includes(search)) return true
        if (project.ai_analysis?.category?.toLowerCase().includes(search)) return true
        if (project.ai_analysis?.client?.toLowerCase().includes(search)) return true
        if (project.ai_derived?.tech?.join(' ').toLowerCase().includes(search)) return true

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

    // AI facet value counts from search-filtered projects (the tech cross-section).
    // tech sorted by count desc; the others alphabetically.
    const facetStats = React.useMemo(() => {
        const stats = {}
        for (const facet of FACET_KEYS) {
            const counts = {}
            searchFilteredProjects.forEach(project => {
                FACET_ACCESSORS[facet](project).forEach(value => {
                    if (!value) return
                    counts[value] = (counts[value] || 0) + 1
                })
            })
            const entries = Object.entries(counts).map(([value, count]) => ({ value, count }))
            if (facet === 'tech') {
                entries.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
            } else {
                entries.sort((a, b) => a.value.localeCompare(b.value))
            }
            stats[facet] = entries
        }
        return stats
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

        // AI facet filters (OR within a facet, AND across facets — same as groups)
        for (const facet of FACET_KEYS) {
            const selected = aiFacets[facet]
            if (selected.length > 0) {
                result = result.filter(project =>
                    FACET_ACCESSORS[facet](project).some(value => selected.includes(value))
                )
            }
        }

        // Quick filters (null = any, true = must have, false = must not have)
        if (filters.running !== null) {
            result = result.filter(project => {
                const isRunning = isProjectRunning(project.directory)
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

        if (filters.hasTasks !== null) {
            result = result.filter(project => {
                const hasTasks = (project.openTaskCount || 0) > 0
                return filters.hasTasks ? hasTasks : !hasTasks
            })
        }

        if (filters.analyzed !== null) {
            result = result.filter(project => {
                const isAnalyzed = project.ai_analysis && !project.ai_analysis.error
                return filters.analyzed ? isAnalyzed : !isAnalyzed
            })
        }

        if (filters.misplaced !== null) {
            result = result.filter(project => {
                const placementOk = project.ai_derived?.placement_ok
                // records without ai_derived match neither yes nor no
                return filters.misplaced ? placementOk === false : placementOk === true
            })
        }

        if (filters.poorDocs !== null) {
            result = result.filter(project => {
                const score = project.ai_analysis?.doc_score ?? -1
                const isPoor = score >= 0 && score < 50
                const isGood = score >= 50
                return filters.poorDocs ? isPoor : isGood
            })
        }

        return result
    }, [searchFilteredProjects, selectedGroups, aiFacets, filters, getPortsForProject, isProjectRunning])

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

    const toggleFacet = (facet, value) => {
        setAiFacets(prev => {
            const selected = prev[facet]
            const next = selected.includes(value)
                ? selected.filter(v => v !== value)
                : [...selected, value]
            return { ...prev, [facet]: next }
        })
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    const clearFacets = () => {
        setAiFacets(emptyAiFacets())
        setPagination(prev => ({ ...prev, pageIndex: 0 }))
    }

    const facetSelectionCount = FACET_KEYS.reduce((sum, f) => sum + aiFacets[f].length, 0)

    // Auto-remove selected groups that no longer exist in filtered results
    React.useEffect(() => {
        const availableGroups = new Set(groupStats.map(g => g.name))
        const validGroups = selectedGroups.filter(g => availableGroups.has(g))
        if (validGroups.length !== selectedGroups.length) {
            setSelectedGroups(validGroups)
        }
    }, [groupStats, selectedGroups])

    // Auto-remove selected facet values that no longer exist in the filtered facet stats
    React.useEffect(() => {
        setAiFacets(prev => {
            let changed = false
            const next = {}
            for (const facet of FACET_KEYS) {
                const available = new Set(facetStats[facet].map(e => e.value))
                const valid = prev[facet].filter(v => available.has(v))
                if (valid.length !== prev[facet].length) changed = true
                next[facet] = valid
            }
            return changed ? next : prev
        })
    }, [facetStats])

    // Load settings from localStorage on mount
    React.useEffect(() => {
        const settings = loadSettings()
        if (settings) {
            if (settings.sorting) setSorting(settings.sorting)
            if (settings.columnVisibility) setColumnVisibility({ ...defaultColumnVisibility, ...settings.columnVisibility })
            if (settings.pageSize) setPagination(prev => ({ ...prev, pageSize: settings.pageSize }))
            if (settings.filters) setFilters({ ...defaultFilters(), ...settings.filters })
            if (settings.globalFilter) setGlobalFilter(settings.globalFilter)
            if (settings.selectedGroups) setSelectedGroups(settings.selectedGroups)
            if (settings.aiFacets) setAiFacets({ ...emptyAiFacets(), ...settings.aiFacets })
        }
        setIsHydrated(true)
    }, [])

    // Save settings to localStorage on change
    React.useEffect(() => {
        if (!isHydrated) return
        saveSettings({
            sorting,
            columnVisibility,
            pageSize: pagination.pageSize,
            filters,
            globalFilter,
            selectedGroups,
            aiFacets
        })
    }, [sorting, columnVisibility, pagination.pageSize, filters, globalFilter, selectedGroups, aiFacets, isHydrated])
    
    const columns = [
        {
            accessorKey: "project_name",
            header: "Project",
            cell: ({ row }) => {
                const name = row.getValue("project_name")
                return (
                    <div className="capitalize truncate max-w-[140px]" title={name}>
                        {name}
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
                    <div className="flex gap-0.5 flex-wrap max-w-[120px]">
                        {parts.slice(0, 3).map((part, index) => (
                            <span
                                key={index}
                                className="px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-xs truncate max-w-[80px]"
                                title={part}
                            >
                                {part}
                            </span>
                        ))}
                        {parts.length > 3 && (
                            <span className="text-xs text-muted-foreground">+{parts.length - 3}</span>
                        )}
                    </div>
                )
            },
        },
        {
            accessorKey: "projectDir",
            header: "Dir",
            cell: ({ row }) => (
                <div className="text-sm text-muted-foreground truncate max-w-[100px]" title={row.getValue("projectDir")}>
                    {row.getValue("projectDir")}
                </div>
            ),
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
            header: "Repo",
            cell: ({ row }) => {
                const gitInfo = row.original.git_info
                const remotes = gitInfo?.remotes || []
                if (!gitInfo?.git_detected || remotes.length === 0) return null

                const repoName = extractRepoName(remotes[0])
                const isOwnRepo = ownRepos.includes(repoName)

                return (
                    <span
                        className={cn(
                            "px-1.5 py-0.5 rounded text-xs truncate max-w-[70px] inline-block",
                            isOwnRepo
                                ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100"
                                : "bg-secondary text-secondary-foreground"
                        )}
                        title={repoName}
                    >
                        {repoName}
                    </span>
                )
            },
        },
        {
            accessorKey: "last_modified",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Modified
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const date = row.getValue("last_modified")
                return <div className="text-sm whitespace-nowrap"><TimeAgo date={date} /></div>
            },
        },
        {
            accessorKey: "content_size_bytes",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Size
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const bytes = row.getValue("content_size_bytes")
                if (!bytes) return <span className="text-muted-foreground text-sm">-</span>
                return <span className="text-sm whitespace-nowrap">{(bytes / 1024 / 1024).toFixed(1)}M</span>
            },
        },
        {
            accessorKey: "total_size_bytes",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Total
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const bytes = row.getValue("total_size_bytes")
                if (!bytes) return <span className="text-muted-foreground text-sm">-</span>
                return <span className="text-sm whitespace-nowrap">{(bytes / 1024 / 1024).toFixed(1)}M</span>
            },
        },
        {
            accessorKey: "git_info.total_commits",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Commits
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const gitInfo = row.original.git_info

                if (!gitInfo?.git_detected || !gitInfo?.total_commits) {
                    return null
                }

                const totalCommits = gitInfo.total_commits
                const userCommits = gitInfo.user_commits || 0

                return (
                    <div className="flex items-center gap-1">
                        <span className="px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-xs">
                            {totalCommits}
                        </span>
                        {userCommits > 0 && (
                            <span className="px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100 rounded text-xs">
                                {userCommits}
                            </span>
                        )}
                    </div>
                )
            },
        },
        {
            accessorKey: "scc.total_code",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Lines
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const code = row.original.scc?.total_code
                if (!code) return <span className="text-muted-foreground text-sm">-</span>
                if (code >= 1000) return <span className="text-sm whitespace-nowrap">{(code / 1000).toFixed(1)}k</span>
                return <span className="text-sm">{code}</span>
            },
        },
        {
            accessorKey: "scc.estimated_cost",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Value
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const cost = row.original.scc?.estimated_cost
                if (!cost) return <span className="text-muted-foreground text-sm">-</span>
                if (cost >= 1000000) return <span className="text-sm whitespace-nowrap">${(cost / 1000000).toFixed(1)}M</span>
                if (cost >= 1000) return <span className="text-sm whitespace-nowrap">${(cost / 1000).toFixed(0)}k</span>
                return <span className="text-sm">${cost}</span>
            },
        },
        {
            accessorKey: "openTaskCount",
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Tasks
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const count = row.original.openTaskCount || 0
                if (count === 0) return null
                return (
                    <span
                        className="flex items-center gap-1 w-fit text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400"
                        title={`${count} open task${count === 1 ? '' : 's'}`}
                    >
                        <CheckSquare className="h-3 w-3" />
                        {count}
                    </span>
                )
            },
        },
        {
            id: "running",
            header: "Running",
            cell: ({ row }) => {
                const project = row.original
                const info = getRunningInfo(project.directory)

                if (!info.isRunning) return null

                const tooltipParts = []
                if (info.hasProcesses) {
                    const hosts = info.processes.map(p => p.hostLabel).filter(Boolean)
                    const hostSuffix = hosts.length > 0 ? ` (${[...new Set(hosts)].join(', ')})` : ''
                    tooltipParts.push(`${info.processes.length} process${info.processes.length > 1 ? 'es' : ''}${hostSuffix}`)
                }
                if (info.hasClaude) {
                    const hosts = info.claude.map(c => c.hostLabel).filter(Boolean)
                    const hostSuffix = hosts.length > 0 ? ` (${[...new Set(hosts)].join(', ')})` : ''
                    tooltipParts.push(`${info.claude.length} Claude session${info.claude.length > 1 ? 's' : ''}${hostSuffix}`)
                }
                if (info.hasTerminals) {
                    const hosts = info.terminals.map(t => t.hostLabel).filter(Boolean)
                    const hostSuffix = hosts.length > 0 ? ` (${[...new Set(hosts)].join(', ')})` : ''
                    tooltipParts.push(`${info.terminals.length} open terminal${info.terminals.length > 1 ? 's' : ''}${hostSuffix}`)
                }
                if (info.hasDocker) {
                    tooltipParts.push(`${info.docker.length} container${info.docker.length > 1 ? 's' : ''}`)
                }
                if (info.ports.length > 0) {
                    tooltipParts.push(`port${info.ports.length > 1 ? 's' : ''}: ${info.ports.join(', ')}`)
                }

                return (
                    <TooltipProvider delayDuration={300}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="flex items-center gap-1.5 cursor-default">
                                    {info.hasProcesses && (
                                        <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 dark:text-green-400">
                                            <Circle className="h-2 w-2 fill-current" />
                                            {info.processes.length}
                                        </span>
                                    )}
                                    {info.hasClaude && (
                                        <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-600 dark:text-purple-400">
                                            <Sparkles className="h-3 w-3" />
                                            {info.claude.length}
                                        </span>
                                    )}
                                    {info.hasTerminals && (
                                        <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400">
                                            <SquareTerminal className="h-3 w-3" />
                                            {info.terminals.length}
                                        </span>
                                    )}
                                    {info.hasDocker && (
                                        <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400">
                                            <Container className="h-3 w-3" />
                                            {info.docker.length}
                                        </span>
                                    )}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{tooltipParts.join(' • ')}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )
            },
        },
        {
            id: "ai_category",
            accessorFn: row => row.ai_analysis?.category ?? '',
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Category
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const ai = row.original.ai_analysis
                const category = ai?.category
                if (!ai || ai.error || !category) {
                    return <span className="text-muted-foreground text-sm">—</span>
                }
                const client = ai.client
                const label = category.replace(/^_/, '') + (client ? `/${client}` : '')
                return (
                    <span
                        className="px-1.5 py-0.5 rounded text-xs truncate max-w-[130px] inline-block bg-violet-500/20 text-violet-600 dark:text-violet-400"
                        title={ai.generated_description || label}
                    >
                        {label}
                    </span>
                )
            },
        },
        {
            id: "ai_doc_score",
            accessorFn: row => row.ai_analysis?.doc_score ?? -1,
            sortDescFirst: true,
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        Docs
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const score = row.getValue("ai_doc_score")
                if (score < 0) return <span className="text-muted-foreground text-sm">—</span>
                const color = docScoreColor(score)
                return (
                    <div className="flex items-center gap-1.5">
                        <span className="text-sm tabular-nums w-6">{score}</span>
                        <div className="h-1.5 w-10 rounded bg-muted">
                            <div
                                className={cn('h-1.5 rounded', DOC_SCORE_BAR_CLASS[color])}
                                style={{ width: `${score}%` }}
                            />
                        </div>
                    </div>
                )
            },
        },
        {
            id: "ai_type",
            accessorFn: row => row.ai_analysis?.project_type ?? '',
            header: "Type",
            cell: ({ row }) => {
                const type = row.getValue("ai_type")
                if (!type) return <span className="text-muted-foreground text-sm">—</span>
                return <span className="text-sm whitespace-nowrap">{type}</span>
            },
        },
        {
            id: "ai_status",
            accessorFn: row => row.ai_derived?.status ?? '',
            header: "AI Status",
            cell: ({ row }) => {
                const status = row.getValue("ai_status")
                if (!status) return <span className="text-muted-foreground text-sm">—</span>
                return (
                    <span className={cn(
                        "px-1.5 py-0.5 rounded text-xs whitespace-nowrap",
                        AI_STATUS_PILL_CLASS[status] || 'bg-muted text-muted-foreground'
                    )}>
                        {status}
                    </span>
                )
            },
        },
        {
            id: "ai_cost",
            accessorFn: row => row.usage ? (row.usage.costUsd ?? 0) + (row.usage.costUnverifiedUsd ?? 0) : -1,
            sortDescFirst: true,
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 -ml-2"
                        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    >
                        AI $
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                )
            },
            cell: ({ row }) => {
                const total = row.getValue("ai_cost")
                if (total < 0) return <span className="text-muted-foreground text-sm">—</span>
                const usage = row.original.usage
                const unverifiedOnly = (usage.costUsd ?? 0) === 0 && (usage.costUnverifiedUsd ?? 0) > 0
                const t = usage.tokens || {}
                const inTokens = (t.input ?? 0) + (t.codexInput ?? 0)
                const outTokens = (t.output ?? 0) + (t.codexOutput ?? 0)
                const fmtTokens = n => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`
                const title = `${usage.sessions} sessions · ${((usage.activeMinutes ?? 0) / 60).toFixed(1)} h · in ${fmtTokens(inTokens)} out ${fmtTokens(outTokens)} tokens · list-price value, not an invoice`
                return (
                    <span className="text-sm whitespace-nowrap tabular-nums" title={title}>
                        {unverifiedOnly ? '~' : ''}{formatUsd(total)}
                    </span>
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

            // Vyhľadávanie v AI analýze
            const ai = row.original.ai_analysis
            if (ai?.generated_description?.toLowerCase().includes(searchValue)) return true
            if (ai?.category?.toLowerCase().includes(searchValue)) return true
            if (ai?.client?.toLowerCase().includes(searchValue)) return true
            if (row.original.ai_derived?.tech?.join(' ').toLowerCase().includes(searchValue)) return true

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

    // Re-derive the open sheet's project from fresh props so router.refresh()
    // (e.g. after Re-analyze) propagates updated data into the open sheet.
    // Fall back to the open-time snapshot if the record vanished from props.
    const openSheetProject = detailsSheet.project
        ? (projects.find(p => p.id === detailsSheet.project.id) ?? detailsSheet.project)
        : null

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
            project={openSheetProject}
        />
        <ReorgReportDialog
            open={reorgOpen}
            onOpenChange={setReorgOpen}
            projects={projects}
            onOpenProject={(p) => setDetailsSheet({ open: true, project: p })}
        />
        <div className="h-full flex flex-col min-w-0">
            {/* Filters - fixed */}
            <div className="flex-none flex flex-col gap-2 py-2">
                {/* Row 1: Search + Columns */}
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[200px] max-w-sm">
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
                            <Button variant="outline" size="sm" className={selectedGroups.length > 0 ? "border-primary" : ""}>
                                <Filter className="mr-1.5 h-4 w-4" />
                                <span className="hidden sm:inline">Groups</span>
                                {selectedGroups.length > 0 && (
                                    <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
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

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className={facetSelectionCount > 0 ? "border-primary" : ""}>
                                <Sparkles className="mr-1.5 h-4 w-4" />
                                <span className="hidden sm:inline">AI filters</span>
                                {facetSelectionCount > 0 && (
                                    <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                                        {facetSelectionCount}
                                    </span>
                                )}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-52">
                            {facetSelectionCount > 0 && (
                                <div
                                    className="px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:text-foreground"
                                    onClick={clearFacets}
                                >
                                    Clear all AI filters
                                </div>
                            )}
                            {FACET_KEYS.map(facet => {
                                const entries = facetStats[facet]
                                const shown = facet === 'tech' ? entries.slice(0, TECH_FACET_CAP) : entries
                                const hiddenCount = entries.length - shown.length
                                const selectedInFacet = aiFacets[facet].length
                                return (
                                    <DropdownMenuSub key={facet}>
                                        <DropdownMenuSubTrigger disabled={entries.length === 0}>
                                            <span className="flex-1">{FACET_LABELS[facet]}</span>
                                            {selectedInFacet > 0 && (
                                                <span className="ml-2 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                                                    {selectedInFacet}
                                                </span>
                                            )}
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                                            {shown.map(({ value, count }) => (
                                                <DropdownMenuCheckboxItem
                                                    key={value}
                                                    checked={aiFacets[facet].includes(value)}
                                                    onCheckedChange={() => toggleFacet(facet, value)}
                                                    onSelect={(e) => e.preventDefault()}
                                                >
                                                    <span className="flex-1">{value.replace(/^_/, '')}</span>
                                                    <span className="ml-2 text-xs text-muted-foreground">{count}</span>
                                                </DropdownMenuCheckboxItem>
                                            ))}
                                            {hiddenCount > 0 && (
                                                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                                    +{hiddenCount} more
                                                </div>
                                            )}
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                )
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                                <span className="hidden sm:inline">Columns</span>
                                <ChevronDown className="sm:ml-1.5 h-4 w-4" />
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

                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setReorgOpen(true)}
                    >
                        <FolderTree className="sm:mr-1.5 h-4 w-4" />
                        <span className="hidden sm:inline">Reorg</span>
                    </Button>

                    <TooltipProvider delayDuration={300}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                    onClick={resetToDefaults}
                                >
                                    <RotateCcw className="h-4 w-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>Reset to defaults</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>

                {/* Row 2: Quick Filters */}
                <div className="flex items-center gap-1 flex-wrap">
                    {[
                        { key: 'running', label: 'Running', shortLabel: 'Run' },
                        { key: 'uncommitted', label: 'Uncommitted', shortLabel: 'Dirty' },
                        { key: 'behind', label: 'Behind', shortLabel: '↓' },
                        { key: 'ahead', label: 'Ahead', shortLabel: '↑' },
                        { key: 'hasGit', label: 'Git', shortLabel: 'Git' },
                        { key: 'hasRemote', label: 'Remote', shortLabel: 'Rem' },
                        { key: 'hasOwnCommits', label: 'My Commits', shortLabel: 'Mine' },
                        { key: 'hasReadme', label: 'README', shortLabel: 'Docs' },
                        { key: 'hasTasks', label: 'Tasks', shortLabel: 'Task' },
                        { key: 'analyzed', label: 'Analyzed', shortLabel: 'AI' },
                        { key: 'misplaced', label: 'Misplaced', shortLabel: 'Mispl' },
                        { key: 'poorDocs', label: 'Poor docs', shortLabel: 'Docs' },
                    ].map(({ key, label, shortLabel }) => {
                        const value = filters[key]
                        return (
                            <Button
                                key={key}
                                variant="outline"
                                size="sm"
                                onClick={() => cycleFilter(key)}
                                className={cn(
                                    "h-6 px-2 text-xs",
                                    value === true && "border-green-500 bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20",
                                    value === false && "border-red-500 bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20"
                                )}
                                title={label}
                            >
                                {value === true && <Check className="h-3 w-3 mr-0.5" />}
                                {value === false && <X className="h-3 w-3 mr-0.5" />}
                                <span className="hidden sm:inline">{label}</span>
                                <span className="sm:hidden">{shortLabel}</span>
                            </Button>
                        )
                    })}
                    {activeFiltersCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={clearAllFilters}
                            className="h-6 px-1.5 text-xs text-muted-foreground"
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                </div>

                {/* Selected groups as chips */}
                {selectedGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {selectedGroups.map(group => (
                            <span
                                key={group}
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs cursor-pointer hover:bg-primary/20 transition-colors"
                                onClick={() => toggleGroup(group)}
                            >
                                {group}
                                <X className="h-3 w-3" />
                            </span>
                        ))}
                        <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={clearGroups}
                        >
                            Clear all
                        </button>
                    </div>
                )}

                {/* Selected AI facets as chips */}
                {facetSelectionCount > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {FACET_KEYS.flatMap(facet =>
                            aiFacets[facet].map(value => (
                                <span
                                    key={`${facet}:${value}`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-500/10 text-violet-600 dark:text-violet-400 rounded text-xs cursor-pointer hover:bg-violet-500/20 transition-colors"
                                    onClick={() => toggleFacet(facet, value)}
                                >
                                    {facet}: {value.replace(/^_/, '')}
                                    <X className="h-3 w-3" />
                                </span>
                            ))
                        )}
                        <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={clearFacets}
                        >
                            Clear all
                        </button>
                    </div>
                )}
            </div>
            {/* Table - scrollable */}
            <div className="flex-1 overflow-auto rounded-md border">
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
            {/* Pagination - fixed */}
            <div className="flex-none flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 py-2 border-t">
                <div className="text-sm text-muted-foreground">
                    {table.getFilteredRowModel().rows.length} project(s)
                    {selectedGroups.length > 0 && ` (filtered)`}
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                    <div className="flex items-center gap-2">
                        <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Rows</p>
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
                    <div className="flex items-center gap-2">
                        <p className="text-xs sm:text-sm text-muted-foreground">
                            {table.getState().pagination.pageIndex + 1}/{table.getPageCount()}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 sm:px-3"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <span className="hidden sm:inline">Previous</span>
                            <span className="sm:hidden">←</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 sm:px-3"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <span className="hidden sm:inline">Next</span>
                            <span className="sm:hidden">→</span>
                        </Button>
                    </div>
                </div>
            </div>
        </div>
        </>
    )
}