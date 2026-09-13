import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseGeminiSession } from './gemini-ingest.mjs';
import { openStore, getSession, listSessions } from './store.mjs';

function encVarint(n) {
  const bytes = [];
  let val = BigInt(n);
  while (val >= 0x80n) {
    bytes.push(Number((val & 0x7fn) | 0x80n));
    val >>= 7n;
  }
  bytes.push(Number(val));
  return Buffer.from(bytes);
}

function encField(fieldNum, wireType, data) {
  const tag = (fieldNum << 3) | wireType;
  const tagBuf = encVarint(tag);
  if (wireType === 0) return Buffer.concat([tagBuf, encVarint(data)]);
  if (wireType === 2) {
    const valBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return Buffer.concat([tagBuf, encVarint(valBuf.length), valBuf]);
  }
  throw new Error(`unsupported wireType ${wireType}`);
}

test('parseGeminiSession extracts metadata, timestamps, tokens, and tools', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
  db.exec('CREATE TABLE steps (idx INT, metadata BLOB)');
  db.exec('CREATE TABLE gen_metadata (idx INT, data BLOB)');

  // 1. Workspace in trajectory_metadata_blob
  const gitF1 = Buffer.concat([
    encField(1, 2, 'file:///p/test-project'),
    encField(3, 2, encField(2, 2, 'https://github.com/test/repo.git')),
    encField(4, 2, 'main'),
  ]);
  const traj = Buffer.concat([
    encField(1, 2, gitF1),
    encField(7, 2, 'file:///p/test-project'),
  ]);
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', traj);

  // 2. Steps: timestamps and tool call
  const tsMsg1 = encField(1, 0, 1750000000);
  const step1 = encField(1, 2, tsMsg1);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, step1);

  const tsMsg2 = encField(1, 0, 1750000100);
  const toolCall = Buffer.concat([
    encField(1, 2, 'call_1'),
    encField(2, 2, 'view_file'),
    encField(3, 2, JSON.stringify({ AbsolutePath: '/p/test-project/src/index.js' })),
  ]);
  const step2 = Buffer.concat([
    encField(1, 2, tsMsg2),
    encField(4, 2, toolCall),
  ]);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(1, step2);

  // 3. Gen metadata: gemini-3.8-flash
  const f4 = Buffer.concat([
    encField(2, 0, 1000), // input
    encField(5, 0, 500),  // cached
    encField(3, 0, 200),  // output
  ]);
  const f1 = Buffer.concat([
    encField(19, 2, 'gemini-3.8-flash'),
    encField(4, 2, f4),
  ]);
  const genData = encField(1, 2, f1);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, genData);

  const parsed = parseGeminiSession(db, {
    projectDirs: ['/p/test-project'],
    rawRef: '/tmp/test-session-123.db',
  });

  assert.equal(parsed.session_id, 'test-session-123');
  assert.equal(parsed.project_dir, '/p/test-project');
  assert.equal(parsed.cwd, '/p/test-project');
  assert.equal(parsed.model, 'gemini-3.8-flash');
  assert.equal(parsed.turns, 2);
  assert.equal(parsed.input_tokens, 1000);
  assert.equal(parsed.cache_read, 500);
  assert.equal(parsed.output_tokens, 200);
  assert.equal(parsed.duration_s, 100);
  assert.equal(parsed.git_repo, 'https://github.com/test/repo.git');
  assert.equal(parsed.git_branch, 'main');
  assert.equal(parsed._tools.view_file, 1);
  assert.ok(parsed.cost_usd > 0);
});

test('parseGeminiSession attributes subproject when cwd is parent directory', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
  db.exec('CREATE TABLE steps (idx INT, metadata BLOB)');
  db.exec('CREATE TABLE gen_metadata (idx INT, data BLOB)');

  const traj = encField(7, 2, 'file:///p/parent-dir');
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', traj);

  // Step with tool call targeting subproject
  const tsMsg = encField(1, 0, 1750000000);
  const toolCall = Buffer.concat([
    encField(1, 2, 'call_1'),
    encField(2, 2, 'write_to_file'),
    encField(3, 2, JSON.stringify({ TargetFile: '/p/parent-dir/repos/my-sub-app/src/app.js' })),
  ]);
  const step = Buffer.concat([
    encField(1, 2, tsMsg),
    encField(4, 2, toolCall),
  ]);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, step);

  const parsed = parseGeminiSession(db, {
    projectDirs: ['/p/parent-dir/repos/my-sub-app', '/p/other'],
    rawRef: '/tmp/session-456.db',
  });

  assert.equal(parsed.session_id, 'session-456');
  assert.equal(parsed.cwd, '/p/parent-dir');
  assert.equal(parsed.project_dir, '/p/parent-dir/repos/my-sub-app');
});
