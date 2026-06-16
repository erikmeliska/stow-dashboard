import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, lstat, readFile, readlink } from 'fs/promises'
import os from 'os'
import path from 'path'
import { syncSkills, ejectSkill, readManifest } from './skills.mjs'

async function setupSource() {
  const src = await mkdtemp(path.join(os.tmpdir(), 'stow-src-'))
  for (const name of ['alpha', 'beta']) {
    await mkdir(path.join(src, name), { recursive: true })
    await writeFile(path.join(src, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody`)
  }
  return src
}

test('syncSkills symlink mode creates symlinks for shared skills', async () => {
  const src = await setupSource()
  const proj = await mkdtemp(path.join(os.tmpdir(), 'stow-proj-'))
  try {
    await writeFile(path.join(proj, 'skills.manifest.json'), JSON.stringify({ mode: 'symlink', shared: [{ name: 'alpha', source: src }], custom: [] }))
    const summary = await syncSkills(proj)
    const link = path.join(proj, '.claude', 'skills', 'alpha')
    assert.ok((await lstat(link)).isSymbolicLink())
    assert.equal(await readlink(link), path.join(src, 'alpha'))
    assert.deepEqual(summary.linked, ['alpha'])
  } finally { await rm(src, {recursive:true,force:true}); await rm(proj, {recursive:true,force:true}) }
})

test('syncSkills vendored mode copies real files', async () => {
  const src = await setupSource()
  const proj = await mkdtemp(path.join(os.tmpdir(), 'stow-proj-'))
  try {
    await writeFile(path.join(proj, 'skills.manifest.json'), JSON.stringify({ mode: 'vendored', shared: [{ name: 'beta', source: src }], custom: [] }))
    const summary = await syncSkills(proj)
    const dest = path.join(proj, '.claude', 'skills', 'beta')
    assert.ok((await lstat(dest)).isDirectory())
    assert.match(await readFile(path.join(dest, 'SKILL.md'), 'utf-8'), /name: beta/)
    assert.deepEqual(summary.copied, ['beta'])
  } finally { await rm(src, {recursive:true,force:true}); await rm(proj, {recursive:true,force:true}) }
})

test('syncSkills is idempotent', async () => {
  const src = await setupSource()
  const proj = await mkdtemp(path.join(os.tmpdir(), 'stow-proj-'))
  try {
    await writeFile(path.join(proj, 'skills.manifest.json'), JSON.stringify({ mode: 'symlink', shared: [{ name: 'alpha', source: src }], custom: [] }))
    await syncSkills(proj)
    await syncSkills(proj)
    assert.ok((await lstat(path.join(proj, '.claude', 'skills', 'alpha'))).isSymbolicLink())
  } finally { await rm(src, {recursive:true,force:true}); await rm(proj, {recursive:true,force:true}) }
})

test('ejectSkill converts symlink to real copy and moves shared->custom', async () => {
  const src = await setupSource()
  const proj = await mkdtemp(path.join(os.tmpdir(), 'stow-proj-'))
  try {
    await writeFile(path.join(proj, 'skills.manifest.json'), JSON.stringify({ mode: 'symlink', shared: [{ name: 'alpha', source: src }], custom: [] }))
    await syncSkills(proj)
    await ejectSkill(proj, 'alpha')
    assert.ok((await lstat(path.join(proj, '.claude', 'skills', 'alpha'))).isDirectory())
    const m = await readManifest(proj)
    assert.equal(m.shared.length, 0)
    assert.deepEqual(m.custom, ['alpha'])
  } finally { await rm(src, {recursive:true,force:true}); await rm(proj, {recursive:true,force:true}) }
})

test('syncSkills never touches custom[] dirs', async () => {
  const src = await setupSource()
  const proj = await mkdtemp(path.join(os.tmpdir(), 'stow-proj-'))
  try {
    const customDir = path.join(proj, '.claude', 'skills', 'mycustom')
    await mkdir(customDir, { recursive: true })
    await writeFile(path.join(customDir, 'SKILL.md'), 'custom')
    await writeFile(path.join(proj, 'skills.manifest.json'), JSON.stringify({ mode: 'symlink', shared: [{ name: 'alpha', source: src }], custom: ['mycustom'] }))
    await syncSkills(proj)
    assert.equal(await readFile(path.join(customDir, 'SKILL.md'), 'utf-8'), 'custom')
  } finally { await rm(src, {recursive:true,force:true}); await rm(proj, {recursive:true,force:true}) }
})
