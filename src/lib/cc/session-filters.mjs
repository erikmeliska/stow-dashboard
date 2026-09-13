/**
 * Client-side filters for the /sessions table. Pure over the session rows the
 * API already returns (ticket_id, quality_score) — no extra queries.
 */

/** Menu order matters: rendered top-to-bottom in the quality <select>. */
export const QUALITY_FILTERS = {
  any: { label: 'Quality: any', test: () => true },
  q90: { label: '≥ 90', test: (s) => s.quality_score != null && s.quality_score >= 90 },
  q75: { label: '≥ 75', test: (s) => s.quality_score != null && s.quality_score >= 75 },
  q50: { label: '≥ 50', test: (s) => s.quality_score != null && s.quality_score >= 50 },
  low: { label: '< 50', test: (s) => s.quality_score != null && s.quality_score < 50 },
  unscored: { label: 'Unscored', test: (s) => s.quality_score == null },
}

export function filterSessions(sessions, { search = '', ticket = '', quality = 'any', model = 'any' } = {}) {
  const needle = (search || ticket).trim().toLowerCase()
  const q = QUALITY_FILTERS[quality] || QUALITY_FILTERS.any
  const matchModel = !model || model === 'any' ? null : model.trim().toLowerCase()
  return sessions.filter((s) => {
    if (needle) {
      const matchTicket = (s.ticket_id || '').toLowerCase().includes(needle)
      const matchProject = (s.project_dir || '').toLowerCase().includes(needle)
      if (!matchTicket && !matchProject) return false
    }
    if (matchModel && (s.model || '').toLowerCase() !== matchModel) return false
    return q.test(s)
  })
}
