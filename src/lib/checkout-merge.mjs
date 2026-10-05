/**
 * Virtual projects, step 2 (#9): stamp every scanned ledger row with the
 * project it belongs to. Identity is #8's, decided once per checkout by
 * `checkoutIdentities` (normalised remote → `.stow` id at the stow home →
 * `path:<checkout root>`), so the stored
 * `row.identity` / `row.project_id` always agree with the register view
 * (`buildRegistry`), which groups rows by the same key and their checkouts
 * by `row.checkout.root`. Pure — git lives in checkout-location.mjs, the
 * `.stow` file in stow-project-file.mjs.
 */
import { checkoutIdentities, locationOf, stowHomeOf } from './registry/identity.mjs'

/**
 * Stow homes (checkout root, or the main work tree of a linked worktree)
 * that need a `.stow` id: checkouts with no member remote that normalises.
 * `dirty` = some member has uncommitted changes (worth re-checking that
 * `.stow/` is in info/exclude). → Map<home, { git, dirty }>, first-seen order.
 */
export function stowRoots(rows) {
    const identities = checkoutIdentities(rows)
    const homes = new Map()
    for (const r of rows) {
        if (identities.get(locationOf(r))?.kind === 'git') continue
        const home = stowHomeOf(r)
        const h = homes.get(home) ?? homes.set(home, { git: false, dirty: false }).get(home)
        if (r.checkout?.git) h.git = true
        if (r.git_info?.uncommitted_changes > 0) h.dirty = true
    }
    return homes
}

/**
 * Sets `identity: { key, kind }` and `project_id` (= the register key) on
 * every row — one identity per checkout, decided like `buildRegistry` does.
 */
export function assignIdentities(rows, stowIdByHome = new Map()) {
    const identities = checkoutIdentities(rows, home => {
        const id = stowIdByHome.get(home)
        return id ? { id } : null
    })
    for (const r of rows) {
        const { key, kind } = identities.get(locationOf(r))
        r.identity = { key, kind }
        r.project_id = key
    }
}

/**
 * Ledger rows are keyed by directory, so after a move the new rows are freshly
 * extracted and would lose their AI analysis. A row without ai_analysis
 * inherits ai_analysis/ai_derived from a vanished prior row — not among
 * `rows`, or gone from disk per `exists` (the quick refresh keeps stale rows
 * in its list) — with the same identity and checkout subpath. Each donor is
 * used once. → [{ from, to, key }]
 */
export function carryForwardMoved(rows, priorRows, { exists = () => true } = {}) {
    const present = new Set(rows.map(r => r.directory))
    const slot = r => `${r.identity.key}\0${r.checkout?.subpath ?? ''}`
    const donors = new Map()
    for (const p of priorRows) {
        if (!p.identity?.key || !p.ai_analysis) continue
        if (present.has(p.directory) && exists(p.directory)) continue
        const k = slot(p)
        if (!donors.has(k)) donors.set(k, p)
    }
    const moved = []
    for (const r of rows) {
        if (r.ai_analysis || !r.identity?.key) continue
        const donor = donors.get(slot(r))
        if (!donor || donor.directory === r.directory) continue
        donors.delete(slot(r))
        r.ai_analysis = donor.ai_analysis
        if (donor.ai_derived) r.ai_derived = donor.ai_derived
        moved.push({ from: donor.directory, to: r.directory, key: r.identity.key })
    }
    return moved
}
