import { writeFile } from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeStatus } from './status.mjs'

const exec = promisify(execFile)
const BRIEF_FILE = 'BRIEF.md'

export function serializeBrief({ taskId = null, text, date }) {
  const header = taskId ? `# Brief: ${taskId}` : '# Brief'
  return `${header}\n\n${text}\n\n---\nDispatched: ${date}\n`
}

export async function writeBrief(projectDir, { taskId = null, text, date, setNext = true }) {
  const d = date || new Date().toISOString().slice(0, 10)
  const briefPath = path.join(projectDir, BRIEF_FILE)
  await writeFile(briefPath, serializeBrief({ taskId, text, date: d }), 'utf-8')
  if (setNext) {
    await writeStatus(projectDir, { next: `Execute BRIEF.md${taskId ? ` (${taskId})` : ''}`, updated: d })
  }
  return briefPath
}

export function claudeDesktopArgs(projectDir) {
  return ['-a', 'Claude', projectDir]
}

export async function openInClaudeDesktop(projectDir) {
  try { await exec('open', claudeDesktopArgs(projectDir)); return true }
  catch { return false }
}
