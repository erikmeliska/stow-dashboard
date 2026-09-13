/**
 * AI session summary via the local `claude` CLI (no API key; runs on your
 * subscription). On-demand only — never called from ingest.
 *
 * Flag rationale (measured 2026-08-21, haiku, trivial prompt):
 *   naive `claude -p` in the repo cwd          ≈150k ctx tokens, $0.16/call
 *   + --strict-mcp-config/--setting-sources "" ≈7.5k,           $0.017
 *   + --system-prompt (drops the default)      ≈1k,             $0.0025
 * `--no-session-persistence` is mandatory: otherwise every summary writes a
 * transcript under ~/.claude/projects that cc-ingest then indexes (a loop).
 * `--tools ""` keeps the call a pure text → JSON step. `--bare` was tried and
 * fails (is_error, no tokens) on Claude Code 2.1.x — do not add it.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execClosedStdin } from '../analyzer.mjs';
import { assistantTexts, parseLines, toolUses, userPrompts } from './transcript.mjs';
import { decodeProto } from '../usage.mjs';
import { getSession, setSummary } from './store.mjs';

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    what: { type: 'string', description: '1-3 sentences: what was worked on and the result' },
    outcome: { type: 'string', enum: ['done', 'partial', 'abandoned'] },
    improvements: { type: 'array', items: { type: 'string' }, description: 'skills/tools/process improved or created' },
    followups: { type: 'array', items: { type: 'string' } },
  },
  required: ['what', 'outcome', 'improvements', 'followups'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You summarise one AI coding session from a condensed transcript. Answer ONLY with JSON matching the schema.
"what": 1-3 plain sentences on what was worked on and what the result was.
"outcome": done | partial | abandoned.
"improvements": skills, tools or process that were improved or created (empty if none).
"followups": open items explicitly left for later (empty if none).
Be concrete. No marketing language. Write in the language the user wrote in.`;

const OUTCOMES = new Set(['done', 'partial', 'abandoned']);

/**
 * Where the `claude` binary usually lives. The desktop app launched from the
 * Dock gets macOS's minimal GUI PATH (no ~/.local/bin, no Homebrew), so a bare
 * `claude` fails with ENOENT there even though it works in a terminal.
 * Resolution: CC_CLAUDE_BIN env → first existing well-known path → 'claude' on PATH.
 */
export function resolveClaudeBin(env = process.env, home = homedir(), exists = existsSync) {
  if (env.CC_CLAUDE_BIN) return env.CC_CLAUDE_BIN;
  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((p) => exists(p)) || 'claude';
}

export class SummaryError extends Error {
  /** @param {'cli-missing'|'cli-failed'|'bad-json'|'not-found'} kind */
  constructor(kind, message, detail = null) {
    super(message || `summary: ${kind}`);
    this.kind = kind;
    this.detail = detail;
  }
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function limitChars(text, maxChars) {
  if (text.length > maxChars) {
    // keep the head (what was asked) and the tail (how it ended)
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head - 7;
    return text.slice(0, head) + '\n[...]\n' + text.slice(-tail);
  }
  return text;
}

function cleanUserPrompt(content) {
  if (!content || typeof content !== 'string') return '';
  const reqMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  let text = reqMatch ? reqMatch[1] : content;
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanToolArg(args) {
  if (args == null) return '';
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return args.replace(/^["']|["']$/g, '').trim();
    }
  }
  if (typeof args === 'object' && args !== null) {
    const val = args.CommandLine || args.AbsolutePath || args.TargetFile || args.DirectoryPath ||
                args.Query || args.SearchPath || args.Recipient || args.Message || args.Prompt ||
                args.command || args.file_path || args.path;
    if (val) return String(val).replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v) return v.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    }
    return JSON.stringify(args).replace(/\s+/g, ' ').trim();
  }
  return String(args).replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
}

/** Condensed, ordered transcript for Gemini / Antigravity JSONL lines. */
export function distillGemini(lines, { maxChars = 30000 } = {}) {
  const parts = [];
  for (const d of lines) {
    if (!d) continue;
    if (d.type === 'USER_INPUT') {
      const p = cleanUserPrompt(d.content);
      if (p) parts.push(`USER: ${clip(p, 1200)}`);
    } else if (d.type === 'PLANNER_RESPONSE') {
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const arg = cleanToolArg(tc.args);
          parts.push(`TOOL ${tc.name}: ${clip(arg, 160)}`);
        }
      }
      if (d.content && typeof d.content === 'string') {
        const t = d.content.replace(/\s+/g, ' ').trim();
        if (t) parts.push(`ASSISTANT: ${clip(t, 600)}`);
      }
    }
  }
  return limitChars(parts.join('\n'), maxChars);
}

