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
import { execClosedStdin } from '../analyzer.mjs';
import { assistantTexts, parseLines, toolUses, userPrompts } from './transcript.mjs';
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

const SYSTEM_PROMPT = `You summarise one Claude Code session from a condensed transcript. Answer ONLY with JSON matching the schema.
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
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Condensed, ordered transcript: prompts, tool calls (short), assistant text. */
export function distill(lines, { maxChars = 30000 } = {}) {
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
  let text = parts.join('\n');
  if (text.length > maxChars) {
    // keep the head (what was asked) and the tail (how it ended)
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head - 7;
    text = text.slice(0, head) + '\n[...]\n' + text.slice(-tail);
  }
  return text;
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
  let text;
  try { text = await readFile(got.session.raw_ref, 'utf8'); } catch { throw new SummaryError('not-found', `transcript missing: ${got.session.raw_ref}`); }
  const result = await summarize(distill(parseLines(text)), opts);
  setSummary(db, id, { summary: JSON.stringify(result), model: result.model });
  return getSession(db, id);
}
