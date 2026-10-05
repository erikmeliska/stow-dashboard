import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'registry-export.mjs')

test('--client prints the filtered export and leaves data/agent-office.json alone', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stow-ao-cli-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = path.join(base, '_Bizz', 'Acme', 'app')
  await mkdir(dir, { recursive: true })
  await mkdir(path.join(base, 'data'))
  await writeFile(path.join(base, 'data', 'projects_metadata.jsonl'), JSON.stringify({ directory: dir, project_name: 'app' }) + '\n')
  await writeFile(path.join(base, 'data', 'agent-office.json'), 'full')

  const { stdout } = await run(process.execPath, [CLI, '--client', 'acme'], { env: { ...process.env, STOW_STATE_DIR: base } })
  const doc = JSON.parse(stdout)
  assert.deepEqual(doc.filter, { client: 'acme', unassigned: false })
  assert.deepEqual(doc.buildings.map(b => b.floors[0].dir), [dir])
  assert.equal(await readFile(path.join(base, 'data', 'agent-office.json'), 'utf8'), 'full')
})
