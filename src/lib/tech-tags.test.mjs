// src/lib/tech-tags.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTech, extractTech } from './tech-tags.mjs'

test('normalizeTech lowercases, maps synonyms, dedupes, sorts', () => {
  assert.deepEqual(
    normalizeTech(['Next.js', 'nextjs', 'PostgreSQL', 'TailwindCSS', ' Docker Compose ']),
    ['docker', 'nextjs', 'postgres', 'tailwind']
  )
})

test('normalizeTech keeps unknown tags as slugs', () => {
  assert.deepEqual(normalizeTech(['Home Assistant']), ['home-assistant'])
})

test('normalizeTech drops empty and non-string entries', () => {
  assert.deepEqual(normalizeTech(['', null, undefined, 'react']), ['react'])
})

test('extractTech maps known deps and ignores unknown dep noise', () => {
  const project = { stack: ['next', 'react', 'react-dom', 'ansi-styles', 'chalk'], file_types: {} }
  assert.deepEqual(extractTech(project), ['nextjs', 'react'])
})

test('extractTech picks up file extensions and top-level signal files', () => {
  const project = { stack: [], file_types: { '.py': 12, '.ino': 2 } }
  assert.deepEqual(
    extractTech(project, ['Dockerfile', 'platformio.ini', 'src']),
    ['arduino', 'docker', 'platformio', 'python']
  )
})

test('extractTech tolerates missing fields', () => {
  assert.deepEqual(extractTech({}), [])
})
