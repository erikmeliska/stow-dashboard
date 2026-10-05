import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getReport, applySuggestion, dismissSuggestion, relocate } from './reorg-service.mjs'
import { PathMovesError } from './path-moves.mjs'

const register = { projects: [
  { key: 'p1', name: 'blog', client: { id: 'acme', name: 'Acme', source: 'owner' }, primary: '/P/blog', locations: [{ directory: '/P/blog', role: 'primary', role_source: 'derived' }] },
] }
const rows = [{ directory: '/P/blog', checkout: { root: '/P/blog', subpath: '', git: true }, git_info: {}, scc: { total_code: 5 } }]

function deps(o = {}) {
  const calls = []
  let dismissed = o.dismissed ?? {}
  return {
    calls,
    loadRegistry: async () => register,
    readRows: async () => rows,
    readConfig: async () => ({ clients: [] }),
    loadDismissed: async () => dismissed,
    dismiss: async (id, fp) => { calls.push(['dismiss', id]); dismissed = { ...dismissed, [id]: { at: 'x', fingerprint: fp } } },
    undismiss: async (id) => { calls.push(['undismiss', id]); dismissed = { ...dismissed }; delete dismissed[id] },
    loadPathMoves: o.loadPathMoves ?? (async () => []),
    applyAction: async (action) => { calls.push(['apply', action]) },
    baseDir: '/P', exists: (p) => p === '/P/blog',
    relocateDeps: async () => ({ marker: true }),
    planRelocation: async (args) => { calls.push(['plan', args]); return { ok: true, planHash: 'h' } },
    executeRelocation: async (args) => { calls.push(['execute', args]); return { ok: true } },
    ...o,
  }
}

test('getReport builds the register report from injected loaders', async () => {
  const r = await getReport({ deps: deps() })
  assert.deepEqual(r.suggestions.map(s => s.id), ['client-placement:p1:/P/blog'])
  assert.equal(r.summary['client-placement'], 1)
  assert.equal(r.error, undefined)
})

test('a malformed path-moves.json shows up as error, the report still returns', async () => {
  const r = await getReport({ deps: deps({ loadPathMoves: async () => { throw new PathMovesError('path-moves.json is malformed') } }) })
  assert.match(r.error, /malformed/)
  assert.equal(r.suggestions.length, 1)
})

test('includeDismissed shows dismissed suggestions again', async () => {
  const d = deps()
  const first = (await getReport({ deps: d })).suggestions[0]
  await dismissSuggestion({ id: first.id, deps: d })
  assert.equal((await getReport({ deps: d })).suggestions.length, 0)
  assert.equal((await getReport({ deps: d, includeDismissed: true })).suggestions.length, 1)
  await dismissSuggestion({ id: first.id, undo: true, deps: d })
  assert.equal((await getReport({ deps: d })).suggestions.length, 1)
})

test('applySuggestion runs the suggestion\'s own action; an unknown id is a 409', async () => {
  const d = deps()
  await applySuggestion({ id: 'client-placement:p1:/P/blog', deps: d })
  assert.deepEqual(d.calls, [['apply', { type: 'confirm-client', client: 'Acme', directory: '/P/blog' }]])
  await assert.rejects(applySuggestion({ id: 'nope', deps: d }), (e) => e.status === 409)
  await assert.rejects(dismissSuggestion({ id: 'nope', deps: d }), (e) => e.status === 409)
})

test('relocate: dryRun only plans, never executes; apply needs a planHash', async () => {
  const d = deps()
  const plan = await relocate({ from: '/P/blog', to: '/P/_Bizz/Acme/blog', dryRun: true, deps: d })
  assert.equal(plan.planHash, 'h')
  assert.deepEqual(d.calls.map(c => c[0]), ['plan'])
  await assert.rejects(relocate({ from: '/P/blog', to: '/P/x', dryRun: false, deps: d }), (e) => e.status === 400)
  await assert.rejects(relocate({ from: 'rel', to: '/P/x', dryRun: true, deps: d }), (e) => e.status === 400)
  await relocate({ from: '/P/blog', to: '/P/x', planHash: 'h', deps: d })
  assert.deepEqual(d.calls.at(-1), ['execute', { from: '/P/blog', to: '/P/x', planHash: 'h', force: false }])
})
