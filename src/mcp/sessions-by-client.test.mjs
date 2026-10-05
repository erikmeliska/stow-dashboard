import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientsSummary, clientProjects } from './sessions-by-client.mjs'

const REG = {
  clients: [{ id: 'intelimail', name: 'Intelimail', projects: ['git:x/blog', 'git:x/app'] }],
  projects: [
    { key: 'git:x/blog', name: 'blog', remote: 'x/blog', primary: '/p/blog', client: { id: 'intelimail', name: 'Intelimail' }, locations: [{ directory: '/p/blog', role: 'primary', members: 1 }, { directory: '/p/blog-huha', role: 'experiment' }] },
    { key: 'git:x/app', name: 'app', remote: 'x/app', primary: '/p/app', client: { id: 'intelimail', name: 'Intelimail' }, locations: [{ directory: '/p/app', role: 'primary' }] },
    { key: 'path:/p/sandbox', name: 'sandbox', remote: null, primary: '/p/sandbox', client: null, locations: [{ directory: '/p/sandbox', role: 'primary' }] },
  ],
}

test('clientsSummary: project counts from the register, session numbers from the period, Unassigned last', () => {
  const stats = new Map([['git:x/blog', { sessions: 3, cost_usd: 4.5 }], ['path:/p/sandbox', { sessions: 1, cost_usd: 1 }], [null, { sessions: 2, cost_usd: 0.25 }]])
  assert.deepEqual(clientsSummary(REG, stats), [
    { id: 'intelimail', name: 'Intelimail', projects: 2, sessions: 3, cost_usd: 4.5 },
    { id: 'unassigned', name: 'Unassigned', projects: 1, sessions: 3, cost_usd: 1.25 },
  ])
})

test('clientsSummary: a session key the register does not know counts as Unassigned', () => {
  const r = clientsSummary(REG, new Map([['stow:gone', { sessions: 1, cost_usd: 2 }]]))
  assert.deepEqual(r.at(-1), { id: 'unassigned', name: 'Unassigned', projects: 1, sessions: 1, cost_usd: 2 })
})

test('clientProjects lists a client’s projects with locations; unassigned works', () => {
  const p = clientProjects(REG, { id: 'intelimail' })
  assert.deepEqual(p.map((x) => [x.name, x.locations.length]), [['app', 1], ['blog', 2]])
  assert.deepEqual(p[1].locations[0], { directory: '/p/blog', role: 'primary' })
  assert.deepEqual(clientProjects(REG, 'unassigned').map((x) => x.name), ['sandbox'])
})
