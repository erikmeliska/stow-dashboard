/**
 * Project identity for the virtual-project register (#8): a hosted remote
 * URL normalised to host/path, else the stable id from .stow/project.json,
 * else the directory itself (unstable until #9 writes an id).
 */

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
  return { key: `path:${record.directory}`, kind: 'path', remote: null }
}
