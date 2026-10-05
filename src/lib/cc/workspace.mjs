/**
 * Where a session ran, as path rules only (no fs, no git — client-safe).
 * Worktrees and Claude scratchpads are mapped back onto
 * the checkout they belong to; see the #12 design for the rule order.
 */

const WORKTREE_RULES = [
  { kind: 'agent-office', re: /^(.*)\/\.agent-office\/worktrees\/([^/]+)(\/.*)?$/ },
  { kind: 'claude-worktree', re: /^(.*)\/\.claude\/worktrees\/([^/]+)(\/.*)?$/ },
]
const SCRATCHPAD_RE = /^(?:\/private)?\/tmp\/claude-[^/]+\/([^/]+)\/([0-9a-f-]{8,})\/scratchpad(?:\/.*)?$/

/** Claude's project-dir encoding: every non-alphanumeric char becomes '-'. */
export function encodeClaudeSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-')
}

/** Longest known dir whose encoding is the slug or a '-'-prefix of it; null on a tie or no match. */
function matchSlug(slug, knownDirs) {
  let best = null, bestLen = -1, tie = false
  for (const d of knownDirs || []) {
    const enc = encodeClaudeSlug(d)
    if (slug !== enc && !slug.startsWith(enc + '-')) continue
    if (enc.length > bestLen) { best = d; bestLen = enc.length; tie = false }
    else if (enc.length === bestLen && d !== best) tie = true
  }
  return tie ? null : best
}

export function resolveWorkspacePath(runDir, { knownDirs = [] } = {}) {
  if (!runDir) return { base_dir: null, workspace: null, matched: false }
  const dir = runDir.length > 1 ? runDir.replace(/\/+$/, '') : runDir
  for (const { kind, re } of WORKTREE_RULES) {
    const m = dir.match(re)
    if (m) return { base_dir: m[1] + (m[3] || ''), workspace: `${kind}:${m[2]}`, matched: true }
  }
  const s = dir.match(SCRATCHPAD_RE)
  if (s) return { base_dir: matchSlug(s[1], knownDirs), workspace: `scratchpad:${s[2].slice(0, 8)}`, matched: true }
  return { base_dir: dir, workspace: null, matched: false }
}

export function formatWorkspace(ws) {
  if (!ws) return null
  const i = ws.indexOf(':')
  return i < 0 ? ws : `${ws.slice(0, i)}: ${ws.slice(i + 1)}`
}
