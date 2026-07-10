import { existsSync } from 'fs'
import path from 'path'
import { readProjectsData } from '@/lib/projects'
import { auditTasks } from '@/lib/history.mjs'
import { getBaseDir } from '@/lib/scan-roots.mjs'

function computeGroupParts(directory) {
  const relativePath = directory.replace(getBaseDir(), '')
  const parts = relativePath.split('/').filter(Boolean)
  return parts.slice(0, -1)
}

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const client = searchParams.get('client')
  const evidence = searchParams.get('evidence') // 'verified' | 'flagged' | undefined(all)

  const projects = await readProjectsData()
  const out = []

  for (const p of projects) {
    if (!existsSync(path.join(p.directory, 'TASKS.md'))) continue // skip projects w/o tasks

    const groupParts = computeGroupParts(p.directory)
    if (groupParts.includes('_Sandbox')) continue

    if (client && !groupParts.some(g => String(g).toLowerCase() === client.toLowerCase())) continue

    let audit = []
    try { audit = await auditTasks(p.directory) } catch { /* not git / no tasks */ }

    for (const t of audit) {
      if (evidence === 'verified' && !t.hasEvidence) continue
      if (evidence === 'flagged' && t.hasEvidence) continue
      out.push({ ...t, project: p.project_name, directory: p.directory, group: groupParts })
    }
  }

  return Response.json({ tasks: out })
}
