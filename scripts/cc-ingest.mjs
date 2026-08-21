#!/usr/bin/env node
/**
 * cc-ingest — bring the Claude Code session store (data/cc-sessions.db) up to
 * date from ~/.claude transcripts + cc-guard's audit. Incremental by default.
 *
 *   npm run cc:ingest             # only changed transcripts
 *   npm run cc:ingest -- --full   # re-parse everything
 *   CC_CLAUDE_DIR=/x/projects CC_GUARD_AUDIT=/x/audit.jsonl npm run cc:ingest
 *
 * Logic lives in src/lib/cc/ingest-run.mjs (shared with the app's refresh cycle).
 */
import { runIngest } from '../src/lib/cc/ingest-run.mjs';

const full = process.argv.includes('--full');
const r = await runIngest({ full });
console.log(`cc-ingest: ${r.sessions} sessions (${r.changed} parsed, ${r.skipped} unchanged) in ${(r.ms / 1000).toFixed(1)}s`);
