import { exportAgentOffice } from '@/lib/registry/agent-office-export.mjs'

// The agent-office export (#14), built per request. Read-only: the file
// data/agent-office.json is written only by `npm run registry:export`.
export async function GET(request) {
    const q = new URL(request.url).searchParams
    try {
        const { doc } = await exportAgentOffice({
            includeUnassigned: q.get('unassigned') === '1',
            client: q.get('client') || undefined,
            write: false,
        })
        return Response.json(doc)
    } catch (error) {
        const status = error.code === 'UNKNOWN_CLIENT' ? 404 : 500
        return Response.json({ error: error.message }, { status })
    }
}
