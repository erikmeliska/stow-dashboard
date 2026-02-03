import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"
import { formatDistanceToNow } from "date-fns"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(date) {
  return formatDistanceToNow(new Date(date), { addSuffix: false })
}

export function getGitProvider(remoteUrl = '') {
  if (!remoteUrl) return null
  if (remoteUrl.includes('github.com')) return 'github'
  if (remoteUrl.includes('gitlab.com')) return 'gitlab'
  if (remoteUrl.includes('bitbucket.org')) return 'bitbucket'
  return 'git'
}
