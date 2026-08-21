/** Shared helpers over a parsed Claude Code JSONL transcript (one object per line). */

export function parseLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    try { const d = JSON.parse(raw); if (d && typeof d === 'object') out.push(d); } catch { /* skip bad line */ }
  }
  return out;
}

function blocks(d) {
  const c = d?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Every Bash tool_use command, in order. */
export function bashCommands(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') out.push(b.input.command);
  return out;
}

/** Every tool_use block as { tool, input, line }. */
export function toolUses(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'tool_use' && b.name) out.push({ tool: b.name, input: b.input ?? {}, line: d });
  return out;
}

/** Every tool_result as { is_error, text }. */
export function toolResults(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'user') for (const b of blocks(d)) if (b?.type === 'tool_result') {
    const c = b.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('\n') : '';
    out.push({ is_error: b.is_error === true, text });
  }
  return out;
}

/** Human prompts (string content or text blocks); tool_result-only messages are skipped. */
export function userPrompts(lines) {
  const out = [];
  for (const d of lines) {
    if (d.type !== 'user') continue;
    const c = d?.message?.content;
    if (typeof c === 'string') { if (c.trim()) out.push(c); continue; }
    const text = blocks(d).filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
    if (text.trim()) out.push(text);
  }
  return out;
}

/** Assistant text blocks, in order. */
export function assistantTexts(lines) {
  const out = [];
  for (const d of lines) if (d.type === 'assistant') for (const b of blocks(d)) if (b?.type === 'text' && b.text) out.push(b.text);
  return out;
}
