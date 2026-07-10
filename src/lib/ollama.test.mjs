// src/lib/ollama.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getOllamaConfig, ollamaAvailable, runOllama } from './ollama.mjs'

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

test('getOllamaConfig reads env at call time with defaults', () => {
  const savedUrl = process.env.OLLAMA_URL
  const savedModel = process.env.OLLAMA_MODEL
  try {
    delete process.env.OLLAMA_URL
    delete process.env.OLLAMA_MODEL
    assert.deepEqual(getOllamaConfig(), { baseUrl: 'http://localhost:11434', model: 'llama3' })
    process.env.OLLAMA_URL = 'http://host:9999'
    process.env.OLLAMA_MODEL = 'qwen2'
    assert.deepEqual(getOllamaConfig(), { baseUrl: 'http://host:9999', model: 'qwen2' })
  } finally {
    if (savedUrl === undefined) delete process.env.OLLAMA_URL
    else process.env.OLLAMA_URL = savedUrl
    if (savedModel === undefined) delete process.env.OLLAMA_MODEL
    else process.env.OLLAMA_MODEL = savedModel
  }
})

test('ollamaAvailable is true only when the configured model is listed (prefix match)', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/api\/tags$/)
    return jsonResponse({ models: [{ name: 'llama3:latest' }, { name: 'other' }] })
  }
  assert.equal(await ollamaAvailable({ fetchImpl }), true)
})

test('ollamaAvailable is false when the configured model is absent', async () => {
  const fetchImpl = async () => jsonResponse({ models: [{ name: 'qwen2:7b' }] })
  assert.equal(await ollamaAvailable({ fetchImpl }), false)
})

test('ollamaAvailable is false (never throws) when unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await ollamaAvailable({ fetchImpl }), false)
})

test('runOllama posts to /api/chat with structured output and parses content', async () => {
  let captured
  const out = { category: '_Bizz', client: 'TriSoft' }
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) }
    return jsonResponse({ message: { content: JSON.stringify(out) } })
  }
  const result = await runOllama({ system: 'sys', prompt: 'p', schema: { type: 'object' }, fetchImpl })
  assert.deepEqual(result, out)
  assert.match(captured.url, /\/api\/chat$/)
  assert.equal(captured.body.stream, false)
  assert.deepEqual(captured.body.format, { type: 'object' })
  assert.equal(captured.body.messages[0].role, 'system')
  assert.equal(captured.body.messages[0].content, 'sys')
  assert.equal(captured.body.messages[1].content, 'p')
  assert.equal(captured.body.options.temperature, 0)
})

test('runOllama throws on an error body', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'model not found' })
  await assert.rejects(runOllama({ system: 's', prompt: 'p', schema: {}, fetchImpl }), /model not found/)
})

test('runOllama throws on a non-200 response', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 500 })
  await assert.rejects(runOllama({ system: 's', prompt: 'p', schema: {}, fetchImpl }), /500/)
})

test('runOllama throws when the content is not valid JSON', async () => {
  const fetchImpl = async () => jsonResponse({ message: { content: 'not json at all' } })
  await assert.rejects(runOllama({ system: 's', prompt: 'p', schema: {}, fetchImpl }), /unparseable/)
})
