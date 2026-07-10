'use client'

import * as React from "react"
import { Copy, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip"

export function CopyButton({ text, tooltip }) {
    const [copied, setCopied] = React.useState(false)

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleCopy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                <p>{copied ? 'Copied!' : tooltip}</p>
            </TooltipContent>
        </Tooltip>
    )
}
