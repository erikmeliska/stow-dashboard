'use client'

import * as React from "react"
import { FileText, Loader2 } from "lucide-react"
import Markdown from "react-markdown"

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"

export function ReadmeDialog({ open, onOpenChange, projectName, directory }) {
    const [content, setContent] = React.useState(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState(null)

    React.useEffect(() => {
        if (open && directory) {
            setLoading(true)
            setError(null)
            setContent(null)

            fetch(`/api/readme?directory=${encodeURIComponent(directory)}`)
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        setError(data.error)
                    } else {
                        setContent(data.content)
                    }
                })
                .catch(() => {
                    setError('Failed to load README')
                })
                .finally(() => {
                    setLoading(false)
                })
        }
    }, [open, directory])

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FileText className="h-5 w-5" />
                        {projectName} - README
                    </DialogTitle>
                </DialogHeader>
                <div className="prose prose-sm dark:prose-invert max-w-none">
                    {loading && (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin" />
                        </div>
                    )}
                    {error && (
                        <div className="text-muted-foreground text-center py-8">
                            {error === 'README not found'
                                ? 'Tento projekt nemá README súbor.'
                                : error
                            }
                        </div>
                    )}
                    {content && <Markdown>{content}</Markdown>}
                </div>
            </DialogContent>
        </Dialog>
    )
}
