import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemote, remoteOwner, identityOf } from './identity.mjs'

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
