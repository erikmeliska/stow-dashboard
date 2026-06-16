import { readFile, writeFile } from 'fs/promises'

export function parseIntake(content) {
  const items = []
  if (!content) return items
  for (const line of content.split('\n')) {
    const m = line.match(/^-\s*\[([ xX])\]\s*(?:\(([^,)]+),\s*(P\d)\)\s*)?(.*)$/)
    if (!m) continue
    let text = m[4].trim()
    let source = null
    const sm = text.match(/\s+—\s+from\s+(.+)$/)
    if (sm) { source = sm[1].trim(); text = text.slice(0, sm.index).trim() }
    const project = m[2] ? m[2].trim() : null
    items.push({ done: m[1].toLowerCase() === 'x', project: project === '?' ? null : project, priority: m[3] || null, text, source })
  }
  return items
}

export function serializeIntake(items) {
  const lines = ['## Inbox', '']
  for (const it of items) {
    const box = it.done ? 'x' : ' '
    const route = (it.project || it.priority) ? `(${it.project || '?'}, ${it.priority || 'P2'}) ` : ''
    const src = it.source ? ` — from ${it.source}` : ''
    lines.push(`- [${box}] ${route}${it.text}${src}`)
  }
  lines.push('')
  return lines.join('\n')
}

export async function readIntake(file) {
  try { return parseIntake(await readFile(file, 'utf-8')) } catch { return [] }
}

export async function appendIntake(file, item) {
  const items = await readIntake(file)
  const entry = { done: false, project: item.project ?? null, priority: item.priority ?? null, text: item.text, source: item.source ?? null }
  items.push(entry)
  await writeFile(file, serializeIntake(items), 'utf-8')
  return entry
}

export async function removeIntake(file, matchFn) {
  const items = await readIntake(file)
  const removed = items.filter(matchFn)
  const kept = items.filter(it => !matchFn(it))
  await writeFile(file, serializeIntake(kept), 'utf-8')
  return removed
}
