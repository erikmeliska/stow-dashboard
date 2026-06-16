# Phase 02 — Intent Skills Implementation Plan

> **For agentic workers:** Skills are markdown artifacts (authored directly, not TDD). The stow
> helper (Task D) is code → use TDD. The rollout (Task E) touches CLIENT repos → require human
> confirmation before writing.

**Goal:** Make per-project intent real: a `status-keeper` skill (the resume ritual) and a
`project-init` skill (bootstrap a project into the Command Center), then onboard the active
projects — especially Innovis repos that currently have no `CLAUDE.md`.

**Depends on:** Phase 01 (`get_status`/`set_status` MCP tools, shipped at `7fc053f`).

---

## Status

- [x] **A. `status-keeper` skill** — authored at `~/.agents/skills/status-keeper/SKILL.md`,
      symlinked into `~/.claude/skills/status-keeper`. Reads `NEXT` on session start; updates the
      single next step on pause/end via `set_status` (MCP) or direct file edit (preserving Links/Notes).
- [x] **B. `project-init` skill** — authored at `~/.agents/skills/project-init/SKILL.md`,
      symlinked. Interviews (client, stack, mode, packs) → writes `CLAUDE.md` + `STATUS.md` +
      `skills.manifest.json`, materializes `.claude/skills/` (symlink solo / vendored team), registers with stow.
- [x] **C. `skills.manifest.json` schema** — defined and exercised:
      `{ mode: "symlink"|"vendored", shared: [{name, source}], custom: [] }`.
- [x] **Dogfood** — ran `project-init` on stow-dashboard itself (solo/symlink, group TriSoft):
      created `STATUS.md`, `skills.manifest.json`, `.claude/skills/status-keeper` symlink, and a
      Command Center section in `CLAUDE.md`. Verified the merged `status` lib reads it back. Committed `a5839b0`.
      `.claude/skills/` is gitignored for this solo repo (symlinks regenerable from the manifest).

## Remaining

### Task D — `stow skills sync|eject` helper (code, TDD)
**Files:** Create `scripts/skills.mjs` + `scripts/skills.test.mjs`; wire a `skills` subcommand into `scripts/cli.mjs`.
**Behavior:**
- `stow skills sync [dir]` — read `<dir>/skills.manifest.json`; for each `shared[]` entry, materialize into `.claude/skills/<name>` per `mode` (symlink → `ln -sfn`; vendored → refresh copy and show a diff of what changed); never touch `custom[]` dirs. Idempotent.
- `stow skills eject <name> [dir]` — replace the `.claude/skills/<name>` symlink with a real copy and move the entry from `shared[]` to `custom[]` in the manifest.
**Tests (node:test, tmp dirs):** sync in symlink mode creates correct links; sync in vendored mode copies files; re-running sync is idempotent; eject converts a symlink to a real dir and updates the manifest; `custom[]` entries are never modified.
**Steps:** TDD each — write `skills.test.mjs` first (fail), implement `scripts/skills.mjs`, pass, wire the CLI subcommand, commit.

### Task E — Rollout to active projects (touches CLIENT repos — CONFIRM FIRST)
**Targets confirmed missing `CLAUDE.md`/`.claude`:** `_Bizz/Innovis/clm-backend`, `clm-ui`,
`pqq-backend`, `pqq-ui`. Candidates also: Intelimail apps (`new-admin`, `blog-ai`), other TriSoft repos.
**Mode for Innovis = `vendored` (TEAM):** someone other than the user runs Claude Code on these
repos, and symlinks to `~/.agents`/`~/Projekty` won't resolve for them — so the Innovis pack
(`_Bizz/Innovis/skills/claude-skills-src/.claude/skills`: app-foundation, authentication,
code-review, coding-conventions, deployment, security, testing, ui-design) plus `status-keeper`
must be **copied** into each repo's `.claude/skills/` and committed so they travel via `git clone`.
**Per repo:** run `project-init` non-interactively with client=Innovis, mode=vendored, pack=Innovis;
generate `CLAUDE.md` (modeled on the Innovis pack's CLAUDE.md), seed `STATUS.md`, vendor the skills,
do NOT gitignore `.claude/skills/` (vendored copies must be committed). Re-scan stow.
**Confirmation required before writing:** target list, vendored mode, and whether to commit in
those client GitLab repos (vs. leave the files for the user to review/commit, or stage on a branch).
Verify each repo's git tree is clean first.

## Verification
- A fresh `claude` session in a rolled-out Innovis repo reads `NEXT:` from `STATUS.md` on start
  and has the Innovis skills available locally (no external symlink).
- `stow skills sync` is idempotent and `eject` works (Task D tests).
