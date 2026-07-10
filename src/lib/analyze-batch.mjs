// src/lib/analyze-batch.mjs
// Incremental AI-analysis batch over the projects JSONL. Sequential (one
// local model), crash-safe (atomic per-project writes), and race-aware:
// every write re-reads the file and merges only the AI keys, so a scan
// rewriting the JSONL mid-batch never loses its changes — and vice versa.
import { readFile, writeFile, rename } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  readTaxonomy, buildSchema, analyzeProject, needsAnalysis, ApfelError,
} from './analyzer.mjs'
import { gatherFacts, distillProject } from './distill.mjs'

const status = {
  running: false,
  startedAt: null,
  current: 0,
  total: 0,
  analyzed: 0,
  skipped: 0,
  errors: 0,
  lastProject: null,
  finishedAt: null,
  lastError: null,
}

export function isAnalysisRunning() {
  return status.running
}

export function getAnalysisStatus() {
  return { ...status }
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function writeJsonlAtomic(file, records) {
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  await rename(tmp, file)
}

// Re-read the current file and merge this record's AI keys into it.
async function persistAnalysis(dataFile, directory, aiAnalysis, aiDerived) {
  const records = await readJsonl(dataFile)
  const rec = records.find(r => r.directory === directory)
  if (!rec) return // project removed by a concurrent full scan — drop the result
  rec.ai_analysis = aiAnalysis
  if (aiDerived) rec.ai_derived = aiDerived
  else delete rec.ai_derived
  await writeJsonlAtomic(dataFile, records)
}

export async function runAnalysisBatch({ dataFile, baseDir, force = false, only = null, onProgress = () => {}, execImpl }) {
  if (status.running) throw new Error('analysis already running')
  status.running = true
  status.startedAt = new Date().toISOString()
  status.current = 0
  status.total = 0
  status.analyzed = 0
  status.skipped = 0
  status.errors = 0
  status.lastProject = null
  status.finishedAt = null
  status.lastError = null
  const started = Date.now()
  try {
    const taxonomy = await readTaxonomy(baseDir)
    const schemaFile = path.join(os.tmpdir(), `stow-analysis-schema-${process.pid}.json`)
    await writeFile(schemaFile, JSON.stringify(buildSchema(taxonomy)))

    let records = await readJsonl(dataFile)
    if (only) {
      const set = new Set(only)
      records = records.filter(r => set.has(r.directory))
    }
    const total = records.length
    status.total = total
    onProgress({ type: 'status', message: `Analyzing ${total} project(s)`, total })

    let analyzed = 0, skipped = 0, errors = 0, current = 0
    for (const record of records) {
      current++
      status.current = current
      status.lastProject = record.project_name
      const base = { directory: record.directory, project_name: record.project_name, current, total }
      try {
        const facts = await gatherFacts(record)
        const { hash } = distillProject(record, facts, { baseDir })
        if (!force && !needsAnalysis(record, hash)) {
          skipped++
          status.skipped = skipped
          onProgress({ type: 'skipped', ...base })
          continue
        }
        const { ai_analysis, derived } = await analyzeProject(record, { taxonomy, baseDir, schemaFile, execImpl })
        await persistAnalysis(dataFile, record.directory, ai_analysis, derived)
        if (ai_analysis.error) {
          errors++
          status.errors = errors
          onProgress({ type: 'analyze_error', ...base, detail: ai_analysis.error })
        } else {
          analyzed++
          status.analyzed = analyzed
          onProgress({ type: 'analyzed', ...base, detail: ai_analysis.category })
        }
      } catch (err) {
        if (err instanceof ApfelError && err.kind === 'unavailable') {
          status.lastError = err.message
          throw err
        }
        errors++
        status.errors = errors
        onProgress({ type: 'analyze_error', ...base, detail: err.message })
      }
    }
    return { analyzed, skipped, errors, total, durationMs: Date.now() - started }
  } finally {
    status.running = false
    status.finishedAt = new Date().toISOString()
  }
}
