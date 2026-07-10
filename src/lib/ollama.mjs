// src/lib/ollama.mjs
// Local Ollama fallback for projects the Apple model rejects
// (unsupported input language — e.g. Slovak). Uses /api/chat with
// structured output (format: <json schema>), stream:false.

// Read at CALL time (same per-request rule as scan-roots) so env changes take
// effect without a restart.
export function getOllamaConfig() {
  return {
    baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3',
  }
}

// True only when Ollama is reachable AND the configured model is installed
// (matched on the name prefix before ':'). Never throws — returns false.
export async function ollamaAvailable({ fetchImpl = fetch } = {}) {
  const { baseUrl, model } = getOllamaConfig()
  const wanted = model.split(':')[0]
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: globalThis.AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const data = await res.json()
    return (data.models || []).some(m => String(m.name || '').split(':')[0] === wanted)
  } catch {
    return false
  }
}

export async function runOllama({ system, prompt, schema, fetchImpl = fetch, timeoutMs = 120000 }) {
  const { baseUrl, model } = getOllamaConfig()
  const res = await fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      format: schema,
      options: { temperature: 0 },
    }),
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`ollama request failed: HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(`ollama error: ${data.error}`)
  try {
    return JSON.parse(data.message.content)
  } catch (err) {
    throw new Error(`ollama returned unparseable content: ${err.message}`)
  }
}
