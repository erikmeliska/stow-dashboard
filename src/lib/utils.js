import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"
import { formatDistanceToNow } from "date-fns"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(date) {
  return formatDistanceToNow(new Date(date), { addSuffix: false })
}

export function docScoreColor(score) {
  if (score >= 70) return 'green'
  if (score >= 40) return 'amber'
  return 'red'
}

export function formatUsd(v) {
  if (v == null) return '—'
  if (v === 0) return '$0'
  if (v < 0.01) return '<1¢'
  return '$' + (v >= 100 ? Math.round(v) : v.toFixed(2))
}

// Aggregate-cost rendering rule: "unpriced, never $0". A cost total that is
// exactly $0 *because* some/all of the models behind it have no known price
// must never render as a bare dollar figure that reads as free — it renders
// as the literal string 'unpriced' instead. A nonzero total that still has
// unpriced models mixed in is a real partial figure, so it keeps the '~'
// (approximately) prefix rather than being replaced.
export function formatUsdWithUnpriced(v, hasUnpriced) {
  if (hasUnpriced && (v ?? 0) === 0) return 'unpriced'
  return `${hasUnpriced ? '~' : ''}${formatUsd(v)}`
}

export function getGitProvider(remoteUrl = '') {
  if (!remoteUrl) return null
  if (remoteUrl.includes('github.com')) return 'github'
  if (remoteUrl.includes('gitlab.com')) return 'gitlab'
  if (remoteUrl.includes('bitbucket.org')) return 'bitbucket'
  return 'git'
}
