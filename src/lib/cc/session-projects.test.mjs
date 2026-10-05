import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UNASSIGNED, projectIndex, annotateSessions, parseWorkspace, facetCounts } from './session-projects.mjs'

const REGISTRY = {
  clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:gitlab.com/intelimail/blog'] }],
  projects: [
    { key: 'git:gitlab.com/intelimail/blog', name: 'blog', client: { id: 'intelimail', name: 'Intelimail', source: 'ai' } },
    { key: 'path:/p/sandbox', name: 'sandbox', client: null },
  ],
}

test('projectIndex maps project key to project and client', () => {
  const idx = projectIndex(REGISTRY)
  assert.deepEqual(idx.get('git:gitlab.com/intelimail/blog'),
    { project_key: 'git:gitlab.com/intelimail/blog', project_name: 'blog', client_id: 'intelimail', client_name: 'Intelimail' })
  assert.deepEqual(idx.get('path:/p/sandbox'),
    { project_key: 'path:/p/sandbox', project_name: 'sandbox', client_id: null, client_name: null })
})

test('projectIndex tolerates a missing or empty register', () => {
  assert.equal(projectIndex(null).size, 0)
  assert.equal(projectIndex({}).size, 0)
})

test('annotateSessions joins known keys and falls back for unknown or null keys', () => {
  const idx = projectIndex(REGISTRY)
  const rows = [
    { session_id: 'a', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog-huha' },
    { session_id: 'b', project_key: 'stow:old-id', project_dir: '/p/renamed' },
    { session_id: 'c', project_key: null, base_dir: '/p/main', project_dir: '/p/main/.agent-office/worktrees/x' },
    { session_id: 'd', project_key: null, project_dir: null },
  ]
  const out = annotateSessions(rows, idx)
  assert.deepEqual(out.map((r) => [r.project_name, r.client_id, r.client_name]), [
    ['blog', 'intelimail', 'Intelimail'],
    ['renamed', null, null],
    ['main', null, null],
    ['—', null, null],
  ])
  assert.equal(rows[0].client_id, undefined, 'input rows are not mutated')
  assert.equal(annotateSessions(rows)[0].client_id, null, 'no index → unassigned')
})

test('parseWorkspace: main, known kinds (#12 stores kind:name), unknown kinds', () => {
  assert.equal(parseWorkspace(null), null)
  assert.equal(parseWorkspace(''), null)
  assert.deepEqual(parseWorkspace('agent-office:pixel-77d1'),
    { kind: 'agent-office', name: 'pixel-77d1', label: 'Agent Office · pixel-77d1', raw: 'agent-office:pixel-77d1' })
  assert.equal(parseWorkspace('git-worktree:feat').kind, 'git-worktree')
  assert.equal(parseWorkspace('scratchpad:abcd1234').name, 'abcd1234')
  assert.deepEqual(parseWorkspace('weird-thing'),
    { kind: 'other', name: 'weird-thing', label: 'weird-thing', raw: 'weird-thing' })
  assert.equal(parseWorkspace('newkind:x').kind, 'other')
  assert.equal(parseWorkspace('newkind:x').label, 'newkind:x')
})

test('facetCounts counts families by root, lists Unassigned last, keeps selected zero-count entries', () => {
  const fams = annotateSessions([
    { session_id: 'a', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog', workspace: null },
    { session_id: 'b', project_key: 'git:gitlab.com/intelimail/blog', project_dir: '/p/blog', workspace: 'agent-office:pixel-1' },
    { session_id: 'c', project_key: 'path:/p/sandbox', project_dir: '/p/sandbox', workspace: null },
  ], projectIndex(REGISTRY))
  const f = facetCounts(fams, { keep: { clients: ['acme'], projects: ['git:gone'], workspace: 'agent-office:old' } })
  assert.deepEqual(f.clients.map((c) => [c.id, c.count]), [['intelimail', 2], ['acme', 0], [UNASSIGNED, 1]])
  assert.deepEqual(f.projects.map((p) => [p.key, p.count]), [['git:gitlab.com/intelimail/blog', 2], ['path:/p/sandbox', 1], ['git:gone', 0]])
  assert.deepEqual(f.workspaces, {
    main: 2, worktrees: 1,
    byKind: [{ kind: 'agent-office', label: 'Agent Office', items: [
      { value: 'agent-office:pixel-1', label: 'pixel-1', count: 1 },
      { value: 'agent-office:old', label: 'old', count: 0 },
    ] }],
  })
})

test('facetCounts: an unplaced family is its own project bucket keyed like the table groups it', () => {
  const f = facetCounts(annotateSessions([{ session_id: 'x', project_key: null, base_dir: '/p/loose', project_dir: '/p/loose' }]))
  assert.deepEqual(f.projects.map((p) => [p.key, p.name, p.count]), [['/p/loose', 'loose', 1]])
  assert.deepEqual(f.clients.map((c) => [c.id, c.name]), [[UNASSIGNED, 'Unassigned']])
})
