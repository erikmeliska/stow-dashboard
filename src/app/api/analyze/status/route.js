import { getAnalysisStatus } from '@/lib/analyze-batch.mjs'

export async function GET() {
  return Response.json(getAnalysisStatus())
}
