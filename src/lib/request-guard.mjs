/**
 * CSRF / DNS-rebinding guard for the state-changing API routes: they run
 * local filesystem and register writes, so only same-origin JSON is accepted.
 * A cross-site form or `text/plain` fetch can't set application/json without a
 * CORS preflight (which this server never answers), and a browser always sends
 * Origin / Sec-Fetch-Site on cross-site requests. The Host must be loopback, or
 * a DNS-rebound name (evil.example → 127.0.0.1) would make Origin and Host agree.
 *
 * Call it with `request.headers` before reading the body.
 * → an error message (answer 403), or null if ok.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function guardRequest(headers) {
  const hostname = (headers.get('host') || '').replace(/:\d+$/, '').toLowerCase()
  if (!LOOPBACK.has(hostname)) return 'changes are only accepted on a loopback host (localhost)'
  const type = headers.get('content-type') || ''
  if (!/^application\/json\b/i.test(type)) return 'expected an application/json request'
  if (headers.get('sec-fetch-site') === 'cross-site') return 'cross-origin request refused'
  const origin = headers.get('origin')
  if (origin) {
    let host = null
    try { host = new URL(origin).host } catch { /* opaque origin */ }
    if (host !== headers.get('host')) return 'cross-origin request refused'
  }
  return null
}
