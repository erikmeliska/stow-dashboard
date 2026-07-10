// Builds the compact per-project fact sheet ("distillate") sent to the model.
// Must stay well under the 4096-token context: README excerpt is capped and
// the rest is short structured lines.
import { readFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import path from 'path'

const exec = promisify(execFile)
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'README']
const MONTH_MS = 30.44 * 24 * 3600 * 1000

// Meta-doc files excluded from the code-activity date, so README/doc edits
// don't "revive" a project. Curated on purpose — NOT all *.md, because some
// projects' markdown IS the content (books, doc sites).
const CODE_ACTIVITY_EXCLUDES = [
  'README*', 'readme*', 'CHANGELOG*', 'LICENSE*', 'docs', '.github',
  'CLAUDE.md', 'STATUS.md', 'TASKS.md', 'AGENTS.md',
]

export async function gatherFacts(project) {
  const dir = project.directory
  let readme = null
  for (const name of README_NAMES) {
    try { readme = await readFile(path.join(dir, name), 'utf8'); break } catch { /* try next */ }
  }
  let topLevel = []
  try {
    topLevel = (await readdir(dir)).filter(n => n !== 'node_modules' && n !== '.git').sort().slice(0, 40)
  } catch { /* missing dir */ }
  let commits = []
  let lastCodeCommit = null
  if (project.git_info?.git_detected) {
    try {
      const { stdout } = await exec('git', ['log', '-10', '--pretty=%s'], { cwd: dir, timeout: 10000 })
      commits = stdout.split('\n').filter(Boolean)
    } catch { /* no commits or git error */ }
    try {
      const pathspecs = CODE_ACTIVITY_EXCLUDES.map(e => `:(exclude)${e}`)
      const { stdout } = await exec('git', ['log', '-1', '--format=%cI', '--', '.', ...pathspecs], { cwd: dir, timeout: 10000 })
      lastCodeCommit = stdout.trim() || null
    } catch { /* no commits or git error */ }
  }
  return { readme, topLevel, commits, lastCodeCommit }
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : 'unknown'
}

function monthsSince(iso, now = Date.now()) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor((now - t) / MONTH_MS) : null
}

function placementNote(directory, baseDir) {
  if (!baseDir) return ''
  const rel = path.relative(baseDir, directory)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return ''
  const [first, ...rest] = rel.split(path.sep)
  if (rest.length === 0) return ' (currently in ROOT, uncategorized)'
  if (first.startsWith('_')) return ` (currently filed under ${first})`
  return ` (currently under ${first}/)`
}

export function formatDistillate(project, facts, { readmeChars = 1500, baseDir = '', topLevelMax = 40, commitsMax = 10, stackMax = 15 } = {}) {
  const lines = ['Project facts:']
  lines.push(`- name: ${project.project_name || path.basename(project.directory)}`)
  lines.push(`- path: ${project.directory}${placementNote(project.directory, baseDir)}`)
  const idle = monthsSince(project.git_info?.last_total_commit_date || project.last_modified)
  lines.push(`- created: ${day(project.created)}, last modified: ${day(project.last_modified)}${idle !== null ? ` (~${idle} months since last activity)` : ''}`)
  if (project.description) lines.push(`- existing description: ${project.description}`)
  const stack = (project.stack || []).slice(0, stackMax)
  lines.push(`- stack: ${stack.length ? stack.join(', ') : 'none detected'}${(project.stack || []).length > stackMax ? ` (+${project.stack.length - stackMax} more)` : ''}`)
  const types = Object.entries(project.file_types || {}).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (types.length) lines.push(`- file types: ${types.map(([e, n]) => `${e}×${n}`).join(', ')}`)
  if (project.scc) {
    const langs = (project.scc.languages || []).slice(0, 5).map(l => l.name).join(', ')
    lines.push(`- code: ${project.scc.total_code ?? '?'} lines in ${project.scc.total_files ?? '?'} files (${langs})`)
  }
  lines.push(`- content size: ${Math.round((project.content_size_bytes || 0) / 1024)} kB`)
  const gi = project.git_info || {}
  if (gi.git_detected) {
    const remotes = (gi.remotes || []).join(', ')
    let git = `- git: ${gi.total_commits ?? '?'} commits, branch ${gi.current_branch || '?'}${remotes ? `, remote: ${remotes}` : ', no remote'}`
    if (typeof gi.user_commits === 'number' && typeof gi.total_commits === 'number') {
      git += `, own commits: ${gi.user_commits} of ${gi.total_commits}`
      if (gi.user_commits === 0 && gi.total_commits > 0) git += ' (no own commits — likely a clone of third-party code)'
    }
    lines.push(git)
  } else {
    lines.push('- git: none')
  }
  if (facts.topLevel.length) lines.push(`- top-level entries: ${facts.topLevel.slice(0, topLevelMax).join(', ')}`)
  if (facts.commits.length) lines.push(`- recent commits: ${facts.commits.slice(0, commitsMax).join(' | ')}`)
  if (facts.readme) {
    lines.push(`README (first ${readmeChars} chars):`)
    lines.push(facts.readme.slice(0, readmeChars))
  } else {
    lines.push('- README: none')
  }
  return lines.join('\n')
}

export function distillProject(project, facts, opts = {}) {
  const text = formatDistillate(project, facts, opts)
  const hash = createHash('sha256').update(text).digest('hex')
  return { text, hash }
}
