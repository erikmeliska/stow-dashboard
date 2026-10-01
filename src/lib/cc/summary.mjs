/**
 * AI session summary via a local agent CLI — `claude` (default) or `codex`,
 * chosen by CC_SUMMARY_HARNESS (no API key; runs on your subscription).
 * On-demand only — never called from ingest.
 *
 * Claude flags:
 * Flag rationale (measured 2026-08-21, haiku, trivial prompt):
 *   naive `claude -p` in the repo cwd          ≈150k ctx tokens, $0.16/call
 *   + --strict-mcp-config/--setting-sources "" ≈7.5k,           $0.017
 *   + --system-prompt (drops the default)      ≈1k,             $0.0025
 * `--no-session-persistence` is mandatory: otherwise every summary writes a
 * transcript under ~/.claude/projects that cc-ingest then indexes (a loop).
 * `--tools ""` keeps the call a pure text → JSON step. `--bare` was tried and
 * fails (is_error, no tokens) on Claude Code 2.1.x — do not add it.
 *
 * Codex flags: `--ephemeral` is the counterpart of --no-session-persistence
 * (no rollout under ~/.codex/sessions for the Codex ingest to pick up);
 * `--ignore-user-config --ignore-rules` skip config.toml (MCP servers, a
 * pinned model) and project rules — ~6.5 s instead of ~10 s per call;
 * `--sandbox read-only` + an empty temp dir as cwd keep it a text → JSON step.
 * Codex has no system-prompt flag, so the instructions lead the prompt.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execClosedStdin } from '../analyzer.mjs';
import { assistantTexts, bashCommands, parseLines, toolUses, userPrompts } from './transcript.mjs';
import { decodeProto } from '../usage.mjs';
import { getSession, setSummary } from './store.mjs';
import { contentText, isInjectedPrompt } from './codex-ingest.mjs';
import { DEFAULT_MODELS, HARNESSES } from './summary-view.mjs';

export const SUMMARY_VERSION = 2;
export const OUTCOMES = ['done', 'partial', 'abandoned', 'exploration'];
export const KIND_HINTS = ['work', 'agent-spawn', 'trivial'];

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'at most 60 characters: what the session was about, without the project name' },
    what: { type: 'string', description: '2-4 concrete sentences: what was worked on and the result' },
    outcome: { type: 'string', enum: OUTCOMES },
    improvements: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'what concretely came out of it' },
    followups: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'what is left / the next step' },
    kind_hint: { type: 'string', enum: KIND_HINTS },
  },
  required: ['title', 'what', 'outcome', 'improvements', 'followups', 'kind_hint'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You summarise one AI coding session from a condensed transcript. Answer ONLY with JSON matching the schema.
The first lines give metadata (project, harness, time, size) and facts extracted from the transcript (files edited, commits, final answers). Use them; do not repeat them verbatim.
"title": at most 60 characters, what the session was about. Do not include the project name.
"what": 2-4 plain, concrete sentences on what was worked on and what the result was.
"outcome": done (the goal was reached) | partial (progress, work remains) | abandoned (dropped or failed) | exploration (research, questions or prototyping; no deliverable was intended).
"improvements": what actually came out of it (features, fixes, docs, skills, decisions), at most 5; empty if nothing.
"followups": open items or the next step, at most 4; empty if none.
"kind_hint": work (a human drove the session) | agent-spawn (the prompt is machine-generated: a dispatched task, a persona review, a security review) | trivial (fewer than two meaningful exchanges, nothing was produced).
Do not invent anything: if the result cannot be told from the transcript, say so cautiously.
Be concrete. No marketing language. Write in the language the user wrote in.`;

export { HARNESSES, DEFAULT_MODELS };

/** CC_SUMMARY_HARNESS, normalised; anything unknown falls back to claude. */
export function summaryHarness(env = process.env) {
  const h = String(env.CC_SUMMARY_HARNESS || '').trim().toLowerCase();
  return HARNESSES.includes(h) ? h : HARNESSES[0];
}

