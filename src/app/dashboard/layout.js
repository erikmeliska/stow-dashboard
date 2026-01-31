"use client"

import { Sidebar } from "@/components/ui/sidebar"

export default function DashboardLayout({ children }) {
    return (
        <div className="flex h-screen overflow-hidden">
            {/* <Sidebar className="w-64 h-full" /> */}
            <main className="flex-1 overflow-y-auto bg-background">
                {children}
            </main>
        </div>
    );
}
