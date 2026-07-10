# AI Project Analysis — Phase 0 Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the distillate builder, deterministic tech extraction, and the apfel-driven analyzer, then run a pilot over ~20 known projects and present a review table — the go/no-go gate for phases 1–3.

**Architecture:** Three pure-logic-first Node modules (`tech-tags.mjs`, `distill.mjs`, `analyzer.mjs`) plus a pilot CLI (`scripts/analyze.mjs`). The Apple on-device model is reached exclusively through the `apfel` CLI as a subprocess (same pattern as `scc` in the scanner). All model I/O is schema-constrained JSON; everything deterministic (status, tech merge, suggested paths) is computed in Node, never asked of the model.

**Tech Stack:** Node 20+ ESM (`.mjs`), `node --test` + `node:assert/strict` (existing repo convention — see `src/lib/scripts.test.mjs`), `execFile` from `node:child_process`, `apfel` ≥ 1.8 CLI (Homebrew), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-ai-project-analysis-design.md`

## Global Constraints

- No new npm dependencies; standard library only.
- All model calls: `apfel --schema <file> --temperature 0 -q --retry=3` — deterministic, quiet, schema-constrained.
- apfel exit codes: 3 = guardrail refused, 4 = context overflow, 5 = model unavailable, 6 = busy. Exit 5 aborts the batch; 3/4/6 mark the project and continue.
- Context budget: distillate ≤ ~3k tokens (model context 4096, output reserve ~512). Preflight with `apfel --count-tokens --strict`.
- The model never composes filesystem paths; Node derives `suggested_path`, `status`, `placement_ok`, merged `tech`.
- Facet enums (from spec): `project_type` = web-app, api-service, cli-tool, library, browser-extension, desktop-app, mobile-app, script-collection, infra-config, template-boilerplate, prototype-poc, fork, content-docs. `domain` = e-commerce, communication-email, church-community, finance, education, devtools, iot-electronics, media, ai-ml, productivity, games, other. `maturity` = idea, prototype, mvp, production, abandoned-wip.
- Status rules: active ≤ 3 months since last activity, dormant ≤ 18, else dead; archive-candidate = dead ∧ no git remote ∧ `scc.total_code` < 1000.
- Tests must not require `apfel` or network — subprocess calls are injected (`execImpl` parameter). Only the pilot CLI run itself touches the real model.

---

### Task 1: Deterministic tech extraction (`src/lib/tech-tags.mjs`)

**Files:**
- Create: `src/lib/tech-tags.mjs`
- Test: `src/lib/tech-tags.test.mjs`

**Interfaces:**
- Produces: `normalizeTech(tags: string[]): string[]` — lowercased, slugified, synonym-mapped, deduped, sorted.
- Produces: `extractTech(project: object, topLevelNames?: string[]): string[]` — canonical tags from `project.stack`, `project.file_types`, and top-level file names. Already normalized.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/tech-tags.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTech, extractTech } from './tech-tags.mjs'

test('normalizeTech lowercases, maps synonyms, dedupes, sorts', () => {
  assert.deepEqual(
    normalizeTech(['Next.js', 'nextjs', 'PostgreSQL', 'TailwindCSS', ' Docker Compose ']),
    ['docker', 'nextjs', 'postgres', 'tailwind']
  )
})

test('normalizeTech keeps unknown tags as slugs', () => {
  assert.deepEqual(normalizeTech(['Home Assistant']), ['home-assistant'])
})

test('normalizeTech drops empty and non-string entries', () => {
  assert.deepEqual(normalizeTech(['', null, undefined, 'react']), ['react'])
})

test('extractTech maps known deps and ignores unknown dep noise', () => {
  const project = { stack: ['next', 'react', 'react-dom', 'ansi-styles', 'chalk'], file_types: {} }
  assert.deepEqual(extractTech(project), ['nextjs', 'react'])
})

test('extractTech picks up file extensions and top-level signal files', () => {
  const project = { stack: [], file_types: { '.py': 12, '.ino': 2 } }
  assert.deepEqual(
    extractTech(project, ['Dockerfile', 'platformio.ini', 'src']),
    ['arduino', 'docker', 'platformio', 'python']
  )
})

test('extractTech tolerates missing fields', () => {
  assert.deepEqual(extractTech({}), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/tech-tags.test.mjs`
Expected: FAIL — `Cannot find module ... tech-tags.mjs`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/tech-tags.mjs
// Canonical technology tags derived deterministically from project metadata.
// The model only supplements via tech_extra, which is normalized here too.

// npm dependency -> canonical tag. Unknown deps are ignored on purpose:
// this is how "primary tech" is picked out of raw stack noise.
const DEP_TECH = {
  next: 'nextjs',
  react: 'react',
  'react-dom': 'react',
  'react-native': 'react-native',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@angular/core': 'angular',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  koa: 'koa',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  pg: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
  redis: 'redis',
  ioredis: 'redis',
  tailwindcss: 'tailwind',
  typescript: 'typescript',
  electron: 'electron',
  tauri: 'tauri',
  '@tauri-apps/api': 'tauri',
  puppeteer: 'puppeteer',
  playwright: 'playwright',
  '@playwright/test': 'playwright',
  '@modelcontextprotocol/sdk': 'mcp',
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  ai: 'ai-sdk',
  firebase: 'firebase',
  'firebase-admin': 'firebase',
  stripe: 'stripe',
  '@supabase/supabase-js': 'supabase',
  'socket.io': 'websockets',
  ws: 'websockets',
  graphql: 'graphql',
  '@apollo/client': 'graphql',
  jest: 'jest',
  vitest: 'vitest',
  gatsby: 'gatsby',
  astro: 'astro',
  vite: 'vite',
  webpack: 'webpack',
  docker: 'docker',
}

