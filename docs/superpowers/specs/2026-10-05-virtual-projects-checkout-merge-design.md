# Virtuálne projekty 2/6 — scanner: zlúčenie checkoutov podľa identity (design)

Issue: #9 (TRI-STOW-0009). Series: #8–#14, label `virtual-projects`.
Depends on: **#8** (register model, project identity, `.stow/project.json`) — **not merged yet**.
This design is written against the model #8 *describes*; see "Contract assumed from #8".

## Goal

After a scan, every ledger row knows **which project it belongs to and in which checkout it sits**, so:

1. Several checkouts of one repository (`intelimail/blog`, `blog-huha`, `blog-test`, `blog-volaco`) become **one project with four locations** in the register.
2. Sub-folders inside one repository (btstack 49×, awesome-llm-apps 37×, helicone 34×) are **members of one checkout**, not duplicates.
3. Projects without a remote get a stable ID persisted in `<checkout>/.stow/project.json`. The scanner reads it, and writes it when it is missing.
4. A moved folder is recognised **by identity, not by path**: the register location is updated in place (role, primary, client stay) and per-row AI data follows the move.

The disk is never reorganised. This is a virtual layer over directories (#8).

Out of scope here: UI (#10), reorg report and physical moves (#11), sessions `project_key` / worktree mapping (#12/#13), agent-office export (#14), and the client-derivation rules themselves (#8).

## What the live data says (ledger 2026-10-05, 1238 rows)

| Grouping | Groups with >1 row | Rows |
|---|---|---|
| by normalized first remote | 103 | — |
| …of which rows that are sub-folders of another row in the group | — | **415** |
| by remote **and** git toplevel (approximated by path ancestry) | **34 repos** | 82 checkouts |
| git, no remote | — | 141 |
| no git | — | 275 |
| rows with >1 remote | — | 10 |

Path ancestry alone is **not** a correct proxy for "same checkout". `_Bizz/Innovis/eranet3-analyza` is a weak-only group, so it has no ledger row of its own. Its sub-folders `eranet2/ZFK`, `eranet2/security`, `prechod-do-vyvoja`, … would look like 5 checkouts, but they are one. The scanner therefore has to ask git for the real work-tree root: `git rev-parse --show-toplevel`.

## Concepts

- **Location / checkout root**: the directory one checkout lives in.
  - git: `git rev-parse --show-toplevel` (a linked `git worktree` or a submodule has its own toplevel, so each is its own checkout)
  - no git: the row's own `directory`
- **Member row**: a ledger row whose `directory` is inside a checkout root. `subpath` is `''` for the root itself, and e.g. `example/` for btstack's sub-folder. One checkout can have many member rows, and its root does not need to be a ledger row (eranet3).
- **Identity**: what makes two checkouts "the same project".
  1. `remote:<normalized url>` — the remote named `origin`, else the alphabetically first remote, normalized by #8's normaliser
  2. `stow:<id>` — `id` from `<checkout root>/.stow/project.json`
  3. `path:<checkout root>` — fallback only, when the file cannot be written (read-only dir, opt-out). Not stable across moves.
- **Project** (register, #8): `{ id, identity, …, locations: [{ directory: <checkout root>, role, primary }] }`. Locations are **checkout roots**, never sub-folders.

## Ledger row additions

Two top-level fields on every row in `projects_metadata.jsonl`. They are deliberately not inside `git_info`: the refresh cycle and `refreshProjectGit` replace `git_info` wholesale, and these fields must survive that.

```json
"checkout": { "root": "/Users/…/Intelimail/blog-huha", "subpath": "", "git": true },
"identity": { "key": "remote:gitlab.com/intelimail/blog", "source": "remote" },
"project_id": "<register project id>"
```

`project_id` is filled by the reconcile step. #10/#12 join on it.

## Flow (full scan)

```
discoverProjects → processProject (unchanged)
      ↓ scannedRows
resolveLocations(rows)            per row, only when `checkout` is missing or the row was re-extracted;
                                  2 git spawns, 16 concurrent; non-git: 0 spawns
      ↓
ensureStowFiles(locations)        for checkout roots with no remote identity: read .stow/project.json,
                                  create it if missing (+ add `.stow/` to the repo's info/exclude)
      ↓
carryForwardMoved(rows, priorRows)  per-row ai_analysis/ai_derived follow a move (same identity+subpath)
      ↓
reconcileRegister(register, rows)   group by identity → checkouts; update locations, detect moves,
                                  create projects for new identities; set row.project_id
      ↓
syncMetadata(rows) + saveRegister   (shrink guard unchanged)
```

The quick refresh (`/api/scan/quick`) runs `resolveLocations` + `ensureStowFiles` + `reconcileRegister` only when it auto-discovered at least one project in that cycle. Otherwise nothing changes, and the cycle stays at its 5–6 s.

## Move detection (`reconcileRegister`, pure)

Inputs: the register, the scanned rows (grouped into `identity → Set<checkout root>`), and `exists(dir)`.

For each identity:

- **Kept**: a prior location whose root is still seen. Its role and primary are untouched.
- **Vanished**: a prior location not seen this scan *and* `!exists(root)`. A location that still exists but was not seen (outside `SCAN_ROOTS`, ignored path) is kept. The scanner only reports what it saw.
- **Appeared**: a root seen now that is not in the prior locations.
- **Pairing vanished ↔ appeared = a move.** The location's `directory` is rewritten, and role, primary and any per-location fields are kept:
  - exactly one vanished and one appeared → pair them
  - otherwise pair by equal basename, then by equal `git_info.head_sha` of the root (or of the first member row)
  - leftovers: a vanished location is dropped and an appeared one is added with #8's default role
- An identity with no register project → a new project via #8's constructor (client derivation is #8's).
- A project whose locations all vanished stays in the register with `locations: []`. Manual client and role overrides are not lost; cleanup is #11's job.

The `stow:` id makes moves of no-remote projects unambiguous. Moves of remote projects are inherently heuristic when several checkouts move in one scan. The pairing order above handles the common case of renaming one folder.

**A copied folder** (`cp -r` of a no-remote project) carries the same `.stow` id → **two locations of one project**, the same as two clones of one remote. The scanner never rewrites an existing id. (Open question Q3.)

## Per-row carry-forward on move

Ledger rows are keyed by `directory`. After a move, the new rows are freshly extracted and would lose `ai_analysis` / `ai_derived`, which means an expensive re-analysis. `carryForwardMoved` handles this. A row that:

- is new (its directory was not in the prior ledger) and has no `ai_analysis`, and
- has a prior row with the same `identity.key` and `checkout.subpath` whose directory is gone from this scan

inherits that prior row's `ai_analysis` and `ai_derived`. `analyze-batch`'s `input_hash` still decides whether it re-runs.

## `.stow/project.json` I/O

- Schema and id generator are #8's: `{ id, client?, role? }`. The scanner only **creates** the file when it is missing (`{ id }`), and reads `id`. It never edits `client` or `role`; those are written by #10's UI through #8's API.
- Written only at **checkout roots without a remote identity** (~141 git-no-remote + ~275 non-git roots on today's data). Remote projects need no file.
- When the root is a git work tree, `/.stow/` is appended to `$(git rev-parse --git-path info/exclude)` if absent. That keeps the file out of `git status`; otherwise every no-remote repo would gain +1 in the Uncommitted column. (Open question Q2: commit the file instead?)
- `.stow` is added to `DEFAULT_IGNORE_PATTERNS`, so writing the file does not bump `last_modified` and trigger a re-extraction or AI re-analysis on the next scan.
- Opt-out: `STOW_WRITE_PROJECT_FILES=0` in `.env.local` → nothing is written, and no-remote checkouts fall back to `path:` identity. (Open question Q1.)
- Failures (EACCES, read-only volume) → `path:` identity plus a `stow_file_error` progress event. The scan never fails because of this.
- Malformed JSON or a missing `id` in an existing file → treated as absent for identity (`path:`) and **not overwritten**, with a progress event. The user's file wins.

## Error handling

- `git rev-parse` fails (corrupt repo, safe.directory refusal) → treated as non-git: `checkout.root = directory`, `git: false`.
- Register read or write failures follow #8's semantics. A failed register save must not block the ledger write (the ledger is the scan's primary output).
- All git and fs calls go through an injectable `exec` / `fs` so that tests never need git or a real home dir (repo convention). Tests that do need git create a temp repo with `mkdtemp`.

## Testing

Colocated `*.test.mjs`, `node --test`:

- `src/lib/checkout-location.test.mjs`: toplevel / subpath / remote choice (origin first, else sorted; multi-remote), non-git, git failure, injected exec.
- `src/lib/stow-project-file.test.mjs`: create when missing, read existing, malformed file untouched, `info/exclude` appended once, opt-out, EACCES fallback (temp dirs).
- `src/lib/checkout-merge.test.mjs`: btstack-shaped (49 rows, 1 checkout), blog-shaped (4 checkouts, 1 project), eranet-shaped (root not a row), rename move, two-of-three checkouts moved (pairing order), copied stow id, vanished-but-exists kept, all-vanished project kept, carry-forward.
- `src/scanner/index.test.mjs`: one end-to-end scan over a temp tree with two clones of a bare local repo, plus a no-remote dir → one project, two locations, a `.stow` file created, a second scan stable.

## Contract assumed from #8

#9 needs exactly these from #8. If #8 lands with different names, only the import lines in `checkout-merge.mjs` / `stow-project-file.mjs` change:

| Need | Assumed shape |
|---|---|
| Remote normaliser | `normalizeRemoteUrl(url) → string` (ssh/https/user@/`.git`/case folded to `host/path`) |
| `.stow` schema and id | `STOW_PROJECT_FILE = '.stow/project.json'`, `newProjectId() → string` |
| Register I/O | `loadRegister() / saveRegister(reg)` under the state dir (`dataFile(...)`) |
| Register shape | `{ projects: [{ id, identity, locations: [{ directory, role, primary }] , …}] }` |
| New project | `createProject({ identity, rows }) → project` (applies client derivation and default role) |

If #8 already implements `.stow/project.json` read and write, Task 2 of the plan shrinks to "call #8's API + add the `info/exclude` and ignore rules".
