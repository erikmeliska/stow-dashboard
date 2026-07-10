// src/lib/analyze-batch.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runAnalysisBatch, isAnalysisRunning, getAnalysisStatus } from './analyze-batch.mjs'
import { ANALYSIS_VERSION } from './analyzer.mjs'

const MODEL_OUT = {
  category: '_Learning', client: '', generated_description: 'x',
  project_type: 'script-collection', domain: 'devtools', maturity: 'prototype',
  tech_extra: [], reusable_assets: [], doc_score: 0, doc_gaps: [], confidence: 'low',
}

function okExec() {
  return async (cmd, args) => {
    if (args.includes('--count-tokens')) return { stdout: 'ok', stderr: '' }
    return { stdout: JSON.stringify(MODEL_OUT), stderr: '' }
  }
}

async function makeWorld() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-batch-'))
  await mkdir(path.join(base, '_Bizz'), { recursive: true })
  await mkdir(path.join(base, '_Learning'))
  const projDir = path.join(base, 'proj1')
  await mkdir(projDir)
  await writeFile(path.join(projDir, 'index.js'), '1')
  const record = {
    id: 'r1', directory: projDir, project_name: 'proj1',
    created: '2020-01-01T00:00:00Z', last_modified: '2020-02-01T00:00:00Z',
    stack: [], file_types: { '.js': 1 }, git_info: { git_detected: false },
  }
  const dataFile = path.join(base, 'projects.jsonl')
  await writeFile(dataFile, JSON.stringify(record) + '\n')
  return { base, projDir, dataFile }
}

test('runAnalysisBatch analyzes, writes ai_analysis + ai_derived atomically, then skips on rerun', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    const events = []
    const r1 = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), onProgress: e => events.push(e) })
    assert.equal(r1.analyzed, 1)
    const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
    assert.equal(rec.ai_analysis.category, '_Learning')
    assert.equal(rec.ai_analysis.version, ANALYSIS_VERSION)
    assert.ok(rec.ai_derived.status)
    assert.equal(rec.project_name, 'proj1') // other fields untouched
    assert.ok(events.some(e => e.type === 'analyzed'))
    const r2 = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    assert.equal(r2.analyzed, 0)
    assert.equal(r2.skipped, 1)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch force re-analyzes and only-filter restricts', async () => {
  const { base, dataFile, projDir } = await makeWorld()
  try {
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    const r = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), force: true, only: [projDir] })
    assert.equal(r.analyzed, 1)
    const none = await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec(), force: true, only: ['/nope'] })
    assert.equal(none.total, 0)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch merges into a file changed mid-batch instead of clobbering it', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    // execImpl side effect: while "the model runs", a scan rewrites the file with a new field
    const sneaky = async (cmd, args) => {
      if (!args.includes('--count-tokens')) {
        const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
        rec.description = 'updated by concurrent scan'
        await writeFile(dataFile, JSON.stringify(rec) + '\n')
        return { stdout: JSON.stringify(MODEL_OUT), stderr: '' }
      }
      return { stdout: 'ok', stderr: '' }
    }
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: sneaky })
    const rec = JSON.parse((await readFile(dataFile, 'utf8')).trim())
    assert.equal(rec.description, 'updated by concurrent scan') // scan's write survived
    assert.equal(rec.ai_analysis.category, '_Learning')          // and analysis landed
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('runAnalysisBatch refuses concurrent entry', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    let release
    const gate = new Promise(res => { release = res })
    const slowExec = async (cmd, args) => {
      if (!args.includes('--count-tokens')) await gate
      return { stdout: args.includes('--count-tokens') ? 'ok' : JSON.stringify(MODEL_OUT), stderr: '' }
    }
    const first = runAnalysisBatch({ dataFile, baseDir: base, execImpl: slowExec, force: true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(isAnalysisRunning(), true)
    await assert.rejects(runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() }), /already running/)
    release()
    await first
    assert.equal(isAnalysisRunning(), false)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('getAnalysisStatus tracks a batch lifecycle', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    const before = getAnalysisStatus()
    assert.equal(before.running, false)
    await runAnalysisBatch({ dataFile, baseDir: base, execImpl: okExec() })
    const after = getAnalysisStatus()
    assert.equal(after.running, false)
    assert.equal(after.total, 1)
    assert.equal(after.analyzed, 1)
    assert.ok(after.startedAt)
    assert.ok(after.finishedAt)
    assert.equal(after.lastProject, 'proj1')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('getAnalysisStatus records a friendly lastError when the model is unavailable', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    const downExec = async () => {
      const err = new Error('exit 5')
      err.code = 5
      err.stderr = 'model assets not available'
      throw err
    }
    await assert.rejects(
      runAnalysisBatch({ dataFile, baseDir: base, execImpl: downExec, force: true }),
      err => err.kind === 'unavailable'
    )
    const s = getAnalysisStatus()
    assert.equal(s.running, false)
    assert.ok(s.finishedAt)
    assert.equal(s.lastError, 'Apple model unavailable — is apfel installed and Apple Intelligence enabled?')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('getAnalysisStatus reports running=true mid-batch', async () => {
  const { base, dataFile } = await makeWorld()
  try {
    let release
    const gate = new Promise(res => { release = res })
    const slowExec = async (cmd, args) => {
      if (!args.includes('--count-tokens')) await gate
      return { stdout: args.includes('--count-tokens') ? 'ok' : JSON.stringify(MODEL_OUT), stderr: '' }
    }
    const run = runAnalysisBatch({ dataFile, baseDir: base, execImpl: slowExec, force: true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(getAnalysisStatus().running, true)
    release()
    await run
    assert.equal(getAnalysisStatus().running, false)
  } finally { await rm(base, { recursive: true, force: true }) }
})