// exact top-level file name -> tag
const FILE_TECH = {
  Dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'fly.toml': 'fly',
  'vercel.json': 'vercel',
  'netlify.toml': 'netlify',
  'platformio.ini': 'platformio',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'Pipfile': 'python',
  'composer.json': 'php',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  'tauri.conf.json': 'tauri',
  'next.config.js': 'nextjs',
  'next.config.mjs': 'nextjs',
  'next.config.ts': 'nextjs',
  'manifest.json': 'browser-extension',
}

// file extension (from file_types keys) -> tag
const EXT_TECH = {
  '.py': 'python',
  '.php': 'php',
  '.rs': 'rust',
  '.swift': 'swift',
  '.ino': 'arduino',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.go': 'go',
  '.kt': 'kotlin',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.rb': 'ruby',
}

const SYNONYMS = {
  'next.js': 'nextjs',
  next: 'nextjs',
  'node.js': 'node',
  nodejs: 'node',
  postgresql: 'postgres',
  tailwindcss: 'tailwind',
  'react.js': 'react',
  reactjs: 'react',
  'vue.js': 'vue',
  vuejs: 'vue',
  'docker-compose': 'docker',
  dockercompose: 'docker',
  'esp-32': 'esp32',
  'socket.io': 'websockets',
}

export function normalizeTech(tags) {
  const out = new Set()
  for (const raw of tags || []) {
    if (typeof raw !== 'string') continue
    let tag = raw.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag) continue
    tag = SYNONYMS[tag] || tag
    out.add(tag)
  }
  return [...out].sort()
}

