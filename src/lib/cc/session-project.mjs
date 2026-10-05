/** Client-safe project identity of a session row (#12). No fs, no node: imports. */
const base = (dir) => (dir ? dir.split('/').filter(Boolean).at(-1) : '') || ''

export function sessionProjectKey(s) {
  return s?.project_key || s?.base_dir || s?.project_dir || ''
}

export function sessionProjectLabel(s) {
  return s?.project_name || base(s?.base_dir || s?.project_dir) || '—'
}
