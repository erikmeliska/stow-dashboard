/**
 * Session families: which transcripts are *children* of another session, and
 * which parent they belong to.
 *
 * Two kinds of child exist:
 *
 * 1. Nested Agent-tool runs — `<session>/subagents/agent-*.jsonl`. Their
 *    parent is given by the directory; ingest-run.mjs folds their numbers
 *    into the parent row and records each one in the `subagents` table.
 *
 * 2. Hook-spawned SDK sessions — separate top-level transcripts written by a
 *    process that a hook of the parent session started through the Agent SDK
 *    (today: the security-guidance plugin's Stop/SubagentStop review, which
 *    opens with "Review this change for security vulnerabilities"). Nothing on
 *    disk records the parent, so the link is inferred here: same project dir,
 *    started while the parent was running, and — when several parents overlap
 *    in the same repo — the one whose last turn ended closest before the child
 *    started (the hook fires at turn end and blocks the parent while the child
 *    runs). Inference, so it can be wrong for two parallel sessions in one repo
 *    that both finish turns within the same second; the alternative is showing
 *    every review as a session of its own, which is worse.
 */

import { parseSummary } from './summary-view.mjs';

/**
 * Child kinds keyed by the `kind` stored on the session row. `test` gets the
 * transcript's entrypoint (`cli`, `claude-desktop`, `sdk-py`, …) and the first
 * human prompt. Add an entry here when another hook starts spawning sessions.
 */
export const CHILD_KINDS = {
  'security-review': {
    label: 'security review',
    test: ({ entrypoint, firstPrompt }) => /^sdk/.test(entrypoint || '')
      && /^(Review this change for security vulnerabilities|You previously flagged these candidate vulnerabilit)/.test(String(firstPrompt || '').trimStart()),
  },
  // Codex subagents name their parent in session_meta; ingest links them
  // directly (explicitParent), so the timing heuristic never looks at them.
  'codex-subagent': {
    label: 'codex subagent',
    explicitParent: true,
    test: () => false,
  },
};

export const CHILD_KIND_NAMES = Object.keys(CHILD_KINDS);

/** Child kinds whose parent must be inferred by timing (see linkChildren in ingest-run.mjs). */
export const LINKABLE_KIND_NAMES = Object.entries(CHILD_KINDS).filter(([, d]) => !d.explicitParent).map(([k]) => k);

/** What a session *is* for the calendar and the batch summariser. */
export const EFFECTIVE_KINDS = ['work', 'scheduled', 'agent-spawn', 'trivial'];

/**
 * Structure beats heuristics: a linked or child session is an agent spawn, a
 * scheduled run nobody answered is scheduled, an SDK session with at most one
 * prompt is machine-driven; only then the summary's `kind_hint`; default work.
 */
export function effectiveKind(row) {
  if (!row) return 'work';
  if (row.parent_session_id || CHILD_KINDS[row.kind]) return 'agent-spawn';
  if (row.kind === 'scheduled') return 'scheduled';
  if (/^sdk/.test(row.entrypoint || '') && (row.user_prompts ?? 0) <= 1) return 'agent-spawn';
  const hint = parseSummary(row)?.kind_hint;
  return EFFECTIVE_KINDS.includes(hint) ? hint : 'work';
}

/** @returns {'main' | keyof CHILD_KINDS} */
export function classifyKind(meta) {
  for (const [kind, def] of Object.entries(CHILD_KINDS)) if (def.test(meta)) return kind;
  return 'main';
}

/** Epoch-ms timestamps of assistant lines in a transcript, sorted. Regex, not JSON: transcripts are MBs. */
export function turnEndTimestamps(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"type":"assistant"')) continue;
    const m = /"timestamp":"([^"]+)"/.exec(line);
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** Longest plausible gap between a parent's last turn/tool line and the child's start (a slow tool before a commit review). */
export const MAX_GAP_MS = 5 * 60 * 1000;
/** A parent line may be stamped slightly *after* the child started (clock/flush order). */
export const GRACE_MS = 5000;

/**
 * Pick the parent of `child` among `candidates` (rows from listParentCandidates).
 *
 * Timing is the primary evidence: the hook that spawns a child fires right
 * after a parent line (turn end, or the tool_use whose result triggered a
 * commit review), so the true parent has a line within seconds before the
 * child's start. Directory is only a tie-break: a same-directory candidate
 * with a plausible gap beats a closer one elsewhere, because two parallel
 * sessions in one repo are common and a coincidental near-miss from another
 * repo is not worth more than the directory match. No plausible gap → no
 * link (a long-idle session that merely overlaps in time never qualifies).
 *
 * @param {(candidate) => number[]} turnEndsOf  epoch-ms assistant-line times of a
 *   candidate (main transcript + nested agents), sorted.
 * @returns {{ parent_session_id: string, method: 'same-dir'|'timing', gap_ms: number } | null}
 */
export function pickParent(child, candidates, { turnEndsOf, graceMs = GRACE_MS, maxGapMs = MAX_GAP_MS } = {}) {
  if (!candidates || candidates.length === 0 || typeof turnEndsOf !== 'function') return null;
  const t = Date.parse(child.started_at);
  if (!Number.isFinite(t)) return null;
  let sameDir = null, any = null;
  for (const c of candidates) {
    let last = -Infinity;
    for (const e of turnEndsOf(c) || []) if (e <= t + graceMs && e > last) last = e;
    if (last === -Infinity) continue;
    const gap = t - last;
    if (gap > maxGapMs) continue;
    const hit = { parent_session_id: c.session_id, gap_ms: gap };
    if (c.project_dir && c.project_dir === child.project_dir && (!sameDir || gap < sameDir.gap_ms)) sameDir = hit;
    if (!any || gap < any.gap_ms) any = hit;
  }
  if (sameDir) return { ...sameDir, method: 'same-dir' };
  if (any) return { ...any, method: 'timing' };
  return null;
}
