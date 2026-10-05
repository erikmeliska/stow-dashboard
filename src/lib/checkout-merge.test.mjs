import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stowRoots, assignIdentities, carryForwardMoved } from './checkout-merge.mjs'

const row = (directory, root, extra = {}) => ({
    directory, checkout: { root, subpath: directory === root ? '' : directory.slice(root.length + 1), git: true }, ...extra,
})
const remote = url => ({ git_info: { remotes: [url] } })

test('stowRoots: only checkout roots without a remote identity, once each, with their git flag', () => {
    const rows = [
        row('/r/app', '/r/app', remote('git@github.com:o/app.git')),
        row('/r/app/web', '/r/app', remote('git@github.com:o/app.git')),
        row('/n/tool', '/n/tool'),
        row('/n/tool/cli', '/n/tool'),
        { directory: '/plain', checkout: { root: '/plain', subpath: '', git: false } },
        row('/m/mirror', '/m/mirror', remote('/local/path/only')),
    ]
    assert.deepEqual([...stowRoots(rows)], [['/n/tool', { git: true }], ['/plain', { git: false }], ['/m/mirror', { git: true }]])
})

test('stowRoots: a checkout where any member has a remote needs no file', () => {
    const rows = [row('/r/x', '/r/x'), row('/r/x/sub', '/r/x', remote('https://gitlab.com/a/x'))]
    assert.equal(stowRoots(rows).size, 0)
})

test('assignIdentities: git remote, stow id at the root, path fallback at the root; project_id = key', () => {
    const rows = [
        row('/r/app/web', '/r/app', remote('git@github.com:O/app.git')),
        row('/n/tool/cli', '/n/tool'),
        row('/f/ro/sub', '/f/ro'),
    ]
    assignIdentities(rows, new Map([['/n/tool', 'p_toolllllllll'], ['/f/ro', null]]))
    assert.deepEqual(rows.map(r => [r.identity, r.project_id]), [
        [{ key: 'git:github.com/o/app', kind: 'git' }, 'git:github.com/o/app'],
        [{ key: 'stow:p_toolllllllll', kind: 'stow' }, 'stow:p_toolllllllll'],
        [{ key: 'path:/f/ro', kind: 'path' }, 'path:/f/ro'],
    ])
})

test('carryForwardMoved: new row inherits ai_* of the vanished row with same identity+subpath', () => {
    const k = { key: 'stow:p_x', kind: 'stow' }
    const prior = [{ ...row('/old/p/web', '/old/p'), identity: k, ai_analysis: { category: '_Bizz' }, ai_derived: { status: 'active' } }]
    const rows = [{ ...row('/new/p/web', '/new/p'), identity: k }, { ...row('/new/p/api', '/new/p'), identity: k }]
    assert.deepEqual(carryForwardMoved(rows, prior), [{ from: '/old/p/web', to: '/new/p/web', key: 'stow:p_x' }])
    assert.deepEqual(rows[0].ai_analysis, { category: '_Bizz' })
    assert.deepEqual(rows[0].ai_derived, { status: 'active' })
    assert.equal(rows[1].ai_analysis, undefined)
})

test('carryForwardMoved: never overwrites, never copies from a row still present', () => {
    const k = { key: 'git:a/b', kind: 'git' }
    const prior = [{ ...row('/a', '/a'), identity: k, ai_analysis: { category: 'old' } }]
    const rows = [{ ...row('/a', '/a'), identity: k }, { ...row('/a2', '/a2'), identity: k, ai_analysis: { category: 'own' } }]
    assert.deepEqual(carryForwardMoved(rows, prior), [])
    assert.deepEqual(rows[1].ai_analysis, { category: 'own' })
})

test('carryForwardMoved: one donor feeds at most one new row (two clones appearing at once)', () => {
    const k = { key: 'git:a/b', kind: 'git' }
    const prior = [{ ...row('/old', '/old'), identity: k, ai_analysis: { category: 'x' } }]
    const rows = [{ ...row('/n1', '/n1'), identity: k }, { ...row('/n2', '/n2'), identity: k }]
    assert.equal(carryForwardMoved(rows, prior).length, 1)
    assert.equal(rows.filter(r => r.ai_analysis).length, 1)
})

test('carryForwardMoved: prior rows without identity (pre-#9 ledger) donate nothing', () => {
    const prior = [{ directory: '/old', ai_analysis: { category: 'x' } }]
    const rows = [{ ...row('/new', '/new'), identity: { key: 'path:/new', kind: 'path' } }]
    assert.deepEqual(carryForwardMoved(rows, prior), [])
})
