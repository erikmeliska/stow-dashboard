import { readFile, writeFile } from 'fs/promises'
import path from 'path'

const STATUS_FILE = 'STATUS.md'

function extractSection(body, heading) {
  const re = new RegExp(`^##\\s*${heading}\\s*$`, 'm')
  const m = re.exec(body)
  if (!m) return null
  const rest = body.slice(m.index + m[0].length)
  const nextIdx = rest.search(/\n##\s/)
  return (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).replace(/^\n+/, '').replace(/\s+$/, '')
}

export function parseStatus(content) {
  const result = { status: null, updated: null, next: null, links: [], notes: '' }
  if (!content) return result
  let body = content
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    body = content.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) continue
      if (m[1] === 'status') result.status = m[2].trim()
      if (m[1] === 'updated') result.updated = m[2].trim()
    }
  }
  const nextM = body.match(/^NEXT:\s*(.*)$/m)
  if (nextM) result.next = nextM[1].trim()
  const linksSection = extractSection(body, 'Links')
  if (linksSection) {
    for (const line of linksSection.split('\n')) {
      const lm = line.match(/^-\s*(\S+)(?:\s+[—-]\s*(.*))?$/)
      if (lm) result.links.push({ url: lm[1], label: (lm[2] || '').trim() })
    }
  }
  const notesSection = extractSection(body, 'Notes')
  if (notesSection) result.notes = notesSection
  return result
}

export function serializeStatus({ status = 'active', updated = '', next = '', links = [], notes = '' }) {
  const lines = ['---', `status: ${status}`, `updated: ${updated}`, '---', '', `NEXT: ${next}`, '', '## Links']
  for (const l of links) lines.push(`- ${l.url}${l.label ? ` — ${l.label}` : ''}`)
  if (notes) { lines.push('', '## Notes', notes) }
  lines.push('')
  return lines.join('\n')
}

export async function readStatus(projectDir) {
  try {
    return parseStatus(await readFile(path.join(projectDir, STATUS_FILE), 'utf-8'))
  } catch {
    return parseStatus('')
  }
}

export async function writeStatus(projectDir, fields) {
  const current = await readStatus(projectDir)
  const merged = { ...current, ...fields }
  merged.updated = fields.updated ?? merged.updated ?? new Date().toISOString().slice(0, 10)
  await writeFile(path.join(projectDir, STATUS_FILE), serializeStatus(merged), 'utf-8')
  return merged
}
