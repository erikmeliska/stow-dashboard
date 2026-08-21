/**
 * Quality score v1 — a transparent heuristic (0–100). Components are returned
 * alongside the score so the number is explainable in the UI. Explicitly NOT a
 * judgement of the work itself; refine the formula as data accumulates.
 */
import { bashCommands, toolResults, toolUses } from './transcript.mjs';

export const DEFAULT_VERIFY_RE = /npm test|node --test|pytest|cargo test|go test|vitest|jest|playwright/;

/** Verification-command regex from env (CC_VERIFY_PATTERN); invalid or unset → default. */
export function verifyRegex(env = process.env) {
  const p = env.CC_VERIFY_PATTERN;
  if (!p) return DEFAULT_VERIFY_RE;
  try { return new RegExp(p); } catch { return DEFAULT_VERIFY_RE; }
}

export const POINTS = Object.freeze({ verified: 25, clean_finish: 25, error_rate: 25, no_loops: 15, guard_clean: 10 });
const LOOP_RUN = 3;          // identical consecutive tool calls that count as a loop
const ERROR_RATE_FLOOR = 20; // % of failing tool results at which error_rate points hit 0

function countLoops(uses) {
  let loops = 0, run = 1, prev = null;
  for (const u of uses) {
    const key = u.tool + ' ' + JSON.stringify(u.input);
    if (key === prev) { run++; if (run === LOOP_RUN) loops++; } else { run = 1; prev = key; }
  }
  return loops;
}

/** True when the last assistant message comes after the last failing tool result. */
function cleanFinish(lines) {
  let lastAssistant = -1, lastError = -1;
  lines.forEach((d, i) => {
    if (d.type === 'assistant') lastAssistant = i;
    if (d.type === 'user') for (const b of d?.message?.content || []) if (b?.type === 'tool_result' && b.is_error === true) lastError = i;
  });
  return lastAssistant >= 0 && lastError < lastAssistant;
}

/**
 * @param {object[]} lines parsed transcript lines (main transcript only)
 * @param {{guardHits?: {action: string}[], verifyPattern?: RegExp}} opts
 * @returns {{score: number, detail: object}}
 */
export function scoreSession(lines, { guardHits = [], verifyPattern = DEFAULT_VERIFY_RE } = {}) {
  const verified = bashCommands(lines).some((c) => verifyPattern.test(c));
  const results = toolResults(lines);
  const errors = results.filter((r) => r.is_error).length;
  const error_rate_pct = results.length ? Math.round((errors / results.length) * 1000) / 10 : 0;
  const loops = countLoops(toolUses(lines));
  const guard_incidents = guardHits.filter((h) => h.action === 'deny' || h.action === 'override').length;
  const clean_finish = cleanFinish(lines);

  const points = {
    verified: verified ? POINTS.verified : 0,
    clean_finish: clean_finish ? POINTS.clean_finish : 0,
    error_rate: Math.max(0, POINTS.error_rate * (1 - Math.min(error_rate_pct, ERROR_RATE_FLOOR) / ERROR_RATE_FLOOR)),
    no_loops: loops === 0 ? POINTS.no_loops : 0,
    guard_clean: guard_incidents === 0 ? POINTS.guard_clean : 0,
  };
  const score = Math.round(Object.values(points).reduce((a, b) => a + b, 0));
  return { score, detail: { verified, clean_finish, error_rate_pct, loops, guard_incidents, points } };
}
