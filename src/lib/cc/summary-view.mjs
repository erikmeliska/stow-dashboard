/**
 * Read-side helpers over a session row's AI summary. Pure and client-safe (no
 * Node imports): the /sessions page, the calendar, the batch runner and the MCP
 * server all decide "has a summary / which title / should it be summarised"
 * with the same code.
 *
 * `summary` is a JSON string: v1 = { what, outcome, improvements, followups, model },
 * v2 adds { v: 2, title, kind_hint, ms } and the `exploration` outcome; rows
 * written after the harness setting also carry `harness` (claude|codex).
 */

/** Harnesses that can write a summary (CC_SUMMARY_HARNESS); the first is the default. */
export const HARNESSES = ['claude', 'codex'];

/**
 * Model per harness when CC_SUMMARY_MODEL / CC_SUMMARY_BATCH_MODEL are unset.
 * '' = the CLI's own default (codex runs with --ignore-user-config, so that is
 * Codex's built-in default, not the one pinned in config.toml).
 */
export const DEFAULT_MODELS = {
  claude: { single: 'haiku', batch: 'claude-sonnet-5-5' },
  codex: { single: '', batch: '' },
};

/** A session written to in the last 10 minutes may still be running: never batch-summarise it. */
export const MIN_AGE_MS = 10 * 60 * 1000;

export const OUTCOME_ICON = { done: '✅', partial: '🟡', abandoned: '⛔', exploration: '🔍' };

export function parseSummary(row) {
  if (!row?.summary) return null;
  try {
    const v = JSON.parse(row.summary);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 0 = no (readable) summary, 1 = legacy v1, otherwise `summary.v`. */
export function summaryVersion(row) {
  const s = parseSummary(row);
  if (!s) return 0;
  return Number.isInteger(s.v) && s.v > 1 ? s.v : 1;
}

/** Title shown in lists and the calendar: the user's own name > the summary's > Claude's ai-title > first prompt. */
export function displayTitle(row) {
  if (!row) return null;
  if (row.title_source === 'custom' && row.title) return row.title;
  const t = parseSummary(row)?.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return row.title || null;
}

/**
 * Should a batch summarise this row?
 * @param {{force?: false|true|'upgrade', now?: number}} opts  `upgrade` re-does v1 summaries, `true` redoes all
 */
export function needsSummary(row, { force = false, now = Date.now() } = {}) {
  if (!row?.raw_ref) return false;
  const last = Date.parse(row.ended_at || row.started_at || '');
  if (!Number.isFinite(last) || now - last < MIN_AGE_MS) return false;
  const v = summaryVersion(row);
  if (force === true) return true;
  if (force === 'upgrade') return v < 2;
  return v === 0;
}
