import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs'

test('key prefers project_key, then base_dir, then project_dir', () => {
  assert.equal(sessionProjectKey({ project_key: 'P', base_dir: '/p', project_dir: '/p/.claude/worktrees/x' }), 'P')
  assert.equal(sessionProjectKey({ base_dir: '/p', project_dir: '/p/.claude/worktrees/x' }), '/p')
  assert.equal(sessionProjectKey({ project_dir: '/q' }), '/q')
  assert.equal(sessionProjectKey({}), '')
})

test('label prefers project_name, then basename of base_dir', () => {
  assert.equal(sessionProjectLabel({ project_name: 'Blog', base_dir: '/p/blog' }), 'Blog')
  assert.equal(sessionProjectLabel({ base_dir: '/p/blog', project_dir: '/p/blog/.agent-office/worktrees/x' }), 'blog')
  assert.equal(sessionProjectLabel({}), '—')
})
