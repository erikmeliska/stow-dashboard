import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientKey, cleanClientName, bizzClient, buildClientCatalog } from './client.mjs'

test('clientKey folds case, punctuation, diacritics and the AI new: marker', () => {
  for (const n of ['Boys from Heaven', 'boys-from-heaven', 'boysfromheaven']) assert.equal(clientKey(n), 'boysfromheaven')
  assert.equal(clientKey('new:Archon'), 'archon')
  assert.equal(clientKey('Farnosť Domaňovce'), 'farnostdomanovce')
  assert.equal(clientKey(''), '')
  assert.equal(clientKey(null), '')
  assert.equal(cleanClientName('  new:Acme '), 'Acme')
})

test('bizzClient reads the _Bizz/<Client> segment', () => {
  assert.equal(bizzClient('/Users/x/Projekty/_Bizz/Intelimail/sms'), 'Intelimail')
  assert.equal(bizzClient('/Users/x/Projekty/_Bizz/TriSoft'), 'TriSoft')
  assert.equal(bizzClient('/Users/x/Projekty/blog'), null)
})

test('catalog: display name priority config > bizz > most frequent; aliases', () => {
  const cat = buildClientCatalog({
    config: { clients: [{ name: 'TriSoft s.r.o.', aliases: ['tri-soft', 'trisoft'] }] },
    names: { bizz: ['Intelimail', 'TriSoft'], seen: ['InteliMail', 'archon', 'new:Archon', 'Archon', 'Archon'] },
  })
  assert.deepEqual(cat.lookup('INTELIMAIL'), { id: 'intelimail', name: 'Intelimail' })
  assert.deepEqual(cat.lookup('tri-soft'), { id: 'trisoftsro', name: 'TriSoft s.r.o.' })
  assert.deepEqual(cat.lookup('TriSoft'), { id: 'trisoftsro', name: 'TriSoft s.r.o.' })
  assert.deepEqual(cat.lookup('new:archon'), { id: 'archon', name: 'Archon' })
  assert.equal(cat.lookup('erikmeliska'), null)
  assert.deepEqual(cat.list().map(c => c.id), ['archon', 'intelimail', 'trisoftsro'])
})
