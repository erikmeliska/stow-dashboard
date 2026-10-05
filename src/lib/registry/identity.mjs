/**
 * Project identity for the virtual-project register (#8): a hosted remote
 * URL normalised to host/path, else the stable id from .stow/project.json,
 * else the checkout root itself (unstable; #9 writes an id for those).
 */

/**
 * The location a ledger row belongs to: its checkout root (#9 — git toplevel,
 * or the row's own directory outside git). Rows without `checkout` (ledgers
 * not yet rescanned) stand for themselves.
 */
export function locationOf(record) {
  return record?.checkout?.root || record?.directory
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i
// scp-like `user@host:path`; the lookahead keeps `C:\` and `x://` out.
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

export function normalizeRemote(url) {
  if (typeof url !== 'string') return null
  let s = url.trim()
  if (!s) return null
  // Proxy/mirror prefixes embed the real URL in the path.
  const inner = s.slice(1).search(/https?:\/\//i)
  if (inner >= 0) s = s.slice(inner + 1)

  let host, rest
  const m = s.match(SCHEME)
  if (m) {
    if (m[1].toLowerCase() === 'file') return null
    const slash = m[2].indexOf('/')
    if (slash < 0) return null
    host = m[2].slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '')
    rest = m[2].slice(slash + 1)
  } else {
    const scp = s.match(SCP)
    if (!scp) return null
    host = scp[1]
    rest = scp[2]
  }
  host = host.toLowerCase().replace(/^www\./, '')
  const p = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
  if (!host || !p) return null
  return `${host}/${p}`
}

export function remoteOwner(remote) {
  if (!remote) return null
  const segs = remote.split('/')
  return segs.length >= 3 ? segs[1] : null
}

export function identityOf(record, meta) {
  for (const url of record?.git_info?.remotes || []) {
    const remote = normalizeRemote(url)
    if (remote) return { key: `git:${remote}`, kind: 'git', remote }
  }
  if (meta?.id) return { key: `stow:${meta.id}`, kind: 'stow', remote: null }
  return { key: `path:${locationOf(record)}`, kind: 'path', remote: null }
}

/**
 * Where a row's `.stow/project.json` lives: the main work tree for a linked
 * worktree (#9 — so all worktrees of a no-remote repo share one id), else
 * its checkout root.
 */
export function stowHomeOf(record) {
  return record?.checkout?.main || locationOf(record)
}

/**
 * One identity per checkout root (#9), so a checkout can't be split across
 * projects by members with stale or missing `git_info.remotes`: the root
 * row's remote, else the shallowest member's, else the `.stow` id at the
 * stow home (`metaAt(home)`), else `path:<root>`. → Map<root, identity>
 */
export function checkoutIdentities(records, metaAt = () => null) {
  const byRoot = new Map()
  for (const r of records) {
    if (!r || typeof r.directory !== 'string') continue
    const root = locationOf(r)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(r)
  }
  const out = new Map()
  for (const [root, members] of byRoot) {
    const ordered = [...members].sort((a, b) =>
      (b.directory === root) - (a.directory === root) ||
      a.directory.length - b.directory.length || a.directory.localeCompare(b.directory))
    let id = null
    for (const r of ordered) {
      const i = identityOf(r, null)
      if (i.kind === 'git') { id = i; break }
    }
    out.set(root, id || identityOf({ directory: root }, metaAt(stowHomeOf(ordered[0]))))
  }
  return out
}