/** Fallback extractor: read steps from SQLite database directly. */
export function distillGeminiDb(dbOrPath, { maxChars = 30000 } = {}) {
  let db = null;
  let shouldClose = false;
  if (typeof dbOrPath === 'string') {
    try {
      db = new DatabaseSync(dbOrPath, { open: true, readOnly: true });
      shouldClose = true;
    } catch {
      return '';
    }
  } else if (dbOrPath && typeof dbOrPath.prepare === 'function') {
    db = dbOrPath;
  } else {
    return '';
  }

  const parts = [];
  try {
    const rows = db.prepare('SELECT idx, step_type, step_payload, metadata FROM steps ORDER BY idx ASC').all();
    for (const r of rows) {
      if (r.step_payload) {
        try {
          const p = decodeProto(r.step_payload);
          if (p[19]) {
            const p19 = decodeProto(p[19]);
            if (p19[2]) {
              const text = Buffer.isBuffer(p19[2]) || p19[2] instanceof Uint8Array
                ? Buffer.from(p19[2]).toString('utf8')
                : String(p19[2]);
              const cleaned = cleanUserPrompt(text);
              if (cleaned) parts.push(`USER: ${clip(cleaned, 1200)}`);
            }
          }
          if (p[20]) {
            const p20 = decodeProto(p[20]);
            if (p20[1]) {
              const text = Buffer.isBuffer(p20[1]) || p20[1] instanceof Uint8Array
                ? Buffer.from(p20[1]).toString('utf8')
                : String(p20[1]);
              const cleaned = String(text).replace(/\s+/g, ' ').trim();
              if (cleaned) parts.push(`ASSISTANT: ${clip(cleaned, 600)}`);
            }
          }
        } catch {
          /* ignore proto decode errors */
        }
      }
      if (r.metadata) {
        try {
          const top = decodeProto(r.metadata);
          if (top[4]) {
            const f4 = decodeProto(top[4]);
            if (f4[2]) {
              const toolName = Buffer.isBuffer(f4[2]) || f4[2] instanceof Uint8Array
                ? Buffer.from(f4[2]).toString('utf8')
                : String(f4[2]);
              let arg = '';
              if (f4[3]) {
                const argsRaw = Buffer.isBuffer(f4[3]) || f4[3] instanceof Uint8Array
                  ? Buffer.from(f4[3]).toString('utf8')
                  : String(f4[3]);
                arg = cleanToolArg(argsRaw);
              }
              parts.push(`TOOL ${toolName}: ${clip(arg, 160)}`);
            }
          }
        } catch {
          /* ignore proto decode errors */
        }
      }
    }
  } catch {
    /* ignore missing table or other query error */
  } finally {
    if (shouldClose && db) {
      try { db.close(); } catch {}
    }
  }
  return limitChars(parts.join('\n'), maxChars);
}

