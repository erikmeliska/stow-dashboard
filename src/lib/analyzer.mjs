// src/lib/analyzer.mjs
// Orchestrates AI project analysis: taxonomy from disk, schema + prompt
// generation, apfel subprocess, and the deterministic derivations that are
// deliberately NOT asked of the model (status, paths, tech merge).
import { readdir, readFile } from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { gatherFacts, distillProject } from './distill.mjs'
import { extractTech, normalizeTech } from './tech-tags.mjs'
import { ollamaAvailable, runOllama, getOllamaConfig } from './ollama.mjs'

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

// Bump when the distillate shape, prompt, or schema change enough that cached
// analyses (keyed by input_hash) should be recomputed regardless of hash match.
export const ANALYSIS_VERSION = 2

// Incremental-skip rule for the batch: re-analyze only when a project has no
// prior analysis, its distillate hash changed, or the analyzer version moved.
// Error records carry input_hash + version too, so a failure is cached like a
// result until its inputs (or the version) change.
export function needsAnalysis(record, currentHash) {
  const a = record?.ai_analysis
  if (!a) return true
  return a.input_hash !== currentHash || a.version !== ANALYSIS_VERSION
}

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
        description: `Exact client name, ONLY when category is _Bizz, else empty string. Known clients: ${taxonomy.clients.join(', ')}. If the client is a real company not in the list, answer with "new:" followed by the actual company name (e.g. "new:Acme"). Never answer a placeholder.`,
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
    '_Bizz is ONLY for paid client or own-business work where the facts let you name the client. If you cannot confidently name a client from the facts, the project is NOT _Bizz — choose the category matching its purpose instead.',
    'If the facts indicate a clone/fork of third-party code (no own commits, or the remote clearly belongs to someone else), set project_type = "fork" and pick the category by WHY it was cloned (_Testing for evaluation, _AI for AI experiments, etc.) — never _Bizz for someone else\'s open-source project.',
    'Answer strictly based on the given facts. Use confidence=low when guessing.',
  ].join('\n')
}

// Guards against the model echoing the schema's placeholder (`<Name>`,
// `new:<Name>`) or returning whitespace. Keeps a `new:` prefix only when a real
// company name follows it. knownClients is accepted for symmetry with the schema
// but membership is not required — an unknown real name is still a valid client.
export function sanitizeClient(client, knownClients = []) { // eslint-disable-line no-unused-vars
  if (!client || typeof client !== 'string') return ''
  const trimmed = client.trim()
  if (!trimmed || trimmed.includes('<') || trimmed.includes('>')) return ''
  if (trimmed.startsWith('new:')) {
    const name = trimmed.slice(4).trim()
    return name ? `new:${name}` : ''
  }
  return trimmed
}

export function deriveStatus(project, { now = Date.now(), lastCodeCommit = null, lastCodeModified = null } = {}) {
  // Code activity (meta-doc edits excluded) wins. Precedence: git code commit →
  // filesystem code mtime (last_code_modified) → overall activity fallback.
  // Doc-only repos and non-git projects fall through — by design, see spec.
  let last
  if (lastCodeCommit && Number.isFinite(Date.parse(lastCodeCommit))) {
    last = Date.parse(lastCodeCommit)
  } else if (lastCodeModified && Number.isFinite(Date.parse(lastCodeModified))) {
    last = Date.parse(lastCodeModified)
  } else {
    const candidates = [project.git_info?.last_total_commit_date, project.last_modified]
      .map(d => Date.parse(d))
      .filter(Number.isFinite)
    if (!candidates.length) return 'dead'
    last = Math.max(...candidates)
  }
  const months = (now - last) / MONTH_MS
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

// --- apfel subprocess + per-project orchestration ---

// apfel reads stdin and waits for EOF even when the prompt is passed via argv.
// Node's promisified execFile leaves the child's stdin pipe open, so apfel blocks
// until the timeout kills it (SIGTERM). This wrapper mirrors promisified execFile's
// contract (resolves { stdout, stderr }; rejects with err.code = exit code, honors
// opts.timeout / opts.maxBuffer) but ends the child's stdin immediately so apfel
// sees EOF and runs. It is the library's DEFAULT exec — the injectable execImpl
// seam still overrides it for tests.
export function execClosedStdin(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err) }
      else resolve({ stdout, stderr })
    })
    child.stdin?.end()
  })
}

