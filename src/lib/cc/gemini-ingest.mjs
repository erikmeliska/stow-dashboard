/**
 * Ingest parser for Google Antigravity / Gemini conversation SQLite databases.
 *
 * Extracts session rows compatible with store.mjs (sessions, tool_usage):
 * - session_id, model, tokens (input, output, cached), cost_usd
 * - timestamps, duration, active time
 * - workspace and child project attribution
 * - git repo and branch from trajectory metadata
 * - tool usage counts from steps metadata
 */
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { decodeProto, extractWorkspaceFromBlob } from '../usage.mjs';
import { costForGemini } from '../usage-pricing.mjs';

const ACTIVE_IDLE_SEC = 5 * 60; // cluster events within 5 minutes into active time

export async function listGeminiDbs(dirs = []) {
  const out = [];
  for (const dir of dirs.filter(Boolean)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.db')) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

function extractGitInfo(blob) {
  if (!blob) return { repo: null, branch: null };
  try {
    const top = decodeProto(blob);
    if (!top[1]) return { repo: null, branch: null };
    const f1 = decodeProto(top[1]);
    let branch = null;
    if (f1[4]) {
      branch = Buffer.isBuffer(f1[4]) || f1[4] instanceof Uint8Array ? Buffer.from(f1[4]).toString('utf8') : String(f1[4]);
    }
    let repo = null;
    if (f1[3]) {
      const f3 = decodeProto(f1[3]);
      if (f3[2]) {
        repo = Buffer.isBuffer(f3[2]) || f3[2] instanceof Uint8Array ? Buffer.from(f3[2]).toString('utf8') : String(f3[2]);
      } else if (f3[1]) {
        repo = Buffer.isBuffer(f3[1]) || f3[1] instanceof Uint8Array ? Buffer.from(f3[1]).toString('utf8') : String(f3[1]);
      }
    }
    return { repo, branch };
  } catch {
    return { repo: null, branch: null };
  }
}

/**
 * Parses an Antigravity conversation SQLite database.
 * @param {string|DatabaseSync} dbOrPath
 * @param {{ projectDirs?: string[], rawRef?: string }} opts
 */
export function parseGeminiSession(dbOrPath, { projectDirs = [], rawRef = null } = {}) {
  let db = null;
  let shouldClose = false;
  const filePath = typeof dbOrPath === 'string' ? dbOrPath : rawRef || '';

  if (typeof dbOrPath === 'string') {
    try {
      db = new DatabaseSync(dbOrPath, { open: true, readOnly: true });
      shouldClose = true;
    } catch {
      return null;
    }
  } else if (dbOrPath && typeof dbOrPath.prepare === 'function') {
    db = dbOrPath;
  } else {
    return null;
  }

  try {
    let ws = null;
    let gitInfo = { repo: null, branch: null };
    try {
      const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
      if (row?.data) {
        ws = extractWorkspaceFromBlob(row.data);
        gitInfo = extractGitInfo(row.data);
      }
    } catch {
      /* ignore missing table */
    }

    // Steps, timestamps, active time and tool usage
    const tools = {};
    const accessedPaths = new Set();
    let stepCount = 0;
    const timestamps = [];

    try {
      const rows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC').all();
      stepCount = rows.length;
      for (const r of rows) {
        if (!r.metadata) continue;
        const top = decodeProto(r.metadata);

        // Timestamp
        if (top[1]) {
          const tsMsg = decodeProto(top[1]);
          const sec = tsMsg[1];
          if (sec) timestamps.push(Number(sec));
        }

        // Tool calls: top[4] is ToolCall message: f4[1]=call_id, f4[2]=tool_name, f4[3]=args_json
        if (top[4]) {
          const f4 = decodeProto(top[4]);
          if (f4[2]) {
            const toolName = Buffer.isBuffer(f4[2]) || f4[2] instanceof Uint8Array
              ? Buffer.from(f4[2]).toString('utf8')
              : String(f4[2]);
            tools[toolName] = (tools[toolName] || 0) + 1;

            if (f4[3]) {
              const argsStr = Buffer.isBuffer(f4[3]) || f4[3] instanceof Uint8Array
                ? Buffer.from(f4[3]).toString('utf8')
                : String(f4[3]);
              // Find file paths in tool arguments
              const pathMatches = argsStr.match(/(\/[a-zA-Z0-9_\-\.\/]+)/g);
              if (pathMatches) {
                for (const p of pathMatches) accessedPaths.add(p);
              }
            }
          }
        }
      }
    } catch {
      /* ignore missing table */
    }

    // Resolve project directory:
    // If ws matches a project, use it.
    // If ws is a parent directory (e.g. ~/.vydavatelstvo), check accessedPaths against projectDirs.
    let projectDir = ws;
    if (projectDirs && projectDirs.length > 0) {
      const sortedProjects = [...projectDirs].sort((a, b) => b.length - a.length);
      // First check if any accessed path falls into a known project
      let subprojectMatch = null;
      for (const p of accessedPaths) {
        const found = sortedProjects.find((d) => p === d || p.startsWith(d + '/'));
        if (found) {
          subprojectMatch = found;
          break;
        }
      }

      if (subprojectMatch) {
        projectDir = subprojectMatch;
      } else if (ws) {
        const found = sortedProjects.find((d) => ws === d || ws.startsWith(d + '/'));
        if (found) projectDir = found;
      }
    }

    // Calculate timestamps, duration and active time
    timestamps.sort((a, b) => a - b);
    const startedAt = timestamps.length > 0 ? new Date(timestamps[0] * 1000).toISOString() : null;
    const endedAt = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString() : null;
    const duration_s = timestamps.length >= 2 ? Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]) : 0;

    let active_s = 0;
    for (let i = 0; i < timestamps.length; i++) {
      if (i === 0) {
        active_s += 1;
      } else {
        const delta = timestamps[i] - timestamps[i - 1];
        active_s += delta <= ACTIVE_IDLE_SEC ? delta : 1;
      }
    }

    // Models, tokens and cost
    let primaryModel = null;
    let maxOutput = -1;
    let totalInput = 0;
    let totalCached = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let priced = false;

    try {
      const rows = db.prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC').all();
      const byModel = {};
      for (const r of rows) {
        if (!r.data) continue;
        const top = decodeProto(r.data);
        const f1 = top[1] ? decodeProto(top[1]) : {};
        const model = f1[19]
          ? (Buffer.isBuffer(f1[19]) || f1[19] instanceof Uint8Array ? Buffer.from(f1[19]).toString('utf8') : String(f1[19]))
          : 'unknown';

        const f4 = f1[4] ? decodeProto(f1[4]) : {};
        const inp = Number(f4[2] || 0);
        const cinp = Number(f4[5] || 0);
        const outp = Number(f4[3] || 0);

        totalInput += inp;
        totalCached += cinp;
        totalOutput += outp;

        const m = byModel[model] ??= { input: 0, cachedInput: 0, output: 0 };
        m.input += inp;
        m.cachedInput += cinp;
        m.output += outp;

        if (m.output > maxOutput) {
          maxOutput = m.output;
          primaryModel = model;
        }
      }

      for (const [model, m] of Object.entries(byModel)) {
        const c = costForGemini(m, model);
        if (c != null) {
          totalCost += c;
          priced = true;
        }
      }
    } catch {
      /* ignore missing table */
    }

    const sessionId = filePath ? basename(filePath).replace(/\.db$/, '') : null;

    return {
      session_id: sessionId,
      project_dir: projectDir,
      cwd: ws,
      model: primaryModel || 'gemini-3.8-flash',
      started_at: startedAt,
      ended_at: endedAt,
      duration_s,
      active_s,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read: totalCached,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cost_usd: priced ? totalCost : null,
      turns: stepCount,
      status: endedAt ? 'done' : 'unknown',
      git_repo: gitInfo.repo,
      git_branch: gitInfo.branch,
      pr: null,
      ticket_id: null,
      ticket_source: null,
      quality_score: null,
      quality_detail: null,
      raw_ref: filePath || null,
      ingested_at: new Date().toISOString(),
      _tools: tools,
      _skills: {},
      _editedSkills: new Set(),
    };
  } finally {
    if (shouldClose && db) {
      try { db.close(); } catch { /* ignore close error */ }
    }
  }
}
