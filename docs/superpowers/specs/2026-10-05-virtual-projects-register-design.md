# Virtual projects 1/6 — model and register (Client → Project → Locations)

Issue #8 (TRI-STOW-0008). Foundation for #9–#14 (label `virtual-projects`).

## Goal

Today one row in `projects_metadata.jsonl` = one directory. The same repo
checked out four times (`intelimail/blog` as `blog`, `blog-huha`, `blog-test`,
`blog-volaco`) shows up as four unrelated projects, and nothing says which
client a project belongs to. This issue adds a **virtual layer** over the
directories:

```
Client ──< Project ──< Location (a checkout on disk)
```

Nothing on disk moves. The layer is computed from the ledger plus a small
amount of explicit state.

Measured on the live ledger (2026-10-05): ~1240 rows, 416 without a remote,
10 with two remotes, `ai_analysis.client` set on ~440 rows with spelling
variants (`Intelimail`/`InteliMail`, `new:Archon`, `boys-from-heaven`/
`Boys from Heaven`), remote URLs with embedded credentials
(`https://user:token@gitlab.com/...`) and proxy prefixes
(`https://github.91chi.fun/https://github.com/...`).

## Scope

In scope (this issue):

- **Identity**: normalising remote URLs into a project key.
- **`.stow/project.json`**: format, validation, read/write helpers, ID generation,
  and keeping the file out of `git status`.
- **Client resolution**: the priority chain and name normalisation.
- **Register config**: `data/registry.json` (client display names + aliases).
- **`buildRegistry()`**: a pure function that turns ledger rows plus metas
  plus config into clients → projects → locations, with roles.
- **`npm run registry`**: a read-only CLI that prints the register summary so
  the model can be checked against real data.

