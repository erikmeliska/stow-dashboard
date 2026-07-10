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

// apfel reads stdin and waits for EOF even when the prompt is passed via argv.
// Node's execFile leaves the child's stdin pipe open, so apfel blocks until the
// timeout kills it (SIGTERM). This wrapper mirrors execFile's contract but ends
// the child's stdin immediately so apfel sees EOF and runs. Passed to the
// analyzer via its execImpl seam. (The library's default exec has this latent
// bug — see task-5 report; phase 1's /api/analyze must apply the same fix.)
function execClosedStdin(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err) }
      else resolve({ stdout, stderr })
    })
    child.stdin?.end()
  })
}

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
    const { ai_analysis, derived } = await analyzeProject(project, { taxonomy, baseDir: BASE_DIR, schemaFile, execImpl: execClosedStdin })
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
