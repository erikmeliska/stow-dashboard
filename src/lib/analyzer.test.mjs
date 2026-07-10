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
