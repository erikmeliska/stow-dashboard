import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocation, resolveLocations } from './checkout-location.mjs'

// Fake exec: maps "-C <dir>" → toplevel stdout, or throws like git outside a repo.
function fakeExec(table) {
    return async (cmd, args) => {
        const dir = args[1]
        if (!(dir in table)) throw Object.assign(new Error('fatal: not a git repository'), { code: 128 })
        return { stdout: table[dir] }
    }
}

test('resolveLocation: sub-folder of a repo → root is the toplevel, subpath relative', async () => {
    const exec = fakeExec({ '/p/btstack/example': '/p/btstack\n' })
    assert.deepEqual(await resolveLocation('/p/btstack/example', { exec }),
        { root: '/p/btstack', subpath: 'example', git: true })
})

test('resolveLocation: repo root → subpath is empty', async () => {
    const exec = fakeExec({ '/p/blog': '/p/blog\n' })
    assert.deepEqual(await resolveLocation('/p/blog', { exec }), { root: '/p/blog', subpath: '', git: true })
})

test('resolveLocation: not a repo / git failure → non-git, root = directory', async () => {
    assert.deepEqual(await resolveLocation('/p/plain', { exec: fakeExec({}) }),
        { root: '/p/plain', subpath: '', git: false })
})

test('resolveLocation: toplevel outside the directory path (symlinked root) → treat directory as root', async () => {
    const exec = fakeExec({ '/p/x': '/private/p/x\n' })
    assert.deepEqual(await resolveLocation('/p/x', { exec }), { root: '/p/x', subpath: '', git: true })
})

test('resolveLocation: empty toplevel output → non-git', async () => {
    const exec = fakeExec({ '/p/bare': '\n' })
    assert.deepEqual(await resolveLocation('/p/bare', { exec }), { root: '/p/bare', subpath: '', git: false })
})

test('resolveLocations only fills rows without checkout unless force', async () => {
    let calls = 0
    const exec = async () => { calls++; throw new Error('not a repo') }
    const rows = [{ directory: '/a' }, { directory: '/b', checkout: { root: '/b', subpath: '', git: false } }]
    await resolveLocations(rows, { exec })
    assert.deepEqual(rows[0].checkout, { root: '/a', subpath: '', git: false })
    assert.equal(calls, 1)
    await resolveLocations(rows, { exec, force: true })
    assert.equal(calls, 3)
})
