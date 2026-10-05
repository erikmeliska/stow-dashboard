/**
 * Manual client / role edits from the projects page (#10), written into the
 * per-checkout `.stow/project.json` (#8) — the register reads them back on
 * the next page render. Deps are injectable; the defaults touch the disk.
 * A vanished checkout is never recreated (writeStowMeta would mkdir it).
 */
import fs from 'node:fs/promises'
import { loadRegistry as defaultLoadRegistry } from './registry/registry.mjs'
import { readStowMeta as defaultReadStowMeta, writeStowMeta as defaultWriteStowMeta } from './registry/stow-meta.mjs'

async function defaultExists(dir) {
  try { return (await fs.stat(dir)).isDirectory() } catch { return false }
}

const withDefaults = (deps = {}) => ({
  loadRegistry: defaultLoadRegistry,
  readStowMeta: defaultReadStowMeta,
  writeStowMeta: defaultWriteStowMeta,
  exists: defaultExists,
  ...deps,
})

/**
 * Role of one checkout. Making it `primary` first demotes every other manual
 * primary of the project back to a derived role, keeping one primary.
 * `null` (= automatic) removes the manual role only where a `.stow` file has one.
 */
export async function setLocationRole({ directory, role }, deps) {
  const d = withDefaults(deps)
  const registry = await d.loadRegistry()
  const project = registry.projects.find(p => p.locations.some(l => l.directory === directory))
  if (!project) throw new Error(`${directory} is not a location in the register`)
  if (!(await d.exists(directory))) throw new Error(`${directory} no longer exists on disk`)
  if (role === 'primary') {
    for (const l of project.locations) {
      if (l.directory === directory) continue
      const { meta } = await d.readStowMeta(l.directory)
      if (meta?.role === 'primary' && await d.exists(l.directory)) await d.writeStowMeta(l.directory, { role: null })
    }
  }
  if (role === null) {
    const { meta } = await d.readStowMeta(directory)
    if (meta?.role) await d.writeStowMeta(directory, { role: null })
    return
  }
  await d.writeStowMeta(directory, { role })
}

/**
 * Client of a whole project: written to every checkout that still exists, so
 * it survives a change of primary. `null` (= automatic) removes the manual
 * client only where a `.stow` file has one — no files are created for it.
 */
export async function setProjectClient({ projectId, client }, deps) {
  const d = withDefaults(deps)
  const registry = await d.loadRegistry()
  const project = registry.projects.find(p => p.key === projectId)
  if (!project) throw new Error(`unknown project ${projectId}`)
  for (const l of project.locations) {
    if (!(await d.exists(l.directory))) continue
    if (client === null) {
      const { meta } = await d.readStowMeta(l.directory)
      if (meta?.client) await d.writeStowMeta(l.directory, { client: null })
    } else {
      await d.writeStowMeta(l.directory, { client })
    }
  }
}
