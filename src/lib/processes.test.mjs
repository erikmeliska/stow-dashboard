import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHost, groupProcessSources } from './processes.mjs'

test('classifyHost recognizes Claude CLI', () => {
  assert.equal(classifyHost('node /usr/local/bin/claude'), 'claude')
  assert.equal(classifyHost('claude'), 'claude')
})

test('classifyHost recognizes dev servers and shells', () => {
  assert.equal(classifyHost('next dev -p 3089'), 'dev-server')
  assert.equal(classifyHost('-zsh'), 'terminal')
})

test('classifyHost falls back to process', () => {
  assert.equal(classifyHost('some-random-binary'), 'process')
})

test('groupProcessSources groups matched entries by project and collects unmatched cwds', () => {
    const projectDirs = ['/r/proj-a', '/r/proj-b']
    const sources = {
        runningProcesses: [
            { pid: '11', command: 'node server.js', cwd: '/r/proj-a', ports: [3000], host: null, hostLabel: null },
            { pid: '12', command: 'node x', cwd: '/r/unknown-1', ports: [4000], host: null, hostLabel: null },
        ],
        claudeSessions: [
            { pid: '21', cwd: '/r/proj-b/sub', host: null, hostLabel: null },
        ],
        openTerminals: [
            { pid: '31', command: 'zsh', cwd: '/r/unknown-2/deep', tty: 'ttys001', host: null, hostLabel: null },
        ],
        dockerContainers: [
            { id: 'c1', name: 'db', image: 'postgres', ports: [5432], status: 'Up', cwd: '/r/proj-a' },
        ],
    }

    const { projects, unmatchedCwds } = groupProcessSources(sources, projectDirs)

    assert.equal(projects['/r/proj-a'].length, 2) // process + docker
    assert.equal(projects['/r/proj-a'][0].type, 'process')
    assert.equal(projects['/r/proj-a'][1].type, 'docker')
    assert.equal(projects['/r/proj-b'].length, 1)
    assert.equal(projects['/r/proj-b'][0].type, 'claude')
    assert.deepEqual(unmatchedCwds.sort(), ['/r/unknown-1', '/r/unknown-2/deep'])
})
