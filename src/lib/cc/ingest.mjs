/**
 * Pure per-session transcript parser for the cc session store.
 *
 * Reuses stow's usage.mjs (`parseClaudeLines`) for per-model tokens and
 * usage-pricing.mjs (`costForClaude`) for list-price cost, then does a second
 * pass over assistant turns for tool/skill counts and `skill_edited`
 * (an Edit/Write on a file under a skills dir after a Skill call is credited
 * to the most recent skill — a heuristic, good enough for "we improved a
 * skill" in phase 1).
 */
import { newFileState, parseClaudeLines } from '../usage.mjs';
import { costForClaude } from '../usage-pricing.mjs';
import { parseLines, userPrompts } from './transcript.mjs';
import { classifyKind } from './session-link.mjs';

export const SKILL_PATH_RE = /(?:^|\/)(?:\.claude\/skills|skills)\/[^/]+\//;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function toSeconds(a, b) {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0;
}

/**
 * @param {string} text   raw JSONL transcript
 * @param {{fileName?: string, rawRef?: string}} meta
 * @returns session row (store.mjs `sessions` keys, incl. `kind` + `entrypoint`) + `_tools`, `_skills`, `_editedSkills`, `_lines` (parsed lines)
 */
export function parseSessionText(text, meta = {}) {
  const rawLines = String(text || '').split('\n').filter((l) => l.trim());
  const state = newFileState('claude');
  parseClaudeLines(rawLines, state); // tokens per model + cwd + firstTs/lastTs/activeSeconds
  const lines = parseLines(text);

  const tools = {};
  const skills = {};
  const editedSkills = new Set();
  let turns = 0;
  let sessionId = null;
  let entrypoint = null;
  let lastSkill = null;

  for (const d of lines) {
    if (!sessionId && typeof d.sessionId === 'string') sessionId = d.sessionId;
    if (!entrypoint && typeof d.entrypoint === 'string') entrypoint = d.entrypoint;
    if (d.type !== 'assistant') continue;
    turns++;
    for (const b of d.message?.content || []) {
      if (b?.type !== 'tool_use' || !b.name) continue;
      tools[b.name] = (tools[b.name] || 0) + 1;
      if (b.name === 'Skill') {
        const s = b.input?.skill || b.input?.command;
        if (s) { skills[s] = (skills[s] || 0) + 1; lastSkill = s; }
      } else if (EDIT_TOOLS.has(b.name) && SKILL_PATH_RE.test(b.input?.file_path || '')) {
        if (lastSkill) editedSkills.add(lastSkill);
      }
    }
  }

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let cost = 0;
  let priced = false;
  let primaryModel = null;
  let primaryOut = -1;
  for (const [model, m] of Object.entries(state.models)) {
    totals.input += m.input; totals.output += m.output; totals.cacheRead += m.cacheRead;
    totals.cacheWrite5m += m.cacheWrite5m; totals.cacheWrite1h += m.cacheWrite1h;
    const c = costForClaude(model, m);
    if (c != null) { cost += c; priced = true; }
    if (m.output > primaryOut) { primaryOut = m.output; primaryModel = model; }
  }

  // usage.mjs keeps firstTs/lastTs as the transcript's ISO timestamp strings.
  const started = state.firstTs || null;
  const ended = state.lastTs || null;

  // First human prompt: hook-spawned SDK sessions announce themselves in it.
  const firstPrompt = userPrompts(lines)[0] || lines.find((d) => d.type === 'queue-operation' && typeof d.content === 'string')?.content || '';
  const kind = classifyKind({ entrypoint, firstPrompt });

  return {
    session_id: sessionId || (meta.fileName ? meta.fileName.replace(/\.jsonl$/, '') : null),
    project_dir: state.cwd, cwd: state.cwd, model: primaryModel,
    started_at: started, ended_at: ended,
    duration_s: started && ended ? toSeconds(started, ended) : 0,
    active_s: state.activeSeconds || 0,
    input_tokens: totals.input, output_tokens: totals.output, cache_read: totals.cacheRead,
    cache_write_5m: totals.cacheWrite5m, cache_write_1h: totals.cacheWrite1h,
    cost_usd: priced ? cost : null, turns, status: ended ? 'done' : 'unknown',
    kind, entrypoint,
    raw_ref: meta.rawRef || null, ingested_at: new Date().toISOString(),
    _tools: tools, _skills: skills, _editedSkills: editedSkills, _lines: lines,
  };
}
