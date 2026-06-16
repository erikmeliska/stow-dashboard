import { execFile } from 'child_process'
import { promisify } from 'util'
import { readTasks } from './tasks.mjs'

const exec = promisify(execFile)
const ID_RE = /\[([A-Z]{2,}-[A-Z0-9]{2,}-\d{3,})\]/g

export async function scanDoneCommits(projectDir) {
  let stdout
  try {
    ({ stdout } = await exec('git', ['log', '--pretty=%h%x09%ad%x09%s', '--date=short'], { cwd: projectDir, maxBuffer: 1024 * 1024 * 16 }))
  } catch { return {} }
  const map = {}
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [hash, date, ...rest] = line.split('\t')
    const subject = rest.join('\t')
    for (const m of subject.matchAll(ID_RE)) {
      (map[m[1]] ||= []).push({ hash, date, subject })
    }
  }
  return map
}

export async function verifyTask(projectDir, taskId) {
  const commits = (await scanDoneCommits(projectDir))[taskId] || []
  return { taskId, hasEvidence: commits.length > 0, commits }
}

export async function auditTasks(projectDir) {
  const [tasks, map] = await Promise.all([readTasks(projectDir), scanDoneCommits(projectDir)])
  return tasks.filter(t => t.done).map(t => {
    const commits = (t.id && map[t.id]) || []
    return { ...t, hasEvidence: commits.length > 0, commits }
  })
}

export async function generateChangelog(projectDir) {
  const map = await scanDoneCommits(projectDir)
  const lines = ['# Changelog', '']
  for (const id of Object.keys(map).sort()) {
    for (const c of map[id]) {
      const subject = c.subject.replace(ID_RE, '').replace(/\s{2,}/g, ' ').trim()
      lines.push(`- ${c.date} **${id}** — ${subject} (${c.hash})`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
