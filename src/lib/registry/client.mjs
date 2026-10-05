/**
 * Client names for the virtual-project register (#8). One client = one
 * clientKey; spellings (`Intelimail`/`InteliMail`, `new:Archon`, `boys-from-
 * heaven`/`Boys from Heaven`) collapse, aliases in data/registry.json map
 * other names (a GitLab group, an old brand) onto a client.
 */

export function cleanClientName(name) {
  return typeof name === 'string' ? name.trim().replace(/^new:\s*/i, '').trim() : ''
}

export function clientKey(name) {
  return cleanClientName(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function bizzClient(directory) {
  const m = typeof directory === 'string' && directory.match(/\/_Bizz\/([^/]+)(?:\/|$)/)
  return m ? m[1] : null
}

const RANK = { config: 0, bizz: 1, seen: 2 }

export function buildClientCatalog({ config = { clients: [] }, names = {} } = {}) {
  const alias = new Map()
  const byKey = new Map() // key -> { rank, name, counts: Map }
  const canon = k => alias.get(k) || k

  const add = (raw, rank) => {
    const name = cleanClientName(raw)
    const k = canon(clientKey(name))
    if (!k) return
    let e = byKey.get(k)
    if (!e) byKey.set(k, e = { rank, name, counts: new Map() })
    if (rank < e.rank) { e.rank = rank; e.name = name }
    if (rank === RANK.seen) e.counts.set(name, (e.counts.get(name) || 0) + 1)
  }

  for (const c of config.clients || []) {
    const k = clientKey(c.name)
    for (const a of c.aliases || []) { const ak = clientKey(a); if (ak && ak !== k) alias.set(ak, k) }
  }
  for (const c of config.clients || []) add(c.name, RANK.config)
  for (const n of names.bizz || []) add(n, RANK.bizz)
  for (const n of names.seen || []) add(n, RANK.seen)

  for (const e of byKey.values()) {
    if (e.rank !== RANK.seen) continue
    let best = e.name, bestN = -1
    for (const [n, c] of e.counts) if (c > bestN) { best = n; bestN = c }
    e.name = best
  }

  return {
    lookup(name) {
      const k = canon(clientKey(name))
      const e = k && byKey.get(k)
      return e ? { id: k, name: e.name } : null
    },
    list() {
      return [...byKey].map(([id, e]) => ({ id, name: e.name })).sort((a, b) => a.id.localeCompare(b.id))
    },
  }
}
