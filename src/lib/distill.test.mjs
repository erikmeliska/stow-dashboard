import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { gatherFacts, formatDistillate, distillProject, CODE_ACTIVITY_EXCLUDES, isMetaDocPath } from './distill.mjs'

const exec = promisify(execFile)

const SAMPLE = {
  directory: '/Users/x/Projekty/codewars',
  project_name: 'codewars',
  created: '2022-08-12T19:30:09.263Z',
  last_modified: '2022-08-28T11:40:26.272Z',
  stack: ['chai'],
  file_types: { '.js': 7, '.json': 2 },
  content_size_bytes: 21887,
  libs_size_bytes: 0,
  git_info: { git_detected: false },
  scc: { total_code: 131, total_files: 8, languages: [{ name: 'JavaScript', code: 126 }] },
}

test('formatDistillate renders facts with root placement note', () => {
  const text = formatDistillate(SAMPLE, { readme: null, topLevel: ['a.js'], commits: [] }, { baseDir: '/Users/x/Projekty' })
  assert.match(text, /name: codewars/)
  assert.match(text, /currently in ROOT, uncategorized/)
  assert.match(text, /README: none/)
  assert.match(text, /git: none/)
  assert.match(text, /\.js×7/)
})

test('formatDistillate notes current category for filed projects', () => {
  const p = { ...SAMPLE, directory: '/Users/x/Projekty/_Learning/codewars' }
  const text = formatDistillate(p, { readme: null, topLevel: [], commits: [] }, { baseDir: '/Users/x/Projekty' })
  assert.match(text, /currently filed under _Learning/)
})

test('formatDistillate truncates README to readmeChars', () => {
  const facts = { readme: 'A'.repeat(5000), topLevel: [], commits: [] }
  const text = formatDistillate(SAMPLE, facts, { readmeChars: 100 })
  assert.ok(text.includes('A'.repeat(100)))
  assert.ok(!text.includes('A'.repeat(101)))
})

test('formatDistillate flags a clone when there are no own commits', () => {
  const p = { ...SAMPLE, git_info: { git_detected: true, total_commits: 500, user_commits: 0, remotes: ['https://github.com/foo/bar'] } }
  const text = formatDistillate(p, { readme: null, topLevel: [], commits: [] }, {})
  assert.match(text, /own commits: 0 of 500/)
  assert.match(text, /no own commits/)
  assert.match(text, /clone of third-party/)
})

test('formatDistillate shows own-commit ratio without clone note when owner contributed', () => {
  const p = { ...SAMPLE, git_info: { git_detected: true, total_commits: 20, user_commits: 12, remotes: [] } }
  const text = formatDistillate(p, { readme: null, topLevel: [], commits: [] }, {})
  assert.match(text, /own commits: 12 of 20/)
  assert.doesNotMatch(text, /clone of third-party/)
})

test('formatDistillate caps topLevel, commits and stack via opts', () => {
  const facts = { readme: null, topLevel: ['a', 'b', 'c', 'd'], commits: ['c1', 'c2', 'c3', 'c4'] }
  const p = { ...SAMPLE, stack: ['s1', 's2', 's3', 's4'] }
  const text = formatDistillate(p, facts, { topLevelMax: 2, commitsMax: 2, stackMax: 2 })
  assert.match(text, /top-level entries: a, b\n/)
  assert.match(text, /recent commits: c1 \| c2\n/)
  assert.match(text, /stack: s1, s2 \(\+2 more\)/)
})

test('formatDistillate masks the path leaf when maskPathLeaf is set', () => {
  const p = { ...SAMPLE, directory: '/Users/x/Projekty/_Learning/nazov-slovo' }
  const text = formatDistillate(p, { readme: null, topLevel: [], commits: [] }, { baseDir: '/Users/x/Projekty', maskPathLeaf: true })
  assert.match(text, /- path: \/Users\/x\/Projekty\/_Learning\/…/)
  assert.doesNotMatch(text, /nazov-slovo/)              // Slovak leaf hidden from the path line
  assert.match(text, /name: codewars/)                  // name line intact
  assert.match(text, /currently filed under _Learning/) // placement note computed from the real path
})

test('distillProject hash changes when facts change', () => {
  const a = distillProject(SAMPLE, { readme: null, topLevel: [], commits: [] }, {})
  const b = distillProject(SAMPLE, { readme: 'hello', topLevel: [], commits: [] }, {})
  assert.equal(a.hash.length, 64)
  assert.notEqual(a.hash, b.hash)
})

test('gatherFacts reads README, top-level names, git subjects and code-activity date', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-distill-'))
  try {
    await mkdir(path.join(dir, 'node_modules'))
    await writeFile(path.join(dir, 'index.js'), '1')
    await exec('git', ['init', '-q'], { cwd: dir })
    await exec('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
    await exec('git', ['config', 'user.name', 'T'], { cwd: dir })
    const dated = (iso) => ({ cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } })
    await exec('git', ['add', '-A'], { cwd: dir })
    await exec('git', ['commit', '-q', '-m', 'code commit'], dated('2020-01-01T00:00:00Z'))
    // later doc-only commit must NOT move the code-activity date
    await writeFile(path.join(dir, 'README.md'), '# Hello\nWorld')
    await exec('git', ['add', '-A'], { cwd: dir })
    await exec('git', ['commit', '-q', '-m', 'update readme'], dated('2026-07-01T00:00:00Z'))
    const facts = await gatherFacts({ directory: dir, git_info: { git_detected: true } })
    assert.equal(facts.readme, '# Hello\nWorld')
    assert.ok(facts.topLevel.includes('index.js'))
    assert.ok(!facts.topLevel.includes('node_modules'))
    assert.deepEqual(facts.commits, ['update readme', 'code commit'])
    assert.match(facts.lastCodeCommit, /^2020-01-01/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gatherFacts returns null lastCodeCommit for doc-only repos', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-distill-'))
  try {
    await writeFile(path.join(dir, 'README.md'), 'docs only')
    await exec('git', ['init', '-q'], { cwd: dir })
    await exec('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
    await exec('git', ['config', 'user.name', 'T'], { cwd: dir })
    await exec('git', ['add', '-A'], { cwd: dir })
    await exec('git', ['commit', '-q', '-m', 'readme'], { cwd: dir })
    const facts = await gatherFacts({ directory: dir, git_info: { git_detected: true } })
    assert.equal(facts.lastCodeCommit, null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gatherFacts survives a missing directory', async () => {
  const facts = await gatherFacts({ directory: '/nonexistent/nope', git_info: {} })
  assert.deepEqual(facts, { readme: null, topLevel: [], commits: [], lastCodeCommit: null })
})

test('isMetaDocPath matches meta-doc files and dirs, case-insensitively for prefixes', () => {
  assert.equal(isMetaDocPath('README.md'), true)
  assert.equal(isMetaDocPath('readme.txt'), true)
  assert.equal(isMetaDocPath('CHANGELOG-2024.md'), true)
  assert.equal(isMetaDocPath('LICENSE'), true)
  assert.equal(isMetaDocPath('docs/setup.md'), true)
  assert.equal(isMetaDocPath('.github/workflows/ci.yml'), true)
  assert.equal(isMetaDocPath('CLAUDE.md'), true)
  assert.equal(isMetaDocPath('src/index.js'), false)
  assert.equal(isMetaDocPath('my-docs-notes.md'), false)   // only the docs/ DIR is excluded
  assert.equal(isMetaDocPath('src/README.md'), true)        // nested README is still a meta-doc
  assert.ok(Array.isArray(CODE_ACTIVITY_EXCLUDES))
})
