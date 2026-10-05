/**
 * Virtual projects, step 2 (#9): stamp every scanned ledger row with the
 * project it belongs to. Identity is #8's `identityOf` (normalised remote →
 * `.stow` id at the checkout root → `path:<checkout root>`), so the stored
 * `row.identity` / `row.project_id` always agree with the register view
 * (`buildRegistry`), which groups rows by the same key and their checkouts
 * by `row.checkout.root`. Pure — git lives in checkout-location.mjs, the
 * `.stow` file in stow-project-file.mjs.
 */
import { identityOf, locationOf } from './registry/identity.mjs'

/**
 * Checkout roots that need a `.stow` id: no member row has a remote that
 * normalises. → Map<root, { git }>, in first-seen order.
 */
export function stowRoots(rows) {
    const roots = new Map()
    const remote = new Set()
    for (const r of rows) {
        const root = locationOf(r)
        if (identityOf(r, null).kind === 'git') remote.add(root)
        else if (!roots.has(root)) roots.set(root, { git: Boolean(r.checkout?.git) })
    }
    for (const root of remote) roots.delete(root)
    return roots
}

/** Sets `identity: { key, kind }` and `project_id` (= the register key) on every row. */
export function assignIdentities(rows, stowIdByRoot = new Map()) {
    for (const r of rows) {
        const id = stowIdByRoot.get(locationOf(r))
        const { key, kind } = identityOf(r, id ? { id } : null)
        r.identity = { key, kind }
        r.project_id = key
    }
}

/**
 * Ledger rows are keyed by directory, so after a move the new rows are freshly
 * extracted and would lose their AI analysis. A new row (directory not in the
 * prior ledger, no ai_analysis yet) inherits ai_analysis/ai_derived from a
 * vanished prior row with the same identity and checkout subpath. Each donor
 * is used once. → [{ from, to, key }]
 */
export function carryForwardMoved(rows, priorRows) {
    const present = new Set(rows.map(r => r.directory))
    const slot = r => `${r.identity.key}\0${r.checkout?.subpath ?? ''}`
    const donors = new Map()
    for (const p of priorRows) {
        if (present.has(p.directory) || !p.identity?.key || !p.ai_analysis) continue
        const k = slot(p)
        if (!donors.has(k)) donors.set(k, p)
    }
    const priorDirs = new Set(priorRows.map(p => p.directory))
    const moved = []
    for (const r of rows) {
        if (priorDirs.has(r.directory) || r.ai_analysis || !r.identity?.key) continue
        const donor = donors.get(slot(r))
        if (!donor) continue
        donors.delete(slot(r))
        r.ai_analysis = donor.ai_analysis
        if (donor.ai_derived) r.ai_derived = donor.ai_derived
        moved.push({ from: donor.directory, to: r.directory, key: r.identity.key })
    }
    return moved
}
