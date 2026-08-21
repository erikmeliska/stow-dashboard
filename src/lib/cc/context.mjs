/**
 * Work-context extraction for a session: git branch/repo, PR number and a
 * tool-agnostic ticket id (Jira, Linear, YouTrack, … — anything matching the
 * configurable pattern). Pure; operates on parsed transcript lines.
 */
import { bashCommands, toolResults, userPrompts } from './transcript.mjs';

export const DEFAULT_TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Ticket regex from env (CC_TICKET_PATTERN); invalid or unset → default. */
export function ticketRegex(env = process.env) {
  const p = env.CC_TICKET_PATTERN;
  if (!p) return DEFAULT_TICKET_RE;
  try { return new RegExp(p); } catch { return DEFAULT_TICKET_RE; }
}

const REPO_RE = /(?:https?:\/\/|git@)?(github\.com|gitlab\.com|bitbucket\.org)[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s'")]|$)/;
const PR_RE = /\/(?:pull|merge_requests|pull-requests)\/(\d+)/;

/** Most frequent non-HEAD `gitBranch` value across lines; ties go to the last one seen. */
function mostCommonBranch(lines) {
  const counts = new Map();
  let lastSeen = null;
  for (const d of lines) {
    const b = d.gitBranch;
    if (typeof b !== 'string' || !b || b === 'HEAD') continue;
    counts.set(b, (counts.get(b) || 0) + 1);
    lastSeen = b;
  }
  let best = null, bestN = 0;
  for (const [b, n] of counts) if (n > bestN || (n === bestN && b === lastSeen)) { best = b; bestN = n; }
  return best;
}

function firstMatch(re, texts) {
  for (const t of texts) { const m = re.exec(t); if (m) return m[0]; }
  return null;
}

/**
 * @param {object[]} lines parsed transcript lines
 * @param {{ticketPattern?: RegExp}} opts
 * @returns {{git_branch: string|null, git_repo: string|null, pr: string|null, ticket_id: string|null, ticket_source: 'branch'|'prompt'|'commit'|null}}
 */
export function extractContext(lines, { ticketPattern = DEFAULT_TICKET_RE } = {}) {
  const re = new RegExp(ticketPattern.source, ticketPattern.flags.replace('g', ''));
  const branch = mostCommonBranch(lines);
  const cmds = bashCommands(lines);
  const results = toolResults(lines);
  const prompts = userPrompts(lines);

  let ticket_id = null, ticket_source = null;
  if (branch && (ticket_id = firstMatch(re, [branch]))) ticket_source = 'branch';
  else if ((ticket_id = firstMatch(re, prompts.slice(0, 1)))) ticket_source = 'prompt';
  else {
    const commits = cmds.filter((c) => /\bgit\s+commit\b/.test(c));
    if ((ticket_id = firstMatch(re, commits))) ticket_source = 'commit';
  }

  let git_repo = null;
  for (const t of [...cmds, ...results.map((r) => r.text)]) { const m = REPO_RE.exec(t); if (m) { git_repo = `${m[1]}/${m[2]}`; break; } }

  let pr = null;
  for (const r of results) { const m = PR_RE.exec(r.text); if (m) { pr = m[1]; break; } }
  if (!pr) for (const c of cmds) { const m = PR_RE.exec(c); if (m) { pr = m[1]; break; } }

  return { git_branch: branch, git_repo, pr, ticket_id, ticket_source };
}