Out of scope (sibling issues): wiring into the scanner, writing IDs for every
project that has no remote, moved-folder detection, collapsing subdirectories
of one repo (#9); UI (#10); reorg (#11); sessions `project_key` (#12–#13);
agent-office export (#14).

## Identity

`normalizeRemote(url)` returns a canonical `host/path` or `null`:

- Accepts scp form (`git@host:owner/repo.git`), `ssh://`, `git://`,
  `http(s)://` (with optional port).
- Drops the userinfo (credentials never reach the key), the port, a leading
  `www.`, a trailing `.git` and trailing slashes. Lowercases the result
  (GitHub/GitLab/Bitbucket paths are case-insensitive).
- Unwraps a proxy prefix: when the path itself contains `http(s)://`, the
  embedded URL is normalised instead.
- Local paths and `file://` remotes return `null`, so they are treated as
  having no remote.

Project key:

| Case | Key | `kind` |
|------|-----|--------|
| Hosted remote | `git:<host/path>` e.g. `git:gitlab.com/intelimail/blog` | `git` |
| No remote, `.stow/project.json` has an `id` | `stow:<id>` | `stow` |
| Neither | `path:<directory>` (unstable until #9 writes an ID) | `path` |

With several remotes, the **first one that normalises** in `git_info.remotes` is used (a local-path remote is skipped). The
scanner currently stores only URLs, in `git remote` order (alphabetical by
remote name), so "first" is not necessarily `origin`. Open question in the PR.

A `stow` ID in `.stow/project.json` never overrides a remote: the issue makes
the remote URL the identity. The location still records its `stow_id`, so
#12 can map an old `stow:` key to the new `git:` key if a project later
gains a remote.

## `.stow/project.json`

One file per checkout, at `<dir>/.stow/project.json`:

```json
{ "version": 1, "id": "p_7f3k9q2m4x1c", "client": "Intelimail", "role": "primary" }
```

- `id`: `p_` followed by 12 lowercase base32 characters (crypto random). Required
  when the file exists, so that a file always identifies its folder.
- `client` (optional): a manual client override, by display name.
- `role` (optional): one of `primary | deploy | experiment | stale`.
- Unknown keys are preserved on write. An invalid `client` or `role` is ignored
  with a warning; a malformed file reads as "no meta" and is never overwritten
  silently.

API (`src/lib/registry/stow-meta.mjs`): `newProjectId()`,
`parseStowMeta(text)`, `readStowMeta(dir)`, `writeStowMeta(dir, patch, {exec})`.

`writeStowMeta` merges the patch into the existing file (creating `id` if
missing), writes atomically (tmp + rename), and, when the directory is a git
working tree, adds `/.stow/` to that repo's `info/exclude`. The path comes
from `git rev-parse --git-path info/exclude` through an injectable exec, so
worktrees and submodules resolve correctly. Without that step, writing the
file would make the Uncommitted column and quick filter count every
registered repo as dirty. Whether `.stow/` should be committed instead is an
open question in the PR.

## Client resolution

Client key = `clientKey(name)`: lowercase, strip the `new:` prefix (the AI's
"proposed new client" marker), drop everything that isn't a letter or digit. So
`Boys from Heaven`, `boys-from-heaven` and `boysfromheaven` are one client,
and so are `Intelimail` and `InteliMail`.

Per project, the first source that yields a client wins (`client_source`):

1. `manual`: `client` in any location's `.stow/project.json`, primary location first.
2. `ai`: non-empty `ai_analysis.client`, primary location first.
3. `owner`: the remote's top-level owner/group (`gitlab.com/intelimail/llm/x` gives
   `intelimail`), **only if it matches a known client**. Personal accounts
   (`erikmeliska`) and third-party owners (`joweich`) would otherwise each
   become a client.
4. `path`: a `_Bizz/<Client>/` segment in a location's path, primary first.

Known clients = `registry.json` clients (names + aliases) ∪ `_Bizz/<X>`
folder names seen in the ledger ∪ every manual/AI client name. Aliases map
other spellings onto a client (`{ "name": "TriSoft", "aliases": ["tri-soft",
"triv-calc"] }`) and are matched by the same key.

Display name for a client key: `registry.json` name, then the `_Bizz` folder
spelling, then the most frequent spelling seen. A project with no client goes
to **Unassigned** (`client: null`).

## Roles

Each location has `role` and `role_source` (`manual` or `derived`).

- A manual `role` from `.stow/project.json` always wins.
- **Primary**: the manual primary if there is one. If several locations are
  marked primary, the most recently active wins and the project gets a
  `multiple-primary` warning. Otherwise the location with the latest
  activity (`last_code_modified`, then `last_modified`) is primary; on a tie,
  the shortest path wins. A single location is always primary.
- Other locations, derived from the folder name and activity:
  `deploy` when the basename has a `prod|production|deploy|live` token;
  `stale` when it has an `old|backup|bak|archive` token or no activity for
  180 days; otherwise `experiment`.

## Register config — `data/registry.json`

```json
{ "version": 1, "clients": [ { "name": "TriSoft", "aliases": ["tri-soft"] } ] }
```

Read through `dataFile('registry.json')` at call time. A missing file means
an empty config. This file holds only client-level data. Per-checkout facts
live in `.stow/project.json` so that they travel with the folder.

## `buildRegistry(records, { metas, config, now })`

`buildRegistry` is pure: no filesystem access, so it is cheap to test. `metas`
is a `Map<directory, meta>`. It returns:

```js
{
  clients:  [{ id, name, projects: [projectKey] }],   // sorted by name
  projects: [{
    key, kind, name, remote, client: { id, name, source } | null,
    primary,                       // directory
    locations: [{ directory, record_id, stow_id, role, role_source, last_activity }],
    warnings: [],
  }],
  stats: { records, projects, multi_location, locations_in_multi, unassigned, by_kind, by_client_source },
}
```

Project `name`: the last segment of the remote path for `git`, otherwise the
primary record's `project_name`. Projects are sorted by client name, then
project name.

`loadRegistry({ base, readMeta })` is the I/O wrapper. It reads the ledger,
the config and each location's meta, then calls `buildRegistry`. The CLI uses
it; #9 and #10 will too.

## Errors

- A malformed `.stow/project.json` produces a warning on the location and is
  treated as no meta.
- A malformed `registry.json` throws; config mistakes should be loud.
- A missing ledger yields an empty register.

## Testing

Colocated `*.test.mjs` with `node --test`:

- URL normalisation: the shapes found in the live ledger, credentials,
  proxy prefix, local paths.
- Meta parse/validate, plus a read/write round trip on a `mkdtemp` dir, with a
  fake exec for the git exclude step (idempotent, no duplicate lines).
- The client chain and every source.
- Role derivation.
- `buildRegistry` on fixtures shaped like the blog 4× case.
