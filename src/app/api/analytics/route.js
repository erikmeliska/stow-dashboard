import fs from 'fs/promises'
import { openStore } from '../../../lib/cc/store.mjs'
import { sessionAnalytics, portfolioAnalytics, sinceForRange } from '../../../lib/cc/analytics.mjs'
import { readProjectsData } from '../../../lib/projects.js'
import { dataFile } from '../../../lib/state-dir.mjs'

/**
 * GET /api/analytics?range=7d|30d|90d|all (default 30d)
 * → { range, sessions: {...}, portfolio: {...} }
 *
 * `range` scopes the session aggregates only; the portfolio section always
 * reflects the whole ledger. Everything is computed at request time from the
 * cc session store, projects_metadata.jsonl and usage.json.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const range = ['7d', '30d', '90d', 'all'].includes(searchParams.get('range')) ? searchParams.get('range') : '30d'

  // Opened per request (not at module eval) — see state-dir.mjs.
  const db = openStore()
  let sessions
  try {
    sessions = sessionAnalytics(db, { since: sinceForRange(range) })
  } finally {
    db.close()
  }

  const [projects, usage] = await Promise.all([
    readProjectsData(),
    fs.readFile(dataFile('usage.json'), 'utf-8').then(JSON.parse).catch(() => null),
  ])

  return Response.json({ range, sessions, portfolio: portfolioAnalytics(projects, usage) })
}
