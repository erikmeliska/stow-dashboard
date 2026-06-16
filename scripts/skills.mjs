import { readFile, writeFile, mkdir, rm, cp, symlink } from 'fs/promises'
import path from 'path'
import os from 'os'

function expandSource(source) {
    if (source === '~') return os.homedir()
    if (source.startsWith('~/')) return path.join(os.homedir(), source.slice(2))
    return source
}

export async function readManifest(dir) {
    return JSON.parse(await readFile(path.join(dir, 'skills.manifest.json'), 'utf-8'))
}

export async function writeManifest(dir, manifest) {
    await writeFile(path.join(dir, 'skills.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
}

export async function syncSkills(dir) {
    const manifest = await readManifest(dir)
    const skillsDir = path.join(dir, '.claude', 'skills')
    await mkdir(skillsDir, { recursive: true })
    const summary = { mode: manifest.mode, linked: [], copied: [], custom: manifest.custom || [] }
    for (const entry of manifest.shared || []) {
        const src = path.join(expandSource(entry.source), entry.name)
        const dest = path.join(skillsDir, entry.name)
        await rm(dest, { recursive: true, force: true })
        if (manifest.mode === 'vendored') {
            await cp(src, dest, { recursive: true })
            summary.copied.push(entry.name)
        } else {
            await symlink(src, dest)
            summary.linked.push(entry.name)
        }
    }
    return summary
}

export async function ejectSkill(dir, name) {
    const manifest = await readManifest(dir)
    const idx = (manifest.shared || []).findIndex(e => e.name === name)
    if (idx === -1) throw new Error(`Skill not in shared[]: ${name}`)
    const entry = manifest.shared[idx]
    const dest = path.join(dir, '.claude', 'skills', name)
    const src = path.join(expandSource(entry.source), name)
    await rm(dest, { recursive: true, force: true })
    await cp(src, dest, { recursive: true })
    manifest.shared.splice(idx, 1)
    manifest.custom = manifest.custom || []
    if (!manifest.custom.includes(name)) manifest.custom.push(name)
    await writeManifest(dir, manifest)
    return { ejected: name }
}
