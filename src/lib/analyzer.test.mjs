// src/lib/analyzer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  FACETS, CATEGORY_LEGEND, readTaxonomy, buildSchema, buildSystemPrompt,
  deriveStatus, suggestedPath, isPlacementOk, sanitizeClient,
  ApfelError, runApfel, analyzeProject, execClosedStdin,
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

test('buildSchema client description forbids placeholders and explains new: prefix', () => {
  const schema = buildSchema({ categories: ['_Bizz'], clients: ['TriSoft'] })
  assert.match(schema.properties.client.description, /Never answer a placeholder/)
  assert.match(schema.properties.client.description, /new:/)
})

test('buildSystemPrompt carries the _Bizz over-pull guard rule', () => {
  const prompt = buildSystemPrompt({ categories: ['_Bizz', '_Learning'], clients: [] })
  assert.match(prompt, /NOT _Bizz/)
})

test('buildSystemPrompt carries the fork/clone rule', () => {
  const prompt = buildSystemPrompt({ categories: ['_Bizz', '_Testing'], clients: [] })
  assert.match(prompt, /fork/)
})

test('sanitizeClient blanks falsy, placeholder and angle-bracket inputs', () => {
  assert.equal(sanitizeClient('', ['TriSoft']), '')
  assert.equal(sanitizeClient(null, ['TriSoft']), '')
  assert.equal(sanitizeClient('   ', ['TriSoft']), '')
  assert.equal(sanitizeClient('<Name>', ['TriSoft']), '')
  assert.equal(sanitizeClient('new:<Name>', ['TriSoft']), '')
})

test('sanitizeClient keeps real names and new: prefix with a real name', () => {
  assert.equal(sanitizeClient('new:Acme', ['TriSoft']), 'new:Acme')
  assert.equal(sanitizeClient('TriSoft', ['TriSoft']), 'TriSoft')
  assert.equal(sanitizeClient('  TriSoft  ', ['TriSoft']), 'TriSoft')
  assert.equal(sanitizeClient('new:', ['TriSoft']), '')
})

test('deriveStatus: active / dormant / dead by last activity', () => {
  const p = (iso) => ({ last_modified: iso, git_info: {} })
  assert.equal(deriveStatus(p('2026-06-01T00:00:00Z'), { now: NOW }), 'active')
  assert.equal(deriveStatus(p('2025-06-01T00:00:00Z'), { now: NOW }), 'dormant')
  assert.equal(deriveStatus({ last_modified: '2022-01-01T00:00:00Z', git_info: { remotes: ['x'] }, scc: { total_code: 50 } }, { now: NOW }), 'dead')
})

test('deriveStatus: archive-candidate = dead + no remote + tiny', () => {
  const p = { last_modified: '2022-01-01T00:00:00Z', git_info: {}, scc: { total_code: 150 } }
  assert.equal(deriveStatus(p, { now: NOW }), 'archive-candidate')
})

test('deriveStatus prefers last commit date over file mtime', () => {
  const p = { last_modified: '2020-01-01T00:00:00Z', git_info: { last_total_commit_date: '2026-06-20T00:00:00Z' } }
  assert.equal(deriveStatus(p, { now: NOW }), 'active')
})

test('deriveStatus: code activity wins over doc-freshened dates', () => {
  // README edited last week, but last real code change was 2022 → not active
  const p = { last_modified: '2026-07-01T00:00:00Z', git_info: { last_total_commit_date: '2026-07-01T00:00:00Z', remotes: ['x'] }, scc: { total_code: 5000 } }
  assert.equal(deriveStatus(p, { now: NOW, lastCodeCommit: '2022-01-01T00:00:00Z' }), 'dead')
})

test('deriveStatus falls back to overall activity when lastCodeCommit is null', () => {
  const p = { last_modified: '2026-07-01T00:00:00Z', git_info: {} }
  assert.equal(deriveStatus(p, { now: NOW, lastCodeCommit: null }), 'active')
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

// --- execClosedStdin (library default exec) ---

test('execClosedStdin closes child stdin so a stdin-waiting child reaches EOF', async () => {
  // This child resumes stdin and only prints/exits once stdin ends. If stdin were
  // left open (the old promisified-execFile bug), it would hang until the timeout
  // and this call would reject instead of resolving — mirrors apfel's behavior.
  const { stdout } = await execClosedStdin(
    process.execPath,
    ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { console.log("eof"); process.exit(0) })'],
    { timeout: 5000 }
  )
  assert.match(stdout, /eof/)
})

test('execClosedStdin rejects with err.code set to the child exit code', async () => {
  await assert.rejects(
    execClosedStdin(process.execPath, ['-e', 'process.exit(4)'], { timeout: 5000 }),
    (err) => err.code === 4
  )
})

// --- apfel subprocess + per-project orchestration ---

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
    assert.equal(derived.suggested_path, path.join(path.dirname(dir), '_Learning', path.basename(dir)))
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

test('analyzeProject sanitizes a placeholder client under _Bizz to empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const out = { ...MODEL_OUT, category: '_Bizz', client: 'new:<Name>' }
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

test('analyzeProject returns error record when preflight fails with non-unavailable ApfelError', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    const { ai_analysis, derived } = await analyzeProject(pilotProject(dir), {
      taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
      execImpl: fakeExec({ countExit: 6 }), // busy during token-count preflight
    })
    assert.equal(ai_analysis.error, 'busy')
    assert.equal(derived, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('analyzeProject throws when preflight fails with unavailable (batch must abort)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stow-an-'))
  try {
    await assert.rejects(
      analyzeProject(pilotProject(dir), {
        taxonomy: TAX, baseDir: path.dirname(dir), schemaFile: '/tmp/x.json',
        execImpl: fakeExec({ countExit: 5 }),
      }),
      (err) => err instanceof ApfelError && err.kind === 'unavailable'
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})
