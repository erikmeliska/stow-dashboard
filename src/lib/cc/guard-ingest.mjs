/**
 * Parses cc-guard's append-only audit log (`~/.claude/cc-guard/audit.jsonl`,
 * one JSON object per line: ts, action, rule, command, session_id) into hits
 * grouped by session. This is the only contract between the cc-guard repo and
 * stow. Lines without a session_id are grouped under '' (unattached).
 */
export function parseGuardAudit(text) {
  const map = new Map();
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    const key = d.session_id || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ts: d.ts ?? null, command: d.command ?? null, rule: d.rule ?? null, action: d.action ?? null });
  }
  return map;
}
