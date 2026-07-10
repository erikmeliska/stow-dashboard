import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { getScanRoots, getBaseDir } from './scan-roots.mjs'

test('getScanRoots reflects the CURRENT env, not a module-eval snapshot', () => {
    const prevRoots = process.env.SCAN_ROOTS
    try {
        process.env.SCAN_ROOTS = '/a,/b'
        const first = getScanRoots()
        assert.deepEqual(first, ['/a', '/b'])

        process.env.SCAN_ROOTS = '/c'
        const second = getScanRoots()
        assert.deepEqual(second, ['/c'], 'a later call sees the updated env')
    } finally {
        if (prevRoots === undefined) delete process.env.SCAN_ROOTS
        else process.env.SCAN_ROOTS = prevRoots
    }
})

test('getScanRoots trims whitespace and drops empty segments', () => {
    const prevRoots = process.env.SCAN_ROOTS
    try {
        process.env.SCAN_ROOTS = ' /a , ,/b ,,'
        assert.deepEqual(getScanRoots(), ['/a', '/b'])
    } finally {
        if (prevRoots === undefined) delete process.env.SCAN_ROOTS
        else process.env.SCAN_ROOTS = prevRoots
    }
})

test('getScanRoots falls back to ~/Projekty when SCAN_ROOTS is unset', () => {
    const prevRoots = process.env.SCAN_ROOTS
    try {
        delete process.env.SCAN_ROOTS
        assert.deepEqual(getScanRoots(), [path.join(os.homedir(), 'Projekty')])
    } finally {
        if (prevRoots === undefined) delete process.env.SCAN_ROOTS
        else process.env.SCAN_ROOTS = prevRoots
    }
})

test('getBaseDir reflects the current env and falls back to ~/Projekty', () => {
    const prevBase = process.env.BASE_DIR
    try {
        process.env.BASE_DIR = '/work'
        assert.equal(getBaseDir(), '/work')
        process.env.BASE_DIR = '/other'
        assert.equal(getBaseDir(), '/other', 'a later call sees the updated env')
        delete process.env.BASE_DIR
        assert.equal(getBaseDir(), path.join(os.homedir(), 'Projekty'))
    } finally {
        if (prevBase === undefined) delete process.env.BASE_DIR
        else process.env.BASE_DIR = prevBase
    }
})
