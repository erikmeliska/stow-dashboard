import { readProjectsData } from '@/lib/projects'
import { readTasks } from '@/lib/tasks.mjs'
import { getBaseDir } from '@/lib/scan-roots.mjs'

function computeGroupParts(directory) {
  const relativePath = directory.replace(getBaseDir(), '')
  const parts = relativePath.split('/').filter(Boolean)
  return parts.slice(0, -1)
}

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const client = searchParams.get('client')
  const priority = searchParams.get('priority')
  const status = searchParams.get('status') || 'open' // open | done | all

  const projects = await readProjectsData()
  const out = []

  for (const p of projects) {
    const groupParts = computeGroupParts(p.directory)
    if (groupParts.includes('_Sandbox')) continue
    let tasks = []
    try { tasks = await readTasks(p.directory) } catch { /* no TASKS.md */ }

    for (const t of tasks) {
      if (status === 'open' && t.done) continue
      if (status === 'done' && !t.done) continue
      if (priority && t.priority !== priority) continue
      if (client && !groupParts.some(g => String(g).toLowerCase() === client.toLowerCase())) continue
      out.push({ ...t, project: p.project_name, directory: p.directory, group: groupParts })
    }
  }

  return Response.json({ tasks: out })
}
