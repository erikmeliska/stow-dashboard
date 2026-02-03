import { NextResponse } from 'next/server'
import simpleGit from 'simple-git'

export async function GET(request) {
    const { searchParams } = new URL(request.url)
    const directory = searchParams.get('directory')

    if (!directory) {
        return NextResponse.json({ error: 'Directory is required' }, { status: 400 })
    }

    try {
        const git = simpleGit(directory)
        const isRepo = await git.checkIsRepo()

        if (!isRepo) {
            return NextResponse.json({
                isGitRepo: false
            })
        }

        const [status, log] = await Promise.all([
            git.status(),
            git.log({ maxCount: 1 }).catch(() => null)
        ])

        const lastCommit = log?.latest

        return NextResponse.json({
            isGitRepo: true,
            uncommittedChanges: status.files.length,
            isClean: status.isClean(),
            staged: status.staged.length,
            modified: status.modified.length,
            untracked: status.not_added.length,
            lastCommitMessage: lastCommit?.message || null,
            lastCommitAuthor: lastCommit?.author_name || null,
            lastCommitDate: lastCommit?.date || null
        })
    } catch (error) {
        return NextResponse.json({
            error: 'Failed to get project details',
            details: error.message
        }, { status: 500 })
    }
}
