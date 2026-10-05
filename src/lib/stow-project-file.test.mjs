import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureStowFile } from './stow-project-file.mjs'

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'stow-file-')) }
const noGit = async () => { throw new Error('git must not run for a non-git root') }
const file = dir => path.join(dir, '.stow', 'project.json')

test('creates .stow/project.json with a fresh id when missing', async () => {
    const dir = await tmp()
    const r = await ensureStowFile(dir, { git: false, enabled: true, exec: noGit })
    assert.match(r.id, /^p_[a-z2-7]{12}$/)
    assert.equal(r.created, true)
    assert.equal(r.error, null)
    assert.deepEqual(JSON.parse(await fs.readFile(file(dir), 'utf8')), { version: 1, id: r.id })
    await fs.rm(dir, { recursive: true })
})

test('reads an existing id and never rewrites the file', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    const body = '{ "id": "p_keep", "client": "Intelimail", "role": "deploy" }\n'
    await fs.writeFile(file(dir), body)
    const r = await ensureStowFile(dir, { git: false, enabled: true, exec: noGit })
    assert.deepEqual(r, { id: 'p_keep', created: false, error: null })
    assert.equal(await fs.readFile(file(dir), 'utf8'), body)
    await fs.rm(dir, { recursive: true })
})

test('malformed file → no id, error, file untouched', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(file(dir), '{ not json')
    const r = await ensureStowFile(dir, { git: false, enabled: true, exec: noGit })
    assert.equal(r.id, null)
    assert.equal(r.created, false)
    assert.match(r.error, /malformed/)
    assert.equal(await fs.readFile(file(dir), 'utf8'), '{ not json')
    await fs.rm(dir, { recursive: true })
})

test('file without a valid id is malformed too and left alone', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(file(dir), '{ "client": "Acme" }')
    const r = await ensureStowFile(dir, { git: false, enabled: true, exec: noGit })
    assert.equal(r.id, null)
    assert.ok(r.error)
    assert.equal(await fs.readFile(file(dir), 'utf8'), '{ "client": "Acme" }')
    await fs.rm(dir, { recursive: true })
})

test('disabled → reads an existing id but creates nothing', async () => {
    const dir = await tmp()
    assert.deepEqual(await ensureStowFile(dir, { git: false, enabled: false, exec: noGit }), { id: null, created: false, error: null })
    await assert.rejects(fs.access(path.join(dir, '.stow')))
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(file(dir), '{"id":"p_there"}')
    assert.deepEqual(await ensureStowFile(dir, { git: false, enabled: false, exec: noGit }), { id: 'p_there', created: false, error: null })
    await fs.rm(dir, { recursive: true })
})

test('enabled defaults to STOW_WRITE_PROJECT_FILES !== "0", read at call time', async () => {
    const dir = await tmp()
    const prev = process.env.STOW_WRITE_PROJECT_FILES
    process.env.STOW_WRITE_PROJECT_FILES = '0'
    try {
        assert.equal((await ensureStowFile(dir, { git: false, exec: noGit })).created, false)
    } finally {
        if (prev === undefined) delete process.env.STOW_WRITE_PROJECT_FILES
        else process.env.STOW_WRITE_PROJECT_FILES = prev
    }
    await fs.rm(dir, { recursive: true })
})

test('git root: appends .stow/ to info/exclude exactly once', async () => {
    const dir = await tmp()
    const exclude = path.join(dir, 'gitdir-info-exclude')
    await fs.writeFile(exclude, '# git ls-files --others --exclude-from=.git/info/exclude\n')
    const exec = async () => ({ stdout: exclude + '\n' })
    await ensureStowFile(dir, { git: true, enabled: true, exec })
    await fs.rm(path.join(dir, '.stow'), { recursive: true })
    await ensureStowFile(dir, { git: true, enabled: true, exec })
    const lines = (await fs.readFile(exclude, 'utf8')).split('\n').filter(l => l === '.stow/')
    assert.equal(lines.length, 1)
    await fs.rm(dir, { recursive: true })
})

test('unwritable root → error, no throw', { skip: process.getuid?.() === 0 }, async () => {
    const dir = await tmp()
    await fs.chmod(dir, 0o500)
    try {
        const r = await ensureStowFile(dir, { git: false, enabled: true, exec: noGit })
        assert.equal(r.id, null)
        assert.equal(r.created, false)
        assert.match(r.error, /EACCES|EPERM/)
    } finally {
        await fs.chmod(dir, 0o700)
        await fs.rm(dir, { recursive: true })
    }
})

test('existing file in a git root (e.g. git init after the file was written): recheckExclude adds .stow/ to info/exclude', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, '.stow'))
    await fs.writeFile(file(dir), '{"id":"p_there"}')
    const exclude = path.join(dir, 'exclude')
    let calls = 0
    const exec = async () => { calls++; return { stdout: exclude + '\n' } }
    assert.deepEqual(await ensureStowFile(dir, { git: true, enabled: true, exec }), { id: 'p_there', created: false, error: null })
    assert.equal(calls, 0) // no git spawn unless asked
    assert.deepEqual(await ensureStowFile(dir, { git: true, enabled: true, exec, recheckExclude: true }), { id: 'p_there', created: false, error: null })
    assert.equal(await fs.readFile(exclude, 'utf8'), '.stow/\n')
    await fs.rm(dir, { recursive: true })
})

test('exclude step fails after the file was written → the id is still used', { skip: process.getuid?.() === 0 }, async () => {
    const dir = await tmp()
    const locked = path.join(dir, 'locked')
    await fs.mkdir(locked)
    await fs.writeFile(path.join(locked, 'exclude'), '')
    await fs.chmod(path.join(locked, 'exclude'), 0o400)
    const exec = async () => ({ stdout: path.join(locked, 'exclude') + '\n' })
    try {
        const r = await ensureStowFile(dir, { git: true, enabled: true, exec })
        assert.match(r.id, /^p_/)
        assert.equal(r.created, true)
        assert.equal(JSON.parse(await fs.readFile(file(dir), 'utf8')).id, r.id)
    } finally {
        await fs.chmod(path.join(locked, 'exclude'), 0o600)
        await fs.rm(dir, { recursive: true })
    }
})
