import { listScripts } from '@/lib/scripts.mjs'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const directory = searchParams.get('directory')
  if (!directory) return Response.json({ error: 'Directory is required' }, { status: 400 })
  return Response.json({ scripts: await listScripts(directory) })
}