export function extractTech(project, topLevelNames = []) {
  const tags = []
  for (const dep of project?.stack || []) {
    if (DEP_TECH[dep]) tags.push(DEP_TECH[dep])
  }
  for (const ext of Object.keys(project?.file_types || {})) {
    if (EXT_TECH[ext]) tags.push(EXT_TECH[ext])
  }
  for (const name of topLevelNames) {
    if (FILE_TECH[name]) tags.push(FILE_TECH[name])
  }
  return normalizeTech(tags)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/tech-tags.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tech-tags.mjs src/lib/tech-tags.test.mjs
git commit -m "feat: deterministic tech tag extraction and normalization"
```

---

### Task 2: Distillate builder (`src/lib/distill.mjs`)

**Files:**
- Create: `src/lib/distill.mjs`
- Test: `src/lib/distill.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `gatherFacts(project): Promise<{ readme: string|null, topLevel: string[], commits: string[] }>` — disk reads (README, top-level listing, `git log -10 --pretty=%s`).
- Produces: `formatDistillate(project, facts, { readmeChars = 1500, baseDir = '' }): string` — pure.
- Produces: `distillProject(project, facts, opts): { text: string, hash: string }` — `hash` is sha256 hex of `text`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/distill.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { gatherFacts, formatDistillate, distillProject } from './distill.mjs'

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

test('distillProject hash changes when facts change', () => {
  const a = distillProject(SAMPLE, { readme: null, topLevel: [], commits: [] }, {})
  const b = distillProject(SAMPLE, { readme: 'hello', topLevel: [], commits: [] }, {})
  assert.equal(a.hash.length, 64)
  assert.notEqual(a.hash, b.hash)
})

test('gatherFacts reads README, top-level names and git subjects', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-distill-'))
  try {
    await writeFile(path.join(dir, 'README.md'), '# Hello\nWorld')
    await mkdir(path.join(dir, 'node_modules'))
    await writeFile(path.join(dir, 'index.js'), '1')
    await exec('git', ['init', '-q'], { cwd: dir })
    await exec('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
    await exec('git', ['config', 'user.name', 'T'], { cwd: dir })
    await exec('git', ['add', '-A'], { cwd: dir })
    await exec('git', ['commit', '-q', '-m', 'first commit'], { cwd: dir })
    const facts = await gatherFacts({ directory: dir, git_info: { git_detected: true } })
    assert.equal(facts.readme, '# Hello\nWorld')
    assert.ok(facts.topLevel.includes('index.js'))
    assert.ok(!facts.topLevel.includes('node_modules'))
    assert.deepEqual(facts.commits, ['first commit'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gatherFacts survives a missing directory', async () => {
  const facts = await gatherFacts({ directory: '/nonexistent/nope', git_info: {} })
  assert.deepEqual(facts, { readme: null, topLevel: [], commits: [] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/distill.test.mjs`
Expected: FAIL — `Cannot find module ... distill.mjs`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/distill.mjs
// Builds the compact per-project fact sheet ("distillate") sent to the model.
// Must stay well under the 4096-token context: README excerpt is capped and
// the rest is short structured lines.
import { readFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import path from 'path'

const exec = promisify(execFile)
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'README']
const MONTH_MS = 30.44 * 24 * 3600 * 1000

export async function gatherFacts(project) {
  const dir = project.directory
  let readme = null
  for (const name of README_NAMES) {
    try { readme = await readFile(path.join(dir, name), 'utf8'); break } catch { /* try next */ }
  }
  let topLevel = []
  try {
    topLevel = (await readdir(dir)).filter(n => n !== 'node_modules' && n !== '.git').slice(0, 40)
  } catch { /* missing dir */ }
  let commits = []
  if (project.git_info?.git_detected) {
    try {
      const { stdout } = await exec('git', ['log', '-10', '--pretty=%s'], { cwd: dir, timeout: 10000 })
      commits = stdout.split('\n').filter(Boolean)
    } catch { /* no commits or git error */ }
  }
  return { readme, topLevel, commits }
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : 'unknown'
}

function monthsSince(iso, now = Date.now()) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor((now - t) / MONTH_MS) : null
}

function placementNote(directory, baseDir) {
  if (!baseDir) return ''
  const rel = path.relative(baseDir, directory)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return ''
  const [first, ...rest] = rel.split(path.sep)
  if (rest.length === 0) return ' (currently in ROOT, uncategorized)'
  if (first.startsWith('_')) return ` (currently filed under ${first})`
  return ` (currently under ${first}/)`
}

export function formatDistillate(project, facts, { readmeChars = 1500, baseDir = '' } = {}) {
  const lines = ['Project facts:']
  lines.push(`- name: ${project.project_name || path.basename(project.directory)}`)
  lines.push(`- path: ${project.directory}${placementNote(project.directory, baseDir)}`)
  const idle = monthsSince(project.git_info?.last_total_commit_date || project.last_modified)
  lines.push(`- created: ${day(project.created)}, last modified: ${day(project.last_modified)}${idle !== null ? ` (~${idle} months since last activity)` : ''}`)
  if (project.description) lines.push(`- existing description: ${project.description}`)
  const stack = (project.stack || []).slice(0, 15)
  lines.push(`- stack: ${stack.length ? stack.join(', ') : 'none detected'}${(project.stack || []).length > 15 ? ` (+${project.stack.length - 15} more)` : ''}`)
  const types = Object.entries(project.file_types || {}).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (types.length) lines.push(`- file types: ${types.map(([e, n]) => `${e}×${n}`).join(', ')}`)
  if (project.scc) {
    const langs = (project.scc.languages || []).slice(0, 5).map(l => l.name).join(', ')
    lines.push(`- code: ${project.scc.total_code ?? '?'} lines in ${project.scc.total_files ?? '?'} files (${langs})`)
  }
  lines.push(`- content size: ${Math.round((project.content_size_bytes || 0) / 1024)} kB`)
  const gi = project.git_info || {}
  if (gi.git_detected) {
    const remotes = (gi.remotes || []).join(', ')
    lines.push(`- git: ${gi.total_commits ?? '?'} commits, branch ${gi.current_branch || '?'}${remotes ? `, remote: ${remotes}` : ', no remote'}`)
  } else {
    lines.push('- git: none')
  }
  if (facts.topLevel.length) lines.push(`- top-level entries: ${facts.topLevel.join(', ')}`)
  if (facts.commits.length) lines.push(`- recent commits: ${facts.commits.join(' | ')}`)
  if (facts.readme) {
    lines.push(`README (first ${readmeChars} chars):`)
    lines.push(facts.readme.slice(0, readmeChars))
  } else {
    lines.push('- README: none')
  }
  return lines.join('\n')
}

export function distillProject(project, facts, opts = {}) {
  const text = formatDistillate(project, facts, opts)
  const hash = createHash('sha256').update(text).digest('hex')
  return { text, hash }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/distill.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/distill.mjs src/lib/distill.test.mjs
git commit -m "feat: project distillate builder with input hashing"
```

---

### Task 3: Taxonomy, schema, prompt, and deterministic derivations (`src/lib/analyzer.mjs`, part 1)

**Files:**
- Create: `src/lib/analyzer.mjs`
- Test: `src/lib/analyzer.test.mjs`

**Interfaces:**
- Consumes: nothing yet (pure logic + one `readdir`).
- Produces: `FACETS` (enum object), `CATEGORY_LEGEND` (category → meaning), `readTaxonomy(baseDir): Promise<{ categories: string[], clients: string[] }>`, `buildSchema(taxonomy): object`, `buildSystemPrompt(taxonomy): string`, `deriveStatus(project, now?): 'active'|'dormant'|'dead'|'archive-candidate'`, `suggestedPath(baseDir, category, client, name): string`, `isPlacementOk(directory, suggested): boolean`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/analyzer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  FACETS, CATEGORY_LEGEND, readTaxonomy, buildSchema, buildSystemPrompt,
  deriveStatus, suggestedPath, isPlacementOk,
} from './analyzer.mjs'

const NOW = Date.parse('2026-07-10T00:00:00Z')

test('readTaxonomy lists legend-known _dirs and _Bizz clients', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-tax-'))
  try {
    for (const d of ['_Bizz', '_Learning', '_vault-root-git-backup', 'loose-project']) {
      await mkdir(path.join(dir, d))
    }
    await mkdir(path.join(dir, '_Bizz', 'Intelimail'))
    await mkdir(path.join(dir, '_Bizz', 'TriSoft'))
    const tax = await readTaxonomy(dir)
    assert.deepEqual(tax.categories, ['_Bizz', '_Learning']) // unknown _dirs excluded
    assert.deepEqual(tax.clients, ['Intelimail', 'TriSoft'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('buildSchema injects category and client enums and facet enums', () => {
  const schema = buildSchema({ categories: ['_Bizz', '_Learning'], clients: ['TriSoft'] })
  assert.deepEqual(schema.properties.category.enum, ['_Bizz', '_Learning'])
  assert.match(schema.properties.client.description, /TriSoft/)
  assert.deepEqual(schema.properties.project_type.enum, FACETS.project_type)
  assert.deepEqual(schema.properties.domain.enum, FACETS.domain)
  assert.ok(schema.required.includes('category'))
})

test('buildSystemPrompt contains legend lines for given categories only', () => {
  const prompt = buildSystemPrompt({ categories: ['_Learning'], clients: [] })
  assert.match(prompt, /_Learning = /)
  assert.doesNotMatch(prompt, /_Bizz = /)
  assert.match(prompt, /doc_score/i)
})

test('deriveStatus: active / dormant / dead by last activity', () => {
  const p = (iso) => ({ last_modified: iso, git_info: {} })
  assert.equal(deriveStatus(p('2026-06-01T00:00:00Z'), NOW), 'active')
  assert.equal(deriveStatus(p('2025-06-01T00:00:00Z'), NOW), 'dormant')
  assert.equal(deriveStatus({ last_modified: '2022-01-01T00:00:00Z', git_info: { remotes: ['x'] }, scc: { total_code: 50 } }, NOW), 'dead')
})

test('deriveStatus: archive-candidate = dead + no remote + tiny', () => {
  const p = { last_modified: '2022-01-01T00:00:00Z', git_info: {}, scc: { total_code: 150 } }
  assert.equal(deriveStatus(p, NOW), 'archive-candidate')
})

test('deriveStatus prefers last commit date over file mtime', () => {
  const p = { last_modified: '2020-01-01T00:00:00Z', git_info: { last_total_commit_date: '2026-06-20T00:00:00Z' } }
  assert.equal(deriveStatus(p, NOW), 'active')
})

test('suggestedPath routes _Bizz through client and strips new: prefix', () => {
  assert.equal(suggestedPath('/p', '_Bizz', 'TriSoft', 'app'), '/p/_Bizz/TriSoft/app')
  assert.equal(suggestedPath('/p', '_Bizz', 'new:Acme', 'app'), '/p/_Bizz/Acme/app')
  assert.equal(suggestedPath('/p', '_Learning', '', 'codewars'), '/p/_Learning/codewars')
})

test('isPlacementOk compares parent directories', () => {
  assert.equal(isPlacementOk('/p/_Learning/codewars', '/p/_Learning/codewars'), true)
  assert.equal(isPlacementOk('/p/codewars', '/p/_Learning/codewars'), false)
  // nested deeper under the right client still counts
  assert.equal(isPlacementOk('/p/_Bizz/TriSoft/stow/dashboard', '/p/_Bizz/TriSoft/dashboard'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/analyzer.test.mjs`
Expected: FAIL — `Cannot find module ... analyzer.mjs`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/analyzer.mjs
// Orchestrates AI project analysis: taxonomy from disk, schema + prompt
// generation, apfel subprocess, and the deterministic derivations that are
// deliberately NOT asked of the model (status, paths, tech merge).
import { readdir } from 'fs/promises'
import path from 'path'

export const FACETS = {
  project_type: ['web-app', 'api-service', 'cli-tool', 'library', 'browser-extension', 'desktop-app', 'mobile-app', 'script-collection', 'infra-config', 'template-boilerplate', 'prototype-poc', 'fork', 'content-docs'],
  domain: ['e-commerce', 'communication-email', 'church-community', 'finance', 'education', 'devtools', 'iot-electronics', 'media', 'ai-ml', 'productivity', 'games', 'other'],
  maturity: ['idea', 'prototype', 'mvp', 'production', 'abandoned-wip'],
  confidence: ['high', 'medium', 'low'],
}

// Only _dirs listed here are offered to the model as categories; a new
// folder taxonomy entry needs a legend line before it becomes classifiable.
export const CATEGORY_LEGEND = {
  _Bizz: 'paid client or business work',
  _AI: 'AI/ML experiments and tools',
  _Learning: 'tutorials, courses, coding exercises, katas, practice',
  _Sandbox: 'throwaway experiments and quick tries',
  _Testing: 'trying out tools/frameworks to evaluate them',
  _Utilities: 'small personal tools/scripts in real use',
  _Personal: 'personal non-business projects',
  _DevOps: 'infrastructure and deployment configs',
  _Electronics: 'electronics and embedded hardware projects',
  _3D: '3D modeling and printing',
  _Security: 'security research and tools',
  _Archives: 'archived old work kept for reference',
}

const MONTH_MS = 30.44 * 24 * 3600 * 1000

export async function readTaxonomy(baseDir) {
  const entries = await readdir(baseDir, { withFileTypes: true })
  const categories = entries
    .filter(e => e.isDirectory() && CATEGORY_LEGEND[e.name])
    .map(e => e.name)
    .sort()
  let clients = []
  try {
    clients = (await readdir(path.join(baseDir, '_Bizz'), { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch { /* no _Bizz dir */ }
  return { categories, clients }
}

export function buildSchema(taxonomy) {
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: taxonomy.categories },
      client: {
        type: 'string',
        description: `Client name, ONLY when category is _Bizz, else empty string. Known clients: ${taxonomy.clients.join(', ')}. If the client is clearly someone new, answer "new:<Name>".`,
      },
      generated_description: { type: 'string', description: 'One short sentence describing what this project is.' },
      project_type: { type: 'string', enum: FACETS.project_type },
      domain: { type: 'string', enum: FACETS.domain },
      maturity: { type: 'string', enum: FACETS.maturity },
      tech_extra: { type: 'array', items: { type: 'string' }, description: 'Technologies visible in the facts but NOT already listed in the stack line (e.g. mentioned in README). Canonical short names. Empty array if none.' },
      reusable_assets: { type: 'array', items: { type: 'string' }, description: 'Up to 3 concrete things worth harvesting from this project (e.g. "ready-made Google OAuth flow"). Empty array if nothing stands out.' },
      doc_score: { type: 'integer', description: 'Documentation quality 0-100.' },
      doc_gaps: { type: 'array', items: { type: 'string' }, description: 'Missing documentation items.' },
      confidence: { type: 'string', enum: FACETS.confidence },
    },
    required: ['category', 'client', 'generated_description', 'project_type', 'domain', 'maturity', 'tech_extra', 'reusable_assets', 'doc_score', 'doc_gaps', 'confidence'],
  }
}

export function buildSystemPrompt(taxonomy) {
  const legend = taxonomy.categories.map(c => `${c} = ${CATEGORY_LEGEND[c]}`).join('; ')
  return [
    "You categorize software projects into the owner's folder taxonomy and classify their facets.",
    `Category meanings: ${legend}.`,
    'project_type = what kind of artifact it is. domain = what problem area it is about.',
    'maturity: idea = barely started sketch; prototype = works partially, exploratory; mvp = minimal but usable end-to-end; production = deployed/used for real; abandoned-wip = substantial work stopped before usable.',
    'doc_score: 0 = no documentation at all, 50 = README exists but a newcomer could not run the project from it, 100 = excellent README with purpose, setup and usage. doc_gaps: name the most important missing pieces.',
    'reusable_assets: only concrete, harvestable implementations, not generic praise.',
    'Answer strictly based on the given facts. Use confidence=low when guessing.',
  ].join('\n')
}

export function deriveStatus(project, now = Date.now()) {
  const candidates = [project.git_info?.last_total_commit_date, project.last_modified]
    .map(d => Date.parse(d))
    .filter(Number.isFinite)
  if (!candidates.length) return 'dead'
  const months = (now - Math.max(...candidates)) / MONTH_MS
  if (months <= 3) return 'active'
  if (months <= 18) return 'dormant'
  const noRemote = !(project.git_info?.remotes?.length)
  const tiny = (project.scc?.total_code ?? 0) < 1000
  return noRemote && tiny ? 'archive-candidate' : 'dead'
}

export function suggestedPath(baseDir, category, client, name) {
  if (category === '_Bizz' && client) {
    return path.join(baseDir, '_Bizz', client.replace(/^new:/, ''), name)
  }
  return path.join(baseDir, category, name)
}

export function isPlacementOk(directory, suggested) {
  const wantParent = path.dirname(suggested)
  return directory === suggested || directory.startsWith(wantParent + path.sep)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/analyzer.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/analyzer.mjs src/lib/analyzer.test.mjs
git commit -m "feat: analysis taxonomy, schema/prompt generation, deterministic derivations"
```

---

### Task 4: apfel subprocess wrapper + per-project analysis (`src/lib/analyzer.mjs`, part 2)

**Files:**
- Modify: `src/lib/analyzer.mjs` (append)
- Test: `src/lib/analyzer.test.mjs` (append)

**Interfaces:**
- Consumes: `distillProject`, `gatherFacts` from `src/lib/distill.mjs`; `extractTech`, `normalizeTech` from `src/lib/tech-tags.mjs`; part-1 functions above.
- Produces: `ApfelError` (class, `.kind` ∈ refused|too-large|unavailable|busy|error), `runApfel({ system, prompt, schemaFile, execImpl?, timeout? }): Promise<object>`, `countTokensOk({ system, prompt, execImpl? }): Promise<boolean>`, `analyzeProject(project, ctx): Promise<{ ai_analysis: object, derived: object }>` where `ctx = { taxonomy, baseDir, schemaFile, execImpl?, now? }`.
- Error contract: `analyzeProject` returns `{ ai_analysis: { error: <kind>, analyzed_at } }` for refused/too-large/busy/error; it **throws** `ApfelError('unavailable')` so the caller aborts the whole batch.

- [ ] **Step 1: Write the failing tests (append to analyzer.test.mjs)**

```js
import { ApfelError, runApfel, analyzeProject } from './analyzer.mjs'

// Fake promisified-execFile: routes by subcommand flag
function fakeExec({ result, countExit = 0, runExit = 0 }) {
  return async (cmd, args) => {
    assert.equal(cmd, 'apfel')
    const isCount = args.includes('--count-tokens')
    const exit = isCount ? countExit : runExit
    if (exit !== 0) {
      const err = new Error(`apfel exited ${exit}`)
      err.code = exit
      throw err
    }
    return { stdout: isCount ? 'ok' : JSON.stringify(result), stderr: '' }
  }
}

const MODEL_OUT = {
  category: '_Learning', client: '', generated_description: 'Kata solutions.',
  project_type: 'script-collection', domain: 'devtools', maturity: 'prototype',
  tech_extra: ['Chai'], reusable_assets: [], doc_score: 0, doc_gaps: ['README'],
  confidence: 'medium',
}

const TAX = { categories: ['_Bizz', '_Learning'], clients: ['TriSoft'] }

function pilotProject(dir) {
  return {
    directory: dir, project_name: 'codewars',
    created: '2022-08-12T00:00:00Z', last_modified: '2022-08-28T00:00:00Z',
    stack: ['chai'], file_types: { '.js': 7 },
    git_info: { git_detected: false }, scc: { total_code: 131, total_files: 8, languages: [] },
  }
}

test('runApfel maps exit codes to ApfelError kinds', async () => {
  for (const [exit, kind] of [[3, 'refused'], [4, 'too-large'], [5, 'unavailable'], [6, 'busy'], [1, 'error']]) {
    await assert.rejects(
      runApfel({ system: 's', prompt: 'p', schemaFile: '/tmp/x.json', execImpl: fakeExec({ runExit: exit }) }),
      (err) => err instanceof ApfelError && err.kind === kind
    )
  }
})

test('analyzeProject merges model output with deterministic fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const project = pilotProject(dir)
    const { ai_analysis, derived } = await analyzeProject(project, {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ result: MODEL_OUT }), now: Date.parse('2026-07-10T00:00:00Z'),
    })
    assert.equal(ai_analysis.category, '_Learning')
    assert.equal(ai_analysis.input_hash.length, 64)
    assert.ok(ai_analysis.analyzed_at.startsWith('2026-07-10'))
    assert.equal(derived.status, 'archive-candidate')
    assert.ok(derived.tech.includes('chai'))       // normalized from tech_extra
    assert.ok(derived.tech.includes('javascript')) // deterministic from file_types
    assert.equal(derived.placement_ok, false)
    assert.equal(derived.suggested_path, path.join(path.dirname(dir), '_Learning', 'codewars'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('analyzeProject clears client when category is not _Bizz', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const out = { ...MODEL_OUT, client: 'TriSoft' } // model hallucinated a client
    const { ai_analysis } = await analyzeProject(pilotProject(dir), {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ result: out }),
    })
    assert.equal(ai_analysis.client, '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('analyzeProject returns error record on refusal, keeps batch alive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const { ai_analysis, derived } = await analyzeProject(pilotProject(dir), {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ runExit: 3 }),
    })
    assert.equal(ai_analysis.error, 'refused')
    assert.equal(derived, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('analyzeProject throws on model unavailable (batch must abort)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    await assert.rejects(
      analyzeProject(pilotProject(dir), {
        taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
        execImpl: fakeExec({ runExit: 5 }),
      }),
      (err) => err instanceof ApfelError && err.kind === 'unavailable'
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('analyzeProject marks too-large when even the smallest distillate overflows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const { ai_analysis } = await analyzeProject(pilotProject(dir), {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ countExit: 4 }),
    })
    assert.equal(ai_analysis.error, 'too-large')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test src/lib/analyzer.test.mjs`
Expected: part-1 tests PASS, new tests FAIL — `runApfel is not a function` / not exported

- [ ] **Step 3: Append the implementation to analyzer.mjs**

```js
// --- apfel subprocess + per-project orchestration ---
import { execFile } from 'child_process'
import { promisify } from 'util'
import { gatherFacts, distillProject } from './distill.mjs'
import { extractTech, normalizeTech } from './tech-tags.mjs'

const exec = promisify(execFile)
const EXIT_KIND = { 3: 'refused', 4: 'too-large', 5: 'unavailable', 6: 'busy' }
const README_STEPS = [1500, 600, 200]

export class ApfelError extends Error {
  constructor(kind, message) {
    super(message || `apfel: ${kind}`)
    this.kind = kind
  }
}

function toApfelError(err) {
  return new ApfelError(EXIT_KIND[err.code] || 'error', err.stderr?.trim() || err.message)
}

export async function runApfel({ system, prompt, schemaFile, execImpl = exec, timeout = 60000 }) {
  try {
    const { stdout } = await execImpl(
      'apfel',
      ['--schema', schemaFile, '--temperature', '0', '-q', '--retry=3', '-s', system, '--', prompt],
      { timeout, maxBuffer: 1024 * 1024 }
    )
    return JSON.parse(stdout)
  } catch (err) {
    if (err instanceof SyntaxError) throw new ApfelError('error', `unparseable model output: ${err.message}`)
    throw toApfelError(err)
  }
}

export async function countTokensOk({ system, prompt, execImpl = exec }) {
  try {
    await execImpl('apfel', ['--count-tokens', '--strict', '-q', '-s', system, '--', prompt], { timeout: 15000 })
    return true
  } catch (err) {
    if (err.code === 4) return false
    throw toApfelError(err)
  }
}

export async function analyzeProject(project, ctx) {
  const { taxonomy, baseDir, schemaFile, execImpl = exec, now = Date.now() } = ctx
  const analyzed_at = new Date(now).toISOString()
  const facts = await gatherFacts(project)
  const system = buildSystemPrompt(taxonomy)

  let distilled = null
  for (const readmeChars of README_STEPS) {
    const candidate = distillProject(project, facts, { readmeChars, baseDir })
    if (await countTokensOk({ system, prompt: candidate.text, execImpl })) {
      distilled = candidate
      break
    }
  }
  if (!distilled) return { ai_analysis: { error: 'too-large', analyzed_at } }

  let out
  try {
    out = await runApfel({ system, prompt: distilled.text, schemaFile, execImpl })
  } catch (err) {
    if (err.kind === 'unavailable') throw err
    return { ai_analysis: { error: err.kind, analyzed_at } }
  }

  const client = out.category === '_Bizz' ? out.client : ''
  const name = project.project_name || path.basename(project.directory)
  const suggested = suggestedPath(baseDir, out.category, client, name)
  return {
    ai_analysis: {
      ...out,
      client,
      analyzed_at,
      input_hash: distilled.hash,
      model: 'apple-foundationmodel/apfel',
    },
    derived: {
      status: deriveStatus(project, now),
      tech: normalizeTech([...extractTech(project, facts.topLevel), ...(out.tech_extra || [])]),
      placement_ok: isPlacementOk(project.directory, suggested),
      suggested_path: suggested,
    },
  }
}
```

**Note:** move the two new `import` lines to the top of the file with the existing imports (ESM imports are hoisted anyway, but keep the file tidy); `path` is already imported in part 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/analyzer.test.mjs`
Expected: PASS (15 tests)

- [ ] **Step 5: Run the whole suite to check for regressions**

Run: `npm test`
Expected: all tests pass (existing suite + 27 new)

- [ ] **Step 6: Commit**

```bash
git add src/lib/analyzer.mjs src/lib/analyzer.test.mjs
git commit -m "feat: apfel subprocess wrapper and per-project analysis orchestration"
```

---

### Task 5: Pilot CLI (`scripts/analyze.mjs`) + live pilot run

**Files:**
- Create: `scripts/analyze.mjs`
- Modify: `package.json` (add `"analyze": "node scripts/analyze.mjs"` to `scripts`)
- Output: `test/fixtures/pilot-results.json` (generated, committed for grading)

**Interfaces:**
- Consumes: `readTaxonomy`, `buildSchema`, `analyzeProject`, `ApfelError` from `src/lib/analyzer.mjs`.
- Produces: `node scripts/analyze.mjs --pilot <dir> [<dir>…]` — analyzes the given project directories from the JSONL, prints a review table, writes `test/fixtures/pilot-results.json`.

- [ ] **Step 1: Write the CLI**

```js
#!/usr/bin/env node
// Pilot runner for AI project analysis (phase 0).
// Usage: node scripts/analyze.mjs --pilot <projectDir> [<projectDir>...]
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '..', '.env.local'), debug: false })

const { readTaxonomy, buildSchema, analyzeProject, ApfelError } = await import('../src/lib/analyzer.mjs')

const exec = promisify(execFile)
const DATA_FILE = path.join(__dirname, '..', 'data', 'projects_metadata.jsonl')
const RESULTS_FILE = path.join(__dirname, '..', 'test', 'fixtures', 'pilot-results.json')
const BASE_DIR = process.env.BASE_DIR || path.join(os.homedir(), 'Projekty')

const args = process.argv.slice(2)
if (args[0] !== '--pilot' || args.length < 2) {
  console.error('Usage: node scripts/analyze.mjs --pilot <projectDir> [<projectDir>...]')
  process.exit(2)
}
const targets = args.slice(1).map(p => path.resolve(p.replace(/^~/, os.homedir())))

// Preflight: is the model reachable at all?
try {
  await exec('apfel', ['--model-info'], { timeout: 15000 })
} catch (err) {
  console.error('apfel unavailable — is it installed and Apple Intelligence enabled?', err.message)
  process.exit(5)
}

const lines = (await readFile(DATA_FILE, 'utf8')).split('\n').filter(Boolean)
const byDir = new Map(lines.map(l => { const p = JSON.parse(l); return [p.directory, p] }))

const taxonomy = await readTaxonomy(BASE_DIR)
console.log(`Taxonomy: ${taxonomy.categories.length} categories, ${taxonomy.clients.length} clients`)

const schemaFile = path.join(os.tmpdir(), `stow-analysis-schema-${process.pid}.json`)
await writeFile(schemaFile, JSON.stringify(buildSchema(taxonomy)))

const results = []
for (const dir of targets) {
  const project = byDir.get(dir)
  if (!project) {
    console.warn(`SKIP (not in JSONL): ${dir}`)
    continue
  }
  const started = Date.now()
  try {
    const { ai_analysis, derived } = await analyzeProject(project, { taxonomy, baseDir: BASE_DIR, schemaFile })
    results.push({ directory: dir, ai_analysis, derived, ms: Date.now() - started })
    const a = ai_analysis
    if (a.error) {
      console.log(`✗ ${project.project_name}: ${a.error}`)
    } else {
      console.log(`✓ ${project.project_name} → ${a.category}${a.client ? `/${a.client}` : ''} | ${a.project_type} | ${a.domain} | ${a.maturity} | doc ${a.doc_score} | ${derived.status}${derived.placement_ok ? '' : ` | MOVE → ${derived.suggested_path}`} (${Date.now() - started} ms)`)
    }
  } catch (err) {
    if (err instanceof ApfelError && err.kind === 'unavailable') {
      console.error('Model became unavailable, aborting batch.')
      process.exit(5)
    }
    console.error(`✗ ${project.project_name}: ${err.message}`)
    results.push({ directory: dir, ai_analysis: { error: 'error' }, ms: Date.now() - started })
  }
}

await mkdir(path.dirname(RESULTS_FILE), { recursive: true })
await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2))
console.log(`\n${results.length} projects analyzed → ${RESULTS_FILE}`)
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, after `"scan:force"`:

```json
"analyze": "node scripts/analyze.mjs",
```

- [ ] **Step 3: Smoke-test on 2 projects**

Run: `node scripts/analyze.mjs --pilot ~/Projekty/codewars ~/Projekty/_Bizz/TriSoft/stow-dashboard`
Expected: two `✓` lines with plausible category/facets, results file written. (`codewars` should come out `_Learning`/`script-collection`; `stow-dashboard` should come out `_Bizz`/`TriSoft`/`web-app`/`devtools` with `placement_ok: true`.)

- [ ] **Step 4: Commit the CLI**

```bash
git add scripts/analyze.mjs package.json
git commit -m "feat: pilot CLI for AI project analysis (--pilot)"
```

- [ ] **Step 5: Select the 20 pilot projects and run**

Verify each candidate exists in the JSONL before using it (`grep -c '"directory":"<dir>"' data/projects_metadata.jsonl`). Suggested set — mix of client work, learning, sandbox, dead, misplaced, and the known duplicate; substitute any missing entry with a similar root-level project:

```
~/Projekty/codewars                          # expected _Learning, archive-candidate
~/Projekty/meme                              # expected _Sandbox or _Learning
~/Projekty/openai                            # expected _AI, dead
~/Projekty/php                               # expected _Learning, noisy stack test
~/Projekty/TRIVCALC                          # duplicate of _Bizz/TRIVCALC — expected _Bizz
~/Projekty/biblia                            # unknown — model judgment test
~/Projekty/camviewer                         # unknown
~/Projekty/chrome_mindmaps                   # expected browser-extension type
~/Projekty/gatsby-demo                       # expected _Learning/_Testing
~/Projekty/firebase                          # expected _Testing/_Learning
~/Projekty/directus                          # expected _Testing
~/Projekty/eid                               # unknown
~/Projekty/gitlabreports                     # expected cli-tool or web-app
~/Projekty/face-api                          # expected _AI
plus 6 correctly-filed control projects, e.g.:
~/Projekty/_Bizz/TriSoft/stow-dashboard      # control: placement_ok=true, client TriSoft
2× from _Bizz/Intelimail (pick from JSONL)   # control: client Intelimail
1× from _Learning (pick from JSONL)          # control: category _Learning
1× from _Sandbox (pick from JSONL)           # control
1× from _Utilities (pick from JSONL)         # control
```

Run: `node scripts/analyze.mjs --pilot <all 20 dirs>`
Expected: ~20 `✓` lines, total runtime ≈ 1–2 min.

- [ ] **Step 6: Commit results and present the gate table**

```bash
git add test/fixtures/pilot-results.json
git commit -m "chore: pilot analysis results for phase-0 gate review"
```

Present the results table to the user for grading. **This is the phase-0 gate (user decision, not automated):** category correct ≥ 80 %, client correct ≥ 90 % where applicable, project_type correct ≥ 80 %. After grading, save the graded expectations as `test/fixtures/pilot-expectations.json` (same shape as results plus `"expected": { category, client, project_type }` per entry) in a follow-up commit — that file is the regression golden for later prompt/schema changes.

---

## Self-Review Notes

- **Spec coverage:** distillate (Task 2), tech extraction + normalization (Task 1), taxonomy-from-disk + dynamic schema + legend prompt (Task 3), apfel wrapper with exit-code contract + README-shrinking overflow retry + deterministic merges (Task 4), pilot CLI + gate (Task 5). Phase-1 items (JSONL writing, `/api/analyze`, incremental skip via `input_hash`) are intentionally out of scope — `input_hash` is already produced and stored in results so phase 1 can build on it.
- **Type consistency:** `analyzeProject` returns `{ ai_analysis, derived }`; error shape `{ ai_analysis: { error, analyzed_at } }` (no `derived`); `ApfelError.kind` values match the exit-code table everywhere.
- **No placeholders:** all code complete; the only deferred artifact (`pilot-expectations.json`) is deliberately post-gate because it requires the user's grading.
