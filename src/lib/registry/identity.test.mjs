import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemote, remoteOwner, identityOf, locationOf, checkoutIdentities, stowHomeOf } from './identity.mjs'

test('normalizeRemote: scp, https, ssh with port, credentials, proxy, local', () => {
  assert.equal(normalizeRemote('git@gitlab.com:intelimail/llm/sentiment.git'), 'gitlab.com/intelimail/llm/sentiment')
  assert.equal(normalizeRemote('https://github.com/erikmeliska/Edupage-API.git'), 'github.com/erikmeliska/edupage-api')
  assert.equal(normalizeRemote('https://user:s3cret@gitlab.com/slovenskoit/uahelp.git'), 'gitlab.com/slovenskoit/uahelp')
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/team/app.git/'), 'gitlab.example.com/team/app')
  assert.equal(normalizeRemote('https://www.github.com/a/b'), 'github.com/a/b')
  assert.equal(normalizeRemote('https://github.91chi.fun/https://github.com/earlephilhower/ESP8266Audio.git'), 'github.com/earlephilhower/esp8266audio')
  assert.equal(normalizeRemote('git@bitbucket.org:/boysfromheaven/pdftable2json.git'), 'bitbucket.org/boysfromheaven/pdftable2json')
  assert.equal(normalizeRemote('/Users/me/repos/x.git'), null)
  assert.equal(normalizeRemote('../x'), null)
  assert.equal(normalizeRemote('file:///srv/x.git'), null)
  assert.equal(normalizeRemote('https://github.com/'), null)
  assert.equal(normalizeRemote(''), null)
  assert.equal(normalizeRemote(undefined), null)
})

test('remoteOwner: top-level owner/group', () => {
  assert.equal(remoteOwner('gitlab.com/intelimail/llm/sentiment'), 'intelimail')
  assert.equal(remoteOwner('github.com/a/b'), 'a')
  assert.equal(remoteOwner('github.com/onlyrepo'), null)
  assert.equal(remoteOwner(null), null)
})

test('identityOf: remote wins, then stow id, then path', () => {
  const git = { directory: '/p/blog-test', git_info: { remotes: ['/local/mirror', 'git@gitlab.com:intelimail/blog.git'] } }
  assert.deepEqual(identityOf(git, { id: 'p_aaaaaaaaaaaa' }), { key: 'git:gitlab.com/intelimail/blog', kind: 'git', remote: 'gitlab.com/intelimail/blog' })
  assert.deepEqual(identityOf({ directory: '/p/x', git_info: { remotes: [] } }, { id: 'p_bbbbbbbbbbbb' }), { key: 'stow:p_bbbbbbbbbbbb', kind: 'stow', remote: null })
  assert.deepEqual(identityOf({ directory: '/p/y' }, null), { key: 'path:/p/y', kind: 'path', remote: null })
})

test('locationOf / identityOf: a row inside a checkout is located (and path-keyed) at its root (#9)', () => {
  const sub = { directory: '/p/repo/web', checkout: { root: '/p/repo', subpath: 'web', git: true } }
  assert.equal(locationOf(sub), '/p/repo')
  assert.equal(locationOf({ directory: '/p/plain' }), '/p/plain')
  assert.deepEqual(identityOf(sub, null), { key: 'path:/p/repo', kind: 'path', remote: null })
})

const co = (directory, root, extra = {}) => ({ directory, checkout: { root, subpath: directory === root ? '' : directory.slice(root.length + 1), git: true }, ...extra })
const rem = url => ({ git_info: { remotes: [url] } })

test('checkoutIdentities: one identity per checkout — the root row\'s remote wins over stale members', () => {
  const rows = [
    co('/p/app/web', '/p/app', rem('git@gitlab.com:o/app.git')), // cached, old remote
    co('/p/app', '/p/app', rem('git@github.com:o/app.git')),
    co('/p/app/api', '/p/app'), // getGitInfo failed: no remotes
  ]
  assert.deepEqual([...checkoutIdentities(rows)], [['/p/app', { key: 'git:github.com/o/app', kind: 'git', remote: 'github.com/o/app' }]])
})

test('checkoutIdentities: weak-only root (no row) → shallowest member with a remote; else .stow id at the home; else path', () => {
  const rows = [
    co('/b/era/x/deep', '/b/era'), co('/b/era/y', '/b/era', rem('git@bitbucket.org:e/era.git')),
    co('/n/tool/cli', '/n/tool'),
    co('/f/ro', '/f/ro'),
  ]
  const ids = checkoutIdentities(rows, home => (home === '/n/tool' ? { id: 'p_toolllllllll' } : null))
  assert.equal(ids.get('/b/era').key, 'git:bitbucket.org/e/era')
  assert.equal(ids.get('/n/tool').key, 'stow:p_toolllllllll')
  assert.equal(ids.get('/f/ro').key, 'path:/f/ro')
})

test('stowHomeOf: a linked worktree keeps its id in the main work tree', () => {
  assert.equal(stowHomeOf({ directory: '/p/wt', checkout: { root: '/p/wt', subpath: '', git: true, main: '/p/main' } }), '/p/main')
  assert.equal(stowHomeOf(co('/p/a/b', '/p/a')), '/p/a')
  const ids = checkoutIdentities([{ directory: '/p/wt', checkout: { root: '/p/wt', subpath: '', git: true, main: '/p/main' } }],
    home => (home === '/p/main' ? { id: 'p_mainmainmain' } : null))
  assert.equal(ids.get('/p/wt').key, 'stow:p_mainmainmain')
})
