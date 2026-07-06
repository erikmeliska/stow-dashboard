import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveCandidateRoot, NegativeCache, isExcludedPath } from './discovery.mjs'

async function makeTree(spec) {
    // spec: { 'relative/dir': ['file1', ...] }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discovery-test-'))
    for (const [rel, files] of Object.entries(spec)) {
        const dir = path.join(root, rel)
        await fs.mkdir(dir, { recursive: true })
        for (const f of files) await fs.writeFile(path.join(dir, f), '')
    }
    return root
}

test('resolveCandidateRoot finds the cwd itself when it has an indicator', async () => {
    const root = await makeTree({ 'proj': ['package.json'] })
    const result = await resolveCandidateRoot(path.join(root, 'proj'), [root])
    assert.equal(result, path.join(root, 'proj'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot walks up from a nested cwd to the nearest indicator', async () => {
    const root = await makeTree({ 'proj': ['package.json'], 'proj/src/deep': [] })
    const result = await resolveCandidateRoot(path.join(root, 'proj/src/deep'), [root])
    assert.equal(result, path.join(root, 'proj'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot prefers the NEAREST indicator when nested projects exist', async () => {
    const root = await makeTree({ 'outer': ['package.json'], 'outer/inner': ['package.json'] })
    const result = await resolveCandidateRoot(path.join(root, 'outer/inner'), [root])
    assert.equal(result, path.join(root, 'outer/inner'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null for a bare dir (no indicator anywhere)', async () => {
    const root = await makeTree({ 'bare/sub': [] })
    assert.equal(await resolveCandidateRoot(path.join(root, 'bare/sub'), [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot accepts a weak indicator (.git dir)', async () => {
    const root = await makeTree({ 'repo/.git': [], 'repo/src': [] })
    const result = await resolveCandidateRoot(path.join(root, 'repo/src'), [root])
    assert.equal(result, path.join(root, 'repo'))
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null when cwd is not under any scan root', async () => {
    const root = await makeTree({ 'proj': ['package.json'] })
    assert.equal(await resolveCandidateRoot('/somewhere/else', [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null when cwd IS a scan root', async () => {
    const root = await makeTree({ '.': ['package.json'] })
    assert.equal(await resolveCandidateRoot(root, [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('resolveCandidateRoot returns null for excluded paths (node_modules, hidden dirs)', async () => {
    const root = await makeTree({
        'proj': ['package.json'],
        'proj/node_modules/dep': ['package.json'],
        'proj/.cache/x': [],
    })
    assert.equal(await resolveCandidateRoot(path.join(root, 'proj/node_modules/dep'), [root]), null)
    assert.equal(await resolveCandidateRoot(path.join(root, 'proj/.cache/x'), [root]), null)
    await fs.rm(root, { recursive: true, force: true })
})

test('isExcludedPath flags hidden and ignored segments, not clean paths', () => {
    assert.equal(isExcludedPath('/r/proj/node_modules/x', '/r'), true)
    assert.equal(isExcludedPath('/r/proj/.git/hooks', '/r'), true)
    assert.equal(isExcludedPath('/r/proj/src', '/r'), false)
})

test('NegativeCache: add/has respects TTL', async () => {
    const cache = new NegativeCache(50) // 50ms TTL for the test
    cache.add('/a')
    assert.equal(cache.has('/a'), true)
    assert.equal(cache.has('/b'), false)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(cache.has('/a'), false) // expired
})
