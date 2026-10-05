import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardRequest } from './request-guard.mjs'

test('guardRequest: JSON from the same origin only (CSRF)', () => {
  const h = (o) => new Map(Object.entries({ host: 'localhost:3088', ...o })) // the Headers.get surface used
  assert.equal(guardRequest(h({ 'content-type': 'application/json' })), null)
  assert.equal(guardRequest(h({ 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:3088' })), null)
  assert.match(guardRequest(h({ 'content-type': 'text/plain' })), /json/i)
  assert.match(guardRequest(h({ 'content-type': 'application/json', origin: 'https://evil.example' })), /origin/i)
  assert.match(guardRequest(h({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })), /origin/i)
  // DNS rebinding: evil.example resolving to 127.0.0.1 makes Origin and Host agree.
  const rebound = new Map(Object.entries({ host: 'evil.example:3088', origin: 'http://evil.example:3088', 'content-type': 'application/json' }))
  assert.match(guardRequest(rebound), /host/i)
  for (const host of ['127.0.0.1:3087', '[::1]:3088', 'localhost']) {
    assert.equal(guardRequest(new Map(Object.entries({ host, 'content-type': 'application/json' }))), null, host)
  }
})