/** Resolves the transcript.jsonl path for a Gemini session. */
export function resolveGeminiTranscriptPath(rawRef, id, exists = existsSync) {
  if (rawRef && !rawRef.endsWith('.db') && exists(rawRef)) return rawRef;
  const candidates = [];
  if (rawRef) {
    const d = dirname(rawRef);
    candidates.push(
      join(d, 'transcript.jsonl'),
      join(d, `${id}.jsonl`),
      join(dirname(d), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'),
      join(dirname(d), 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    );
  }
  const home = homedir();
  candidates.push(
    join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'),
    join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'),
    join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'),
  );
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/** Condensed, ordered transcript: prompts, tool calls (short), assistant text. Supports Claude & Gemini lines. */
export function distill(lines, opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  if (lines.some((d) => d && (d.type === 'USER_INPUT' || d.type === 'PLANNER_RESPONSE'))) {
    return distillGemini(lines, opts);
  }
  const { maxChars = 30000 } = opts;
  const parts = [];
  for (const d of lines) {
    if (d.type === 'user') for (const p of userPrompts([d])) parts.push(`USER: ${clip(p, 1200)}`);
    if (d.type === 'assistant') {
      for (const u of toolUses([d])) {
        const arg = u.tool === 'Bash' ? u.input.command
          : u.tool === 'Skill' ? u.input.skill
          : (u.input.file_path || u.input.pattern || u.input.description || '');
        parts.push(`TOOL ${u.tool}: ${clip(arg || '', 160)}`);
      }
      for (const t of assistantTexts([d])) parts.push(`ASSISTANT: ${clip(t, 600)}`);
    }
  }
  return limitChars(parts.join('\n'), maxChars);
}

/** The exact argv we hand to `claude`; exported so tests and docs stay in sync. */
export function claudeArgs({ model, prompt }) {
  return [
    '-p',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SUMMARY_SCHEMA),
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--system-prompt', SYSTEM_PROMPT,
    '--model', model,
    prompt,
  ];
}

/**
 * @param {string} distillate  output of distill()
 * @param {{exec?: Function, model?: string, timeout?: number, cwd?: string}} opts
 * @returns {Promise<{what: string, outcome: string, improvements: string[], followups: string[], model: string}>}
 */
export async function summarize(distillate, {
  exec = execClosedStdin,
  model = process.env.CC_SUMMARY_MODEL || 'haiku',
  timeout = 120000,
  cwd = tmpdir(), // never the repo: a project CLAUDE.md would be pulled into context
  bin = resolveClaudeBin(),
} = {}) {
  const args = claudeArgs({ model, prompt: `Transcript:\n${distillate}` });
  // The desktop app's GUI environment has a bare PATH; make sure the CLI's own
  // dir and the usual tool dirs are visible to whatever it spawns.
  const PATH = [bin.includes('/') ? dirname(bin) : null, process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean).join(':');
  let out;
  try {
    out = await exec(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, cwd, env: { ...process.env, PATH } });
  } catch (e) {
    if (e?.code === 'ENOENT') throw new SummaryError('cli-missing', `claude CLI not found (tried ${bin}); set CC_CLAUDE_BIN in .env.local`);
    throw new SummaryError('cli-failed', `claude exited ${e?.code ?? '?'}`, (e?.stderr || e?.message || '').split('\n')[0]);
  }
  let parsed;
  try { parsed = JSON.parse(out.stdout); } catch { throw new SummaryError('bad-json', 'claude returned non-JSON output'); }
  if (parsed?.is_error) throw new SummaryError('cli-failed', 'claude reported an error', clip(parsed.result || '', 200));
  const s = parsed?.structured_output;
  if (!s || typeof s.what !== 'string' || !OUTCOMES.has(s.outcome)) throw new SummaryError('bad-json', 'claude returned no structured_output');
  return { what: s.what, outcome: s.outcome, improvements: s.improvements || [], followups: s.followups || [], model };
}

/** Summarise one stored session from its transcript and persist the result. */
export async function summarizeSession(db, id, opts = {}) {
  const got = getSession(db, id);
  if (!got) throw new SummaryError('not-found', `session ${id} not in store`);

  const rawRef = got.session.raw_ref;
  const isGemini = rawRef?.endsWith('.db') || got.session.model?.startsWith('gemini');

  let distillate = '';
  if (isGemini) {
    const transcriptPath = resolveGeminiTranscriptPath(rawRef, id);
    if (transcriptPath) {
      try {
        const text = await readFile(transcriptPath, 'utf8');
        const lines = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { lines.push(JSON.parse(line)); } catch {}
        }
        distillate = distillGemini(lines, opts);
      } catch {
        /* fall back to SQLite */
      }
    }
    if (!distillate && rawRef && rawRef.endsWith('.db') && existsSync(rawRef)) {
      distillate = distillGeminiDb(rawRef, opts);
    }
    if (!distillate || !distillate.trim()) {
      throw new SummaryError('not-found', `transcript missing for gemini session: ${id}`);
    }
  } else {
    let text;
    try {
      text = await readFile(rawRef, 'utf8');
    } catch {
      throw new SummaryError('not-found', `transcript missing: ${rawRef}`);
    }
    distillate = distill(parseLines(text), opts);
  }

  const result = await summarize(distillate, opts);
  setSummary(db, id, { summary: JSON.stringify(result), model: result.model });
  return getSession(db, id);
}
