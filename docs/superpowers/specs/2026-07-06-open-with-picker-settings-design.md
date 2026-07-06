# Open-With Pickers + Settings Dialog — Design

**Date:** 2026-07-06
**Status:** Approved (user decisions collected 2026-07-05)
**Goal:** The details sheet's "Open in IDE" and "Open in Terminal" buttons become split buttons with an app picker (VS Code/Cursor/Zed…, Terminal/Warp/cmux…); the available app lists are configurable in a new header settings dialog; the default is the last-used choice.

## Context

Today `POST /api/open-with` opens a project with a single fixed app per type,
read from env at request time (`src/app/api/open-with/route.js:7-8`):
`IDE_COMMAND` (shell command, `code -n "<dir>"`) and `TERMINAL_APP`
(`open -a "<app>" <dir>`). The details sheet has plain buttons
(`openWith('ide'|'terminal'|'finder')`, `ProjectDetailsSheet.js:185-197`).
`/api/settings` (GET/POST) already reads/writes whitelisted keys in
`.env.local` (`SETTINGS_KEYS = ['SCAN_ROOTS','BASE_DIR','TERMINAL_APP','IDE_COMMAND']`);
its only UI today is the WelcomeScreen. The sheet already uses the shadcn
DropdownMenu pattern for the Run-script button.

## Decisions (user-confirmed)

1. **Settings dialog in the header** (gear icon) — edits the lists (and the
   existing SCAN_ROOTS/BASE_DIR) via the existing `/api/settings` API.
2. **Split buttons**: clicking the main area opens with the **last-used** app
   (button shows which); a chevron next to it opens the picker menu.
   Last-used is per-browser, stored in localStorage — for both IDE and
   terminal independently.

## Design

### Config model

Two new env keys (comma-separated, order = menu order):

```bash
IDE_COMMANDS=code,cursor,zed          # CLI commands, invoked as `<cmd> -n "<dir>"`
TERMINAL_APPS=Terminal,Warp,cmux      # macOS app names, invoked as `open -a "<app>" "<dir>"`
```

- Backward compatibility: if `IDE_COMMANDS`/`TERMINAL_APPS` are absent, fall
  back to a one-item list derived from the legacy `IDE_COMMAND`/`TERMINAL_APP`
  (which stay supported and untouched). MCP `open_project` and any other
  callers of `/api/open-with` without an app override keep today's behavior
  (legacy single value = first item of the list).
- `SETTINGS_KEYS` in `/api/settings` gains the two new keys.

### API

`POST /api/open-with` accepts an optional `app` field:
`{ directory, type: 'ide'|'terminal'|'finder', app?: string }`.

- **Server-side validation (security):** `app` must be an exact member of the
  configured list for its type (IDE_COMMANDS for `ide`, TERMINAL_APPS for
  `terminal`); otherwise 400. Never interpolate a client-supplied string into
  a shell command that isn't in the allowlist. Without `app`, use the first
  configured entry (legacy behavior).
- `GET /api/open-with` (new) returns the configured lists:
  `{ ide: string[], terminal: string[] }` — the sheet uses this to render the
  pickers (no hardcoded lists in the client).

### Details sheet UI (`ProjectDetailsSheet.js`)

For IDE and Terminal each: a split button —

- main segment: icon + current app name (last-used, else first configured);
  click = `openWith(type, currentApp)`
- chevron segment: DropdownMenu listing the configured apps; selecting one
  opens the project with it AND persists it as last-used
- last-used persisted in localStorage keys `stow-dashboard-open-ide` /
  `stow-dashboard-open-terminal`; validated against the configured list on
  load (falls back to first entry if it was removed from settings)
- Finder button unchanged.

### Settings dialog

- New `src/components/SettingsDialog.js` (client, shadcn Dialog + Button +
  inputs), opened from a gear icon rendered next to ScanControls in the header.
- Fields: SCAN_ROOTS, BASE_DIR (existing), IDE_COMMANDS, TERMINAL_APPS
  (comma-separated text inputs with helper text and the legacy single-value
  keys shown read-only or omitted — new lists take precedence).
- Load via `GET /api/settings`, save via `POST /api/settings`; note shown to
  the user that env changes apply to new requests immediately (the API reads
  `process.env` at module load — see Risks).

## Risks / notes

- **Env reload:** `open-with/route.js` currently reads env into module-level
  consts — after a settings save, new lists must apply without a server
  restart. Fix: read env inside the request handler (cheap), or read the
  values from `.env.local` via the settings helpers. The design mandates
  per-request reads for the four affected keys.
- **`.env.local` propagation to the desktop app:** the Deno shell seeds
  `.env.local` into `~/Library/Application Support/StowDashboardDeno` on first
  run only; settings saved from the desktop app write to the app-data copy
  (cwd) — consistent. Settings saved in the dev/web instance edit the repo's
  `.env.local`. These are two separate stores — document in the dialog's
  helper text which file is being edited (derive from `process.cwd()`).
- cmux may not be a standard `open -a`-able app bundle — the user listed it;
  if `open -a cmux` fails it surfaces as the API's existing error path (500
  with message). No special-casing in v1.

## Testing

- Unit (node --test): list parsing + fallback (IDE_COMMANDS absent → legacy
  IDE_COMMAND; empty strings filtered; whitespace trimmed) and the allowlist
  validation helper (member → ok, non-member → rejected) — extracted into
  `src/lib/open-with.mjs` so they're testable without the route.
- Manual: split-button opens last-used; picker switches and persists across
  reload; settings dialog round-trip (save → GET shows new values → picker
  lists update); invalid `app` via curl → 400; MCP `open_project` still works.

## Out of scope (YAGNI)

- Per-project app preferences.
- Auto-detecting installed IDEs/terminals.
- Migrating WelcomeScreen to the new dialog (it keeps working as-is).