/** Model for one on-demand summary (Generate button, `cc:eval --id`). */
export function summaryModel(env = process.env, harness = summaryHarness(env)) {
  return (env.CC_SUMMARY_MODEL || '').trim() || DEFAULT_MODELS[harness].single;
}

const BIN_ENV = { claude: 'CC_CLAUDE_BIN', codex: 'CC_CODEX_BIN' };

/**
 * Where a harness binary usually lives. The desktop app launched from the
 * Dock gets macOS's minimal GUI PATH (no ~/.local/bin, no Homebrew), so a bare
 * `claude` fails with ENOENT there even though it works in a terminal.
 * Resolution: CC_<HARNESS>_BIN env → first existing well-known path → bare name on PATH.
 */
export function resolveHarnessBin(harness, env = process.env, home = homedir(), exists = existsSync) {
  if (env[BIN_ENV[harness]]) return env[BIN_ENV[harness]];
  const candidates = [
    join(home, '.local', 'bin', harness),
    ...(harness === 'claude' ? [join(home, '.claude', 'local', 'claude')] : []),
    `/opt/homebrew/bin/${harness}`,
    `/usr/local/bin/${harness}`,
  ];
  return candidates.find((p) => exists(p)) || harness;
}

export function resolveClaudeBin(env = process.env, home = homedir(), exists = existsSync) {
  return resolveHarnessBin('claude', env, home, exists);
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
  if (maxChars < 20) return text.slice(0, Math.max(0, maxChars));
  if (text.length > maxChars) {
    // keep the head (what was asked) and the tail (how it ended)
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head - 7;
    return text.slice(0, head) + '\n[...]\n' + text.slice(-tail);
  }
  return text;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Last two path segments: enough to recognise a file, short enough for the prompt. */
function shortPath(p) {
  return String(p || '').split('/').filter(Boolean).slice(-2).join('/');
}

/** Subject line of a `git commit` command (-m "…" or a heredoc); null when there is none. */
export function commitMessage(cmd) {
  const s = String(cmd || '');
  if (!/\bgit\s+commit\b/.test(s)) return null;
  const h = /<<\s*'?EOF'?\s*\n([^\n]+)/.exec(s);
  if (h) return h[1].trim() || null;
  const m = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(s);
  return m ? (m[1] ?? m[2]).split('\n')[0].trim() || null : null;
}

/** What helped the PoC most: files edited, commit subjects, the last three agent answers. */
export function factsHeader({ edited = [], commits = [], finals = [] } = {}) {
  const out = [];
  if (edited.length) out.push(`FILES EDITED: ${[...new Set(edited)].slice(0, 15).join(', ')}`);
  if (commits.length) out.push(`COMMITS: ${commits.slice(0, 5).map((c) => clip(c, 160)).join(' | ')}`);
  for (const f of finals.slice(-3)) out.push(`FINAL ANSWER: ${clip(f, 400)}`);
  return out.length ? out.join('\n') + '\n---\n' : '';
}

export function claudeFacts(lines) {
  const edited = toolUses(lines).filter((u) => EDIT_TOOLS.has(u.tool) && u.input.file_path).map((u) => shortPath(u.input.file_path));
  const commits = bashCommands(lines).map(commitMessage).filter(Boolean);
  return { edited, commits, finals: assistantTexts(lines).slice(-3) };
}

/** Header first, then the head/tail-limited body; the total never exceeds maxChars. */
function withHeader(header, body, maxChars) {
  const h = header.slice(0, maxChars);
  return h + limitChars(body, maxChars - h.length);
}

/** Metadata lines prepended to every summary prompt (the model must not guess these). */
export function sessionMeta(s) {
  const project = s?.project_dir ? s.project_dir.split('/').filter(Boolean).at(-1) : 'unknown';
  const mins = Math.round((s?.active_s || 0) / 60);
  return [
    `Project: ${project}`,
    `Harness: ${s?.entrypoint || 'unknown'}`,
    `Started: ${s?.started_at || '?'} · active ${mins} min · ${s?.turns ?? '?'} turns${s?.git_branch ? ` · branch ${s.git_branch}` : ''}`,
  ].join('\n');
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

/** Shell command of a Codex function_call (exec_command {cmd} or shell {command: [...]}); null otherwise. */
function codexCommand(p) {
  try {
    const a = JSON.parse(p.arguments || '{}');
    if (Array.isArray(a.command)) return a.command.join(' ');
    return a.cmd || a.command || null;
  } catch {
    return null;
  }
}

const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

export function codexFacts(lines) {
  const edited = [], commits = [], finals = [];
  for (const d of lines || []) {
    const p = d?.payload || {};
    if (d.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string') {
      for (const m of p.input.matchAll(PATCH_FILE_RE)) edited.push(shortPath(m[1]));
    }
    if (d.type === 'response_item' && p.type === 'function_call') {
      const msg = commitMessage(codexCommand(p));
      if (msg) commits.push(msg);
    }
    if (d.type === 'event_msg' && p.type === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) finals.push(p.last_agent_message);
  }
  return { edited, commits, finals };
}

/** Condensed, ordered transcript for a Codex rollout (same USER/TOOL/ASSISTANT shape as distill()). */
export function distillCodex(lines, { maxChars = 30000 } = {}) {
  const parts = [];
  for (const d of lines || []) {
    const p = d?.payload || {};
    if (d?.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const t = contentText(p.content).trim();
      if (t && !isInjectedPrompt(t)) parts.push(`USER: ${clip(t, 1200)}`);
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = contentText(p.content).trim();
      if (t) parts.push(`ASSISTANT: ${clip(t, 600)}`);
    } else if (p.type === 'function_call' && p.name) {
      parts.push(`TOOL ${p.name}: ${clip(codexCommand(p) || cleanToolArg(p.arguments), 160)}`);
    } else if (p.type === 'custom_tool_call' && p.name) {
      const files = typeof p.input === 'string' ? [...p.input.matchAll(PATCH_FILE_RE)].map((m) => shortPath(m[1])) : [];
      parts.push(`TOOL ${p.name}: ${clip(files.length ? files.join(', ') : cleanToolArg(p.input), 160)}`);
    }
  }
  return withHeader(factsHeader(codexFacts(lines)), parts.join('\n'), maxChars);
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
  return withHeader(factsHeader(claudeFacts(lines)), parts.join('\n'), maxChars);
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

/** argv for `codex exec`; the schema and the answer go through files in `dir`. */
export function codexArgs({ model, prompt, dir }) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--output-schema', join(dir, 'schema.json'),
    '-o', join(dir, 'answer.json'),
    '-C', dir,
    ...(model ? ['-m', model] : []),
    `${SYSTEM_PROMPT}\n\n${prompt}`,
  ];
}

/** The model codex reports in its stderr header (`model: gpt-…`); null when absent. */
export function codexReportedModel(stderr) {
  const m = /^model:\s*(\S+)/m.exec(String(stderr || ''));
  return m ? m[1] : null;
}

async function runClaude({ exec, bin, model, prompt, timeout, cwd, env }) {
  const out = await exec(bin, claudeArgs({ model, prompt }), { timeout, maxBuffer: 8 * 1024 * 1024, cwd, env });
  let parsed;
  try { parsed = JSON.parse(out.stdout); } catch { throw new SummaryError('bad-json', 'claude returned non-JSON output'); }
  if (parsed?.is_error) throw new SummaryError('cli-failed', 'claude reported an error', clip(parsed.result || '', 200));
  return { s: parsed?.structured_output, model };
}

async function runCodex({ exec, bin, model, prompt, timeout, env }) {
  const dir = await mkdtemp(join(tmpdir(), 'stow-summary-'));
  try {
    await writeFile(join(dir, 'schema.json'), JSON.stringify(SUMMARY_SCHEMA));
    const out = await exec(bin, codexArgs({ model, prompt, dir }), { timeout, maxBuffer: 8 * 1024 * 1024, cwd: dir, env });
    let text;
    try { text = await readFile(join(dir, 'answer.json'), 'utf8'); } catch { throw new SummaryError('bad-json', 'codex wrote no answer'); }
    let s;
    try { s = JSON.parse(text); } catch { throw new SummaryError('bad-json', 'codex returned non-JSON output'); }
    return { s, model: model || codexReportedModel(out?.stderr) || 'codex-default' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const RUNNERS = { claude: runClaude, codex: runCodex };

/**
 * @param {string} distillate  output of distill()/distillCodex()/distillGemini()
 * @param {{meta?: string, exec?: Function, harness?: 'claude'|'codex', model?: string, timeout?: number, cwd?: string, bin?: string, clock?: () => number}} opts
 * @returns {Promise<{v: 2, title: string|null, what: string, outcome: string, improvements: string[], followups: string[], kind_hint: string, harness: string, model: string, ms: number}>}
 */
export async function summarize(distillate, {
  meta = '',
  exec = execClosedStdin,
  harness = summaryHarness(),
  model = summaryModel(process.env, harness),
  timeout = 120000,
  cwd = tmpdir(), // never the repo: a project CLAUDE.md would be pulled into context
  bin = resolveHarnessBin(harness),
  clock = Date.now,
} = {}) {
  if (!RUNNERS[harness]) throw new SummaryError('cli-failed', `unknown summary harness: ${harness}`);
  const prompt = `${meta ? `${meta}\n\n` : ''}Transcript:\n${distillate}`;
  // The desktop app's GUI environment has a bare PATH; make sure the CLI's own
  // dir and the usual tool dirs are visible to whatever it spawns.
  const PATH = [bin.includes('/') ? dirname(bin) : null, process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean).join(':');
  const t0 = clock();
  let res;
  try {
    res = await RUNNERS[harness]({ exec, bin, model, prompt, timeout, cwd, env: { ...process.env, PATH } });
  } catch (e) {
    if (e instanceof SummaryError) throw e;
    if (e?.code === 'ENOENT') throw new SummaryError('cli-missing', `${harness} CLI not found (tried ${bin}); set ${BIN_ENV[harness]} in .env.local`);
    throw new SummaryError('cli-failed', `${harness} exited ${e?.code ?? '?'}`, (e?.stderr || e?.message || '').split('\n')[0]);
  }
  const s = res.s;
  if (!s || typeof s.what !== 'string' || !OUTCOMES.includes(s.outcome)) throw new SummaryError('bad-json', `${harness} returned no structured output`);
  const list = (x, n) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string').slice(0, n) : []);
  return {
    v: SUMMARY_VERSION,
    title: typeof s.title === 'string' && s.title.trim() ? clip(s.title, 60) : null,
    what: s.what,
    outcome: s.outcome,
    improvements: list(s.improvements, 5),
    followups: list(s.followups, 4),
    kind_hint: KIND_HINTS.includes(s.kind_hint) ? s.kind_hint : 'work',
    harness,
    model: res.model,
    ms: clock() - t0,
  };
}

/** Summarise one stored session from its transcript and persist the result. */
export async function summarizeSession(db, id, opts = {}) {
  const got = getSession(db, id);
  if (!got) throw new SummaryError('not-found', `session ${id} not in store`);

  const rawRef = got.session.raw_ref;
  const isGemini = rawRef?.endsWith('.db') || got.session.model?.startsWith('gemini');

  const isCodex = String(got.session.entrypoint || '').startsWith('codex');

  let distillate = '';
  if (isCodex) {
    let text;
    try {
      text = await readFile(rawRef, 'utf8');
    } catch {
      throw new SummaryError('not-found', `transcript missing: ${rawRef}`);
    }
    distillate = distillCodex(parseLines(text), opts);
  } else if (isGemini) {
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

  const result = await summarize(distillate, { ...opts, meta: sessionMeta(got.session) });
  setSummary(db, id, { summary: JSON.stringify(result), model: result.model });
  return getSession(db, id);
}
