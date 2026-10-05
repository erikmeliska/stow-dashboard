# Virtual projects (#14): register export for agent-office (design)

Issue: #14 (TRI-STOW-0014). Series: #8–#14, label `virtual-projects`.
Depends on:

- **#8**: register model (`buildRegistry` / `loadRegistry`), PR #17. **Not merged yet.**
- **#9**: merged checkouts, so locations are checkout roots and sub-folders are no longer separate locations. Design and plan only, PR #16. **Not merged yet.**

This design is written against the model those two describe. See "Contract assumed from #8/#9" at the end.

## Goal

Agent Office (the 3D office the workers sit in) has a **building** with **floors**, and each floor is one project checkout. Today a floor is added by hand from the elevator, by picking a GitHub repo, and the office has no idea which client a project belongs to.

The consultation on 2026-10-05 settled on the model **building = client, floor = project**. Stow already knows (after #8/#9) every client, every project of that client, where the main checkout lives on disk and which remote it has. This issue exports that knowledge into one file that agent-office can read, so a client's building can be populated without picking repos by hand.

Stow's side is **export only**. Reading the file, creating buildings and placing floors happens in agent-office, a separate repo, and is out of scope here.

## What agent-office needs (read from agent-office v0.1.206)

A floor definition in agent-office is:

```js
{ id, name, repo, dir, palette, addedBy, addedAt }
```

- `id` must match `^[a-z0-9-]{1,40}$` and be unique within the building.
- `repo` is `owner/name` and must be on **GitHub** (`normalizeRepo` accepts only github.com). It is optional: a floor can be a local checkout with no repo (`ensureLocal`).
- `dir` must be an absolute path to an existing checkout.
- `MAX_FLOORS = 16` per building.
- `palette` is assigned by agent-office, so stow does not send it.

Whatever the export contains has to map onto that without guessing.

## Dry run on the live register (2026-10-05)

The builder from the plan, run over PR #17's `loadRegistry` (before #9, so sub-folders of one repo are still separate locations):

- default: **23 buildings, 375 floors**; with unassigned: 24 buildings, 775 floors; 0 skipped
- **3 buildings exceed agent-office's 16 floors**: Intelimail 176, TriSoft 77, boys-from-heaven 55 (open question 2)
- only **49 of 375 floors have a GitHub `repo`**; the rest are GitLab/Bitbucket or local, and agent-office can open them only by `dir` (open question 1)
- several one-floor "clients" are AI noise from #8 (`client`, `google`, `mrbeast`, `psf`). That is #8's open question 4, and the export inherits whatever #8 decides
- no credentials in the output (the only `@` is npm-scoped project names such as `@idea-council/core`)

## Output

A single JSON file `data/agent-office.json`, resolved with `dataFile('agent-office.json')` at call time (state-dir rule from CLAUDE.md). The same document is served by `GET /api/registry/agent-office`, so agent-office can either read the file or fetch it from the running dashboard.

```json
{
  "format": "stow-dashboard/agent-office",
  "version": 1,
  "generated_at": "2026-10-05T18:00:00.000Z",
  "buildings": [
    {
      "id": "intelimail",
      "name": "Intelimail",
      "floors": [
        {
          "id": "blog-3f9a1c",
          "name": "blog",
          "project_key": "git:gitlab.com/intelimail/blog",
          "dir": "/Users/ericsko/Projekty/_Bizz/Intelimail/blog",
          "repo": null,
          "remote": "gitlab.com/intelimail/blog",
          "last_activity": "2026-10-04T12:31:00.000Z",
          "locations": [
            { "dir": "/Users/ericsko/Projekty/_Bizz/Intelimail/blog",        "role": "primary" },
            { "dir": "/Users/ericsko/Projekty/_Bizz/Intelimail/blog-huha",   "role": "experiment" },
            { "dir": "/Users/ericsko/Projekty/_Bizz/Intelimail/blog-test",   "role": "experiment" },
            { "dir": "/Users/ericsko/Projekty/_Bizz/Intelimail/blog-volaco", "role": "stale" }
          ]
        }
      ]
    }
  ],
  "skipped": [
    { "project_key": "path:/Users/…/old-thing", "reason": "no-location" }
  ],
  "stats": { "buildings": 12, "floors": 140, "skipped": 3 }
}
```

### Buildings

- One building per register client (`registry.clients`), in the register's order (by name).
- `id` = the client's `id` from #8 (`clientKey`: lowercase letters and digits, which is already safe as an id). `name` = the client's display name.
- Projects with no client go into a building `{ "id": "unassigned", "name": "Unassigned" }`, only with `--include-unassigned` / `?unassigned=1`. They are off by default: on today's data there are about 400 unassigned projects, which is noise for an office.
- A client with no exportable floors is left out.

### Floors

One floor per register project. A project with several checkouts is **one** floor (the whole point of #9), and its other checkouts are listed in `locations` so agent-office can show them or offer them for worktrees later.

| Field | Source |
|---|---|
| `id` | `<slug(name)>-<first 6 hex of sha1(project_key)>`, cut to 40 chars. Stable across exports and moves (the key doesn't change when a folder moves, #9), unique even when two clients both have a `web`. |
| `name` | project `name` from #8 |
| `project_key` | project `key` from #8 (`git:…`, `stow:…`, `path:…`). The join key for #12's sessions `project_key`. |
| `dir` | the project's **primary** location (#8 `primary`), unless it is a worktree (see below) |
| `repo` | `owner/name` when the remote host is `github.com`, otherwise `null` |
| `remote` | #8's normalized remote (`host/path`, credentials already removed), or `null` |
| `last_activity` | max `last_activity` over the locations, as an ISO string, or `null` |
| `locations` | `{dir, role}` for every location that exists on disk, primary first, worktrees left out |

Floors inside a building are sorted by `last_activity` descending (most active first), then by `name`. Agent-office caps a building at 16 floors, and this order makes "take the first 16" the useful cut. The export does **not** truncate: it is a register, not a UI, and the cap belongs to agent-office (open question 2).

### Worktrees are never floors or locations

Agent-office's own worker worktrees (`.agent-office/worktrees/<slug>`), Claude Code's (`.claude/worktrees/<name>`) and any linked `git worktree` are, per #9, checkouts of their own. Exporting them would make a worker's temporary worktree the primary floor of a project, or list dozens of locations that disappear every day. The export drops a location when:

- its path contains `/.agent-office/worktrees/` or `/.claude/worktrees/`, or
- the ledger row says it is a linked worktree. #9 records `checkout.root`, and #12 plans the same `git rev-parse --git-common-dir` test. Until #12 lands, the export uses the two path patterns only.

If the primary itself is dropped, the most recently active remaining location becomes `dir`. A project with no remaining location goes to `skipped` with `reason: "no-location"`.

### Missing directories

A location whose directory no longer exists (a moved or deleted folder that the last scan hasn't caught up with yet) is dropped. The check is an injectable `exists(dir)`, defaulting to `fs.existsSync`. `dir` must be a checkout that agent-office can actually open.

### Determinism

Everything except `generated_at` is a pure function of the register, so two exports of an unchanged register are byte-identical apart from that line, and the file diffs cleanly. The file is written atomically (tmp + rename), like `.stow/project.json` in #8.

### What is never exported

- Credentials: only #8's normalized remote is used, never `git_info.remotes`.
- Ledger internals (`git_info`, `scc`, `ai_analysis`, sizes, usage $). Agent-office can ask the stow MCP server for those.

## Interfaces

- `src/lib/registry/agent-office-export.mjs`
  - `buildAgentOfficeExport(registry, { now, includeUnassigned = false, client, exists }) → doc`. Pure apart from `exists`. `client` limits the export to one client id or name, matched with #8's `clientKey`.
  - `floorId(name, key) → string`
  - `isWorktreePath(dir) → boolean`
  - `githubRepo(remote) → 'owner/name' | null`
  - `exportAgentOffice({ base, includeUnassigned, client, write = true, now }) → { doc, file }`. I/O wrapper: `loadRegistry({ base })` → build → atomic write to `dataFile('agent-office.json', { base })`.
- `scripts/registry-export.mjs`, run as `npm run registry:export [-- --unassigned] [--client <name>] [--stdout]`. `--stdout` prints the doc instead of writing the file.
- `src/app/api/registry/agent-office/route.js`: `GET` builds the doc on request (`?unassigned=1`, `?client=`) and returns it. It does not write the file, so a GET has no side effects. Paths are resolved per request, not at module eval.

No MCP tool and no UI button in this issue. Both are cheap to add later, but neither is asked for (open question 4).

## When the file is refreshed

Only on demand: the CLI, or the route (which doesn't write). The refresh cycle and the full scan don't touch it. The register changes rarely, and writing a file that another app watches every 60 s would be churn. Open question 3 asks whether the full scan should write it at the end.

## Error handling

- Missing ledger → #8 returns an empty register → `buildings: []`, and the file is still written (agent-office sees "nothing yet", not a stale file).
- Malformed `registry.json` → #8 throws. The CLI exits 1 with the message, and the route returns 500 `{error}`.
- `--client` that matches nothing → exit 1 / 404, so a typo isn't silently an empty building.
- Write failure → the CLI exits 1. The previous file stays intact thanks to the atomic rename.

## Testing

Colocated `src/lib/registry/agent-office-export.test.mjs`, `node --test`, with fixture registries shaped like #8's output (no filesystem, `exists` injected):

- blog 4×: one floor, four locations, primary first, `repo: null` for gitlab
- GitHub remote → `repo: "owner/name"`; ssh form and mixed case; a non-GitHub host → `null`
- floor id: stable, slug-safe (`^[a-z0-9-]{1,40}$`) for names with spaces, diacritics and dots, different for two `web` projects
- worktree primary → falls back to the next location; only worktrees → `skipped`
- missing directory dropped; all missing → `skipped`
- unassigned excluded by default, included with the flag
- `client` filter by display name and by a spelling variant (`InteliMail` → `intelimail`); unknown → error
- ordering by `last_activity`, `null` last; determinism (two builds with the same `now` are deep-equal)
- `exportAgentOffice` writes atomically into a `mkdtemp` state dir (`STOW_STATE_DIR` via `base`) and doesn't leave a `.tmp` behind

## Contract assumed from #8/#9

If #8 lands with different names, only the import lines and the field mapping in `agent-office-export.mjs` change.

| Need | Assumed (PR #17 as of 2026-10-05) |
|---|---|
| Register | `loadRegistry({ base }) → { clients:[{id,name,projects:[key]}], projects:[…], stats }` |
| Project | `{ key, kind, name, remote, client:{id,name,source}|null, primary, locations:[{directory, role, role_source, last_activity, …}], warnings }` |
| Client id | `clientKey(name)` exported from `src/lib/registry/client.mjs` |
| Locations | after #9: checkout roots only, never sub-folders of one repo |
| `last_activity` | a timestamp `Date` accepts (ms or ISO) |
