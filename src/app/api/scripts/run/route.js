import { runScript } from '@/lib/scripts.mjs'

export async function POST(request) {
  const { directory, script } = await request.json()
  if (!directory || !script) return Response.json({ error: 'Directory and script are required' }, { status: 400 })
  try {
    const result = await runScript(directory, script)
    return Response.json({ success: true, ...result })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
}
