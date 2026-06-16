import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'

const TASKS_FILE = 'TASKS.md'

export function parseTasks(content) {
  const tasks = []
  if (!content) return tasks
  let priority = 'P2'
  for (const line of content.split('\n')) {
    const ph = line.match(/^##\s*(P\d)\s*$/)
    if (ph) { priority = ph[1]; continue }
    const tm = line.match(/^-\s*\[([ xX])\]\s*(?:\[([A-Z0-9-]+)\]\s*)?(.*)$/)
    if (!tm) continue
    let text = tm[3].trim()
    let source = null
    const sm = text.match(/\s+—\s+from\s+(.+)$/)
    if (sm) { source = sm[1].trim(); text = text.slice(0, sm.index).trim() }
    tasks.push({ done: tm[1].toLowerCase() === 'x', id: tm[2] || null, text, source, priority })
  }
  return tasks
}

export function serializeTasks(tasks) {
  const lines = ['# Tasks', '']
  const priorities = [...new Set(tasks.map(t => t.priority || 'P2'))].sort()
  for (const p of priorities) {
    lines.push(`## ${p}`)
    for (const t of tasks.filter(t => (t.priority || 'P2') === p)) {
      const box = t.done ? 'x' : ' '
      const id = t.id ? `[${t.id}] ` : ''
      const src = t.source ? ` — from ${t.source}` : ''
      lines.push(`- [${box}] ${id}${t.text}${src}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export async function readTasks(dir) {
  try {
    return parseTasks(await readFile(path.join(dir, TASKS_FILE), 'utf-8'))
  } catch {
    return []
  }
}

export async function writeTasks(dir, tasks) {
  await writeFile(path.join(dir, TASKS_FILE), serializeTasks(tasks), 'utf-8')
}

export async function allocateTaskId(dir, prefix) {
  const seqPath = path.join(dir, '.stow', 'seq')
  let n = 0
  try { n = parseInt(await readFile(seqPath, 'utf-8'), 10) || 0 } catch { /* first id */ }
  n += 1
  await mkdir(path.dirname(seqPath), { recursive: true })
  await writeFile(seqPath, String(n), 'utf-8')
  return `${prefix}-${String(n).padStart(4, '0')}`
}

export function taskPrefix(groupParts, projectName) {
  const parts = (groupParts || []).filter(g => g && !g.startsWith('_'))
  const client = parts.length ? parts[parts.length - 1] : 'PRJ'
  const clientCode = (client.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase()) || 'PRJ'
  const seg = (projectName || 'proj').split(/[-_ ]/)[0]
  const projCode = (seg.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()) || 'PROJ'
  return `${clientCode}-${projCode}`
}

export async function addTask(dir, { text, priority = 'P2', source = null, prefix, id }) {
  const taskId = id ?? (prefix ? await allocateTaskId(dir, prefix) : null)
  const tasks = await readTasks(dir)
  const task = { done: false, id: taskId, text, source, priority }
  tasks.push(task)
  await writeTasks(dir, tasks)
  return task
}
