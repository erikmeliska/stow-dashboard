import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeClaudeSlug, resolveWorkspacePath, formatWorkspace } from './workspace.mjs'

const AO = '/Users/e/Projekty/_AgentOffice/erikmeliska/stow-dashboard'
const VYD = '/Users/e/Projekty/_Bizz/TriSoft/vydavatelstvo'

test('encodeClaudeSlug replaces every non-alphanumeric char with a dash', () => {
  assert.equal(encodeClaudeSlug(`${VYD}/.claude/worktrees/admiring-williamson-fa72a2`),
    '-Users-e-Projekty--Bizz-TriSoft-vydavatelstvo--claude-worktrees-admiring-williamson-fa72a2')
})

test('agent-office worktree maps to the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${AO}/.agent-office/worktrees/pixel-77d1`),
    { base_dir: AO, workspace: 'agent-office:pixel-77d1', matched: true })
})

test('a sub-path inside a worktree keeps its sub-path on the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${AO}/.agent-office/worktrees/pixel-77d1/packages/a`),
    { base_dir: `${AO}/packages/a`, workspace: 'agent-office:pixel-77d1', matched: true })
})

test('.claude worktree maps to the main checkout', () => {
  assert.deepEqual(resolveWorkspacePath(`${VYD}/.claude/worktrees/eloquent-shamir-6bd961`),
    { base_dir: VYD, workspace: 'claude-worktree:eloquent-shamir-6bd961', matched: true })
})

test('scratchpad of a .claude worktree resolves via the known dirs', () => {
  const run = `/private/tmp/claude-501/${encodeClaudeSlug(`${VYD}/.claude/worktrees/admiring-williamson-fa72a2`)}/9ce1e738-72cd-4f13-b52c-6c0d5bd65d05/scratchpad/skills-grid`
  assert.deepEqual(resolveWorkspacePath(run, { knownDirs: [VYD, '/Users/e/Projekty'] }),
    { base_dir: VYD, workspace: 'scratchpad:9ce1e738', matched: true })
})

test('scratchpad under /tmp works too', () => {
  const run = `/tmp/claude-501/${encodeClaudeSlug(AO)}/abcdef12-0000-0000-0000-000000000000/scratchpad`
  assert.equal(resolveWorkspacePath(run, { knownDirs: [AO] }).base_dir, AO)
})

test('undecodable scratchpad keeps the workspace, base_dir null', () => {
  const run = '/private/tmp/claude-501/-Some-Unknown-dir/abcdef12-0000-0000-0000-000000000000/scratchpad'
  assert.deepEqual(resolveWorkspacePath(run, { knownDirs: [AO] }),
    { base_dir: null, workspace: 'scratchpad:abcdef12', matched: true })
})

test('ambiguous scratchpad encoding (tie) does not guess', () => {
  const run = `/private/tmp/claude-501/-a-b-c/abcdef12-0000-0000-0000-000000000000/scratchpad`
  assert.equal(resolveWorkspacePath(run, { knownDirs: ['/a/b-c', '/a/b/c'] }).base_dir, null)
})

test('dirs that only mention worktrees are plain', () => {
  for (const d of ['/p/worktrees-demo/app', `${AO}/.agent-office/worktrees`, `${AO}/.agent-office/worktrees/`]) {
    assert.deepEqual(resolveWorkspacePath(d), { base_dir: d.replace(/\/$/, ''), workspace: null, matched: false })
  }
})

test('null run dir', () => {
  assert.deepEqual(resolveWorkspacePath(null), { base_dir: null, workspace: null, matched: false })
})

test('formatWorkspace', () => {
  assert.equal(formatWorkspace('agent-office:pixel-77d1'), 'agent-office: pixel-77d1')
  assert.equal(formatWorkspace(null), null)
})
