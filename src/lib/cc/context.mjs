/**
 * Work-context extraction for a session: git branch/repo, PR number and a
 * tool-agnostic ticket id (Jira, Linear, YouTrack, … — anything matching the
 * configurable pattern). Pure; operates on parsed transcript lines.
 */
import { bashCommands, toolResults, userPrompts } from './transcript.mjs';

/**
 * Default ticket shape: letters-only project key (2–10 chars), optional second
 * segment (TRI-STOW-0003), then a number. Letters-only keeps hex ids and
 * `UTF-8`-style tokens out; NOT_TICKETS drops the common false positives that
 * still fit the shape. Override with CC_TICKET_PATTERN for other conventions.
 */
export const DEFAULT_TICKET_RE = /\b[A-Z]{2,10}(?:-[A-Z]{2,10})?-\d+\b/;
const NOT_TICKETS = /^(?:UTF|ISO|RFC|SHA|CVE|IPV|MD|ECMA|HTTP|TLS|SSL|ID|UUID)-/;

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

function firstMatch(re, texts, isDefault) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const t of texts) {
    for (const m of String(t).matchAll(g)) {
      if (isDefault && NOT_TICKETS.test(m[0])) continue;
      return m[0];
    }
  }
  return null;
}

/**
 * @param {object[]} lines parsed transcript lines
 * @param {{ticketPattern?: RegExp}} opts
 * @returns {{git_branch: string|null, git_repo: string|null, pr: string|null, ticket_id: string|null, ticket_source: 'branch'|'prompt'|'commit'|null}}
 */
export function extractContext(lines, { ticketPattern = DEFAULT_TICKET_RE } = {}) {
  const re = new RegExp(ticketPattern.source, ticketPattern.flags.replace('g', ''));
  const isDefault = re.source === DEFAULT_TICKET_RE.source;
  const branch = mostCommonBranch(lines);
  const cmds = bashCommands(lines);
  const results = toolResults(lines);
  const prompts = userPrompts(lines);

  let ticket_id = null, ticket_source = null;
  if (branch && (ticket_id = firstMatch(re, [branch], isDefault))) ticket_source = 'branch';
  else if ((ticket_id = firstMatch(re, prompts.slice(0, 1), isDefault))) ticket_source = 'prompt';
  else {
    const commits = cmds.filter((c) => /\bgit\s+commit\b/.test(c));
    if ((ticket_id = firstMatch(re, commits, isDefault))) ticket_source = 'commit';
  }

  let git_repo = null;
  for (const t of [...cmds, ...results.map((r) => r.text)]) { const m = REPO_RE.exec(t); if (m) { git_repo = `${m[1]}/${m[2]}`; break; } }

  let pr = null;
  for (const r of results) { const m = PR_RE.exec(r.text); if (m) { pr = m[1]; break; } }
  if (!pr) for (const c of cmds) { const m = PR_RE.exec(c); if (m) { pr = m[1]; break; } }

  return { git_branch: branch, git_repo, pr, ticket_id, ticket_source };
}
