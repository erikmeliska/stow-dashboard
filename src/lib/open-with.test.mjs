import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseAppList, isAllowedApp, readOpenWithEnv } from './open-with.mjs'

test('parseAppList splits, trims and filters a comma list', () => {
    assert.deepEqual(parseAppList(' code, cursor ,zed,, ', 'ignored', 'code'), ['code', 'cursor', 'zed'])
})

test('parseAppList falls back to the legacy single value', () => {
    assert.deepEqual(parseAppList(undefined, 'cursor', 'code'), ['cursor'])
    assert.deepEqual(parseAppList('   ', 'cursor', 'code'), ['cursor'])
})

test('parseAppList falls back to the hard default when nothing is set', () => {
    assert.deepEqual(parseAppList(undefined, undefined, 'Terminal'), ['Terminal'])
    assert.deepEqual(parseAppList('', '  ', 'Terminal'), ['Terminal'])
})

test('isAllowedApp is exact membership', () => {
    assert.equal(isAllowedApp('cursor', ['code', 'cursor']), true)
    assert.equal(isAllowedApp('cursor; rm -rf /', ['code', 'cursor']), false)
    assert.equal(isAllowedApp('Code', ['code']), false) // case-sensitive
})

test('readOpenWithEnv reads lists from an env file and strips quotes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openwith-'))
    const envPath = path.join(dir, '.env.local')
    await fs.writeFile(envPath, '# comment\nIDE_COMMANDS="code,cursor"\nTERMINAL_APPS=Terminal, Warp\n')
    const config = await readOpenWithEnv(envPath)
    assert.deepEqual(config.ide, ['code', 'cursor'])
    assert.deepEqual(config.terminal, ['Terminal', 'Warp'])
    await fs.rm(dir, { recursive: true, force: true })
})

test('readOpenWithEnv tolerates a missing env file (falls back to process.env/defaults)', async () => {
    const before = { IDE_COMMANDS: process.env.IDE_COMMANDS, IDE_COMMAND: process.env.IDE_COMMAND }
    delete process.env.IDE_COMMANDS
    process.env.IDE_COMMAND = 'zed'
    try {
        const config = await readOpenWithEnv('/nonexistent/.env.local')
        assert.deepEqual(config.ide, ['zed'])
    } finally {
        if (before.IDE_COMMANDS !== undefined) process.env.IDE_COMMANDS = before.IDE_COMMANDS
        if (before.IDE_COMMAND !== undefined) process.env.IDE_COMMAND = before.IDE_COMMAND
        else delete process.env.IDE_COMMAND
    }
})