const exec = execClosedStdin
const EXIT_KIND = { 3: 'refused', 4: 'too-large', 5: 'unavailable', 6: 'busy' }
// Progressive shrink for over-4096-token distillates: cap the README first, then
// the other big contributors (top-level listing, commit subjects, stack).
const SHRINK_STEPS = [
  { readmeChars: 1500 },
  { readmeChars: 600, topLevelMax: 20, commitsMax: 5 },
  { readmeChars: 200, topLevelMax: 10, commitsMax: 3, stackMax: 8 },
]

export class ApfelError extends Error {
  constructor(kind, message, detail = null) {
    super(message || `apfel: ${kind}`)
    this.kind = kind
    this.detail = detail
  }
}

function toApfelError(err) {
  const stderr = err.stderr || ''
  // Apple's model rejects non-supported-language input (e.g. Slovak) with this
  // stderr on exit 1 — classify by message, not exit code, so it routes to the
  // lang-safe retry / Ollama fallback instead of a generic 'error'.
  const kind = /unsupported language/i.test(stderr) ? 'unsupported-language' : (EXIT_KIND[err.code] || 'error')
  const detail = stderr.split('\n')[0].trim() || null
  return new ApfelError(kind, err.stderr?.trim() || err.message, detail)
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

// Local-Ollama fallback for apfel failures another model might still handle
// (unsupported-language, too-large, generic error). Feeds the FULL-SIZE
// distillate — Ollama has a larger context and no language guardrail. Returns
// { out, modelId } on success, or { errorDetail } describing why the fallback
// itself failed (model unavailable, or a request crash). Never throws.
async function ollamaFallback({ system, prompt, schema, schemaFile, fetchImpl }) {
  if (!(await ollamaAvailable({ fetchImpl }))) return { errorDetail: 'model unavailable' }
  try {
    const schemaObj = schema || JSON.parse(await readFile(schemaFile, 'utf8'))
    const out = await runOllama({ system, prompt, schema: schemaObj, fetchImpl })
    return { out, modelId: `ollama/${getOllamaConfig().model}` }
  } catch (oerr) {
    return { errorDetail: oerr.message }
  }
}

export async function analyzeProject(project, ctx) {
  const { taxonomy, baseDir, schemaFile, execImpl = exec, now = Date.now(), schema, fetchImpl } = ctx
  const analyzed_at = new Date(now).toISOString()
  const facts = await gatherFacts(project)
  const system = buildSystemPrompt(taxonomy)

  // The cache key is ALWAYS the full-size distillate hash — deterministic from
  // the project's inputs regardless of which shrink step ends up fitting, so the
  // batch's needsAnalysis (which recomputes the full-size hash) matches both
  // success and error records. SHRINK_STEPS[0] equals distillProject's defaults.
  const fullSize = distillProject(project, facts, { ...SHRINK_STEPS[0], baseDir })
  const input_hash = fullSize.hash
  const errorRecord = (error, detail = null) => ({
    ai_analysis: { error, ...(detail ? { error_detail: detail } : {}), analyzed_at, input_hash, version: ANALYSIS_VERSION },
  })

  // Single fallback seam shared by the language / too-large / generic-error
  // paths. busy (queue signal) and refused (content guardrail) are terminal —
  // retrying them on another model is wrong — so they short-circuit to their
  // original error record. Everything else feeds the FULL-SIZE distillate to
  // Ollama. On fallback failure the ORIGINAL error record is returned with
  // error_detail extended by '; ollama fallback failed: <msg>'.
  const fallbackOrError = async (err) => {
    if (err.kind === 'busy' || err.kind === 'refused') return { record: errorRecord(err.kind, err.detail) }
    const fb = await ollamaFallback({ system, prompt: fullSize.text, schema, schemaFile, fetchImpl })
    if (fb.out) return { out: fb.out, modelId: fb.modelId }
    const detail = err.detail ? `${err.detail}; ollama fallback failed: ${fb.errorDetail}` : `ollama fallback failed: ${fb.errorDetail}`
    return { record: errorRecord(err.kind, detail) }
  }

  let distilled = null
  try {
    for (const step of SHRINK_STEPS) {
      const candidate = distillProject(project, facts, { ...step, baseDir })
      if (await countTokensOk({ system, prompt: candidate.text, execImpl })) {
        distilled = candidate
        break
      }
    }
  } catch (err) {
    // countTokensOk re-throws non-exit-4 ApfelErrors (busy/refused/error/timeout).
    // Same contract as runApfel below: only 'unavailable' aborts the batch.
    if (err.kind === 'unavailable') throw err
    return errorRecord(err.kind, err.detail)
  }

  let out = null
  let lang_safe = false
  let modelId = 'apple-foundationmodel/apfel'

  // Preflight exhausted every shrink step: the distillate is too large for
  // apfel even at its smallest. Try Ollama with the full-size text (no shrink
  // accepted here) before giving up with a too-large error record.
  if (!distilled) {
    const fb = await fallbackOrError(new ApfelError('too-large'))
    if (fb.record) return fb.record
    out = fb.out
    modelId = fb.modelId
  }

  if (!out) {
    try {
      out = await runApfel({ system, prompt: distilled.text, schemaFile, execImpl })
    } catch (err) {
      if (err.kind === 'unavailable') throw err
      if (err.kind === 'unsupported-language') {
        // Apple's model rejected the input language. Retry once with a language-safe
        // distillate: no README/commits and the path leaf masked (the name still
        // appears once). input_hash stays the full-size hash so the cache key matches.
        const safe = distillProject(project, { ...facts, readme: null, commits: [] }, { ...SHRINK_STEPS[0], baseDir, maskPathLeaf: true })
        try {
          out = await runApfel({ system, prompt: safe.text, schemaFile, execImpl })
          lang_safe = true
        } catch (err2) {
          if (err2.kind === 'unavailable') throw err2
          // Both apfel attempts failed. Fall back to Ollama (unsupported-language
          // or a too-large/generic error on the retry); lang_safe is NOT set for
          // the Ollama path.
          const fb = await fallbackOrError(err2)
          if (fb.record) return fb.record
          out = fb.out
          modelId = fb.modelId
        }
      } else {
        // too-large / generic error straight from the first apfel run (busy and
        // refused short-circuit inside fallbackOrError to their error record).
        const fb = await fallbackOrError(err)
        if (fb.record) return fb.record
        out = fb.out
        modelId = fb.modelId
      }
    }
  }

  const client = out.category === '_Bizz' ? sanitizeClient(out.client, taxonomy.clients) : ''
  // Leaf must be the real directory name (the mv target); project_name is often
  // a description-like string from the scanner, unsafe as a path component.
  const name = path.basename(project.directory)
  const suggested = suggestedPath(baseDir, out.category, client, name)
  return {
    ai_analysis: {
      ...out,
      client,
      analyzed_at,
      input_hash,
      version: ANALYSIS_VERSION,
      model: modelId,
      ...(lang_safe ? { lang_safe: true } : {}),
    },
    derived: {
      status: deriveStatus(project, { now, lastCodeCommit: facts.lastCodeCommit, lastCodeModified: project.last_code_modified }),
      tech: normalizeTech([...extractTech(project, facts.topLevel), ...(out.tech_extra || [])]),
      placement_ok: isPlacementOk(project.directory, suggested),
      suggested_path: suggested,
    },
  }
}
