/**
 * Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, written by the
 * Codex CLI, Codex desktop and t3code) → session-store rows.
 *
 * Tokens, model and active time come from usage.mjs (`parseCodexLines` +
 * `codexBuckets`) so the store reports exactly what the usage ledger reports,
 * including its handling of duplicate token events and mid-rollout resets.
 * Everything else is read from the rollout's own events:
 *   session_meta  → id, cwd, git branch/repo, originator, subagent parent
 *   task_complete → turns (fallback task_started)
 *   function_call / custom_tool_call → tool counts
 *   message(role=user), minus injected context → prompts / title
 *
 * Subagents carry their parent in `session_meta.source.subagent`; we link them
 * to the ROOT thread (`session_meta.session_id`) so families stay one level
 * deep (depth-2 subagents exist). No quality score yet (Claude-only heuristic).
 */
import { newFileState, parseCodexLines, codexBuckets } from '../usage.mjs';
import { costForCodex } from '../usage-pricing.mjs';
import { DEFAULT_TICKET_RE } from './context.mjs';
import { promptTitle } from './ingest.mjs';

/** Harness-injected "user" messages: AGENTS.md, <environment_context>, <permissions …>, … */
const INJECTED_RE = /^\s*(?:<|#\s*AGENTS\.md instructions)/;

export function isInjectedPrompt(text) {
  return INJECTED_RE.test(String(text || ''));
}

export function normalizeOriginator(originator) {
  const o = String(originator || '').toLowerCase();
  if (o.includes('t3code')) return 't3code';
  if (o.includes('desktop')) return 'desktop';
  if (o.includes('vscode')) return 'vscode';
  if (o.includes('tui') || o.includes('cli') || o.includes('exec')) return 'cli';
  return 'other';
}

/** The most specific known project containing `dir` (same rule as the Gemini ingest). */
export function deepestProject(dir, projectDirs = []) {
  if (!dir) return null;
  let best = null;
  for (const p of projectDirs || []) {
    if ((dir === p || dir.startsWith(p + '/')) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** Text of a response_item `content` array (input_text / output_text parts). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

export function codexUserPrompts(lines) {
  const out = [];
  for (const d of lines || []) {
    const p = d?.payload;
    if (d?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') continue;
    const t = contentText(p.content).trim();
    if (t && !isInjectedPrompt(t)) out.push(t);
  }
  return out;
}

function toSeconds(a, b) {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0;
}

/**
 * @param {string} text raw rollout JSONL
 * @param {{rawRef?: string|null, projectDirs?: string[], ticketPattern?: RegExp}} opts
 * @returns session row + `_tools`, `_skills`, `_editedSkills`, `_parent`, `_lines`; null without session_meta
 */
export function parseCodexSession(text, { rawRef = null, projectDirs = [], ticketPattern = DEFAULT_TICKET_RE } = {}) {
  const rawLines = String(text || '').split('\n').filter((l) => l.trim());
  const lines = [];
  for (const l of rawLines) {
    try { const d = JSON.parse(l); if (d && typeof d === 'object') lines.push(d); } catch { /* truncated tail */ }
  }
  const meta = lines.find((d) => d.type === 'session_meta')?.payload;
  if (!meta?.id) return null;

  const state = newFileState('codex');
  parseCodexLines(rawLines, state);
  const tok = { input: 0, cachedInput: 0, output: 0 };
  let cost = 0, priced = false, model = null, bestOut = -1;
  for (const [id, b] of Object.entries(codexBuckets(state))) {
    tok.input += b.input; tok.cachedInput += b.cachedInput; tok.output += b.output;
    const c = costForCodex(b, id);
    if (c != null) { cost += c; priced = true; }
    if (id !== 'unknown' && b.output > bestOut) { bestOut = b.output; model = id; }
  }

  const tools = {};
  let completes = 0, starts = 0;
  for (const d of lines) {
    const p = d.payload || {};
    if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) tools[p.name] = (tools[p.name] || 0) + 1;
    if (d.type === 'event_msg' && p.type === 'task_complete') completes++;
    if (d.type === 'event_msg' && p.type === 'task_started') starts++;
  }

  const sub = meta.source && typeof meta.source === 'object' ? meta.source.subagent : null;
  const parent = sub
    ? (meta.session_id && meta.session_id !== meta.id ? meta.session_id : sub.thread_spawn?.parent_thread_id ?? null)
    : null;
  const prompts = codexUserPrompts(lines);
  const branch = meta.git?.branch || null;
  const ticket = branch ? branch.match(ticketPattern)?.[0] ?? null : null;
  const started = meta.timestamp || state.firstTs || null;
  const ended = state.lastTs || null;

  return {
    session_id: meta.id,
    project_dir: deepestProject(meta.cwd, projectDirs) || meta.cwd || null,
    cwd: meta.cwd || null,
    model: model || state.codexModel || null,
    started_at: started, ended_at: ended,
    duration_s: started && ended ? toSeconds(started, ended) : 0,
    active_s: state.activeSeconds || 0,
    // Claude semantics: input_tokens excludes cache reads.
    input_tokens: Math.max(0, tok.input - tok.cachedInput), output_tokens: tok.output, cache_read: tok.cachedInput,
    cache_write_5m: 0, cache_write_1h: 0,
    cost_usd: priced ? cost : null,
    turns: completes || starts,
    status: ended ? 'done' : 'unknown',
    git_branch: branch, git_repo: meta.git?.repository_url || null, pr: null,
    ticket_id: ticket, ticket_source: ticket ? 'branch' : null,
    quality_score: null, quality_detail: null,
    kind: sub ? 'codex-subagent' : 'main',
    entrypoint: `codex-${normalizeOriginator(meta.originator)}`,
    title: promptTitle(prompts[0]), title_source: prompts[0] ? 'prompt' : null, user_prompts: prompts.length,
    raw_ref: rawRef, ingested_at: new Date().toISOString(),
    _tools: tools, _skills: {}, _editedSkills: new Set(), _parent: parent, _lines: lines,
  };
}
