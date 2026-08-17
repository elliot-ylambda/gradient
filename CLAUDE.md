# CLAUDE.md

## Project infrastructure

- **This repo (`elliot-ylambda/gradient`)** — gradient itself. It is **published to no package registry**: it ships as files in this repository, in two shapes that both carry the same runner.
  - `plugin/` — the Claude Code plugin, installed with `/plugin marketplace add elliot-ylambda/gradient` + `/plugin install gradient@gradient`. Its three `SKILL.md` files are the **authored source**.
  - `skills/gradient-*` — the Codex skills, installed with Codex's built-in `$skill-installer`; **generated** from `plugin/skills/` by `cli/scripts/skill-render.mjs`. Never hand-edit them; run `make artifacts`.
  - `cli/` — TypeScript source only, built into `plugin/bin/gradient.mjs` and copied into each skill directory. `cli/package.json` is `private`.
  - Specs and implementation plans live in `docs/superpowers/` — dated records, not current documentation; see its README before trusting a command in one.
- **`elliot-ylambda/gradient-web` (private repo)** — the marketing site at https://gradient.md. Next.js on Vercel; pushing its `main` deploys. When CLI features or copy change, keep the site's hero and feature grid in sync with the shipped `gradient` help output.
- **CI**: `.github/workflows/ci.yml`. Dependabot is enabled; keep the `@types/node` major pinned to the `engines` floor in `cli/package.json` (types must not exceed the oldest supported Node).

## Releasing

A release is not complete until both steps are done and verified:

1. `make publish` — from a clean checkout of origin/main's tip: rebuilds the
   artifacts, pushes the `v<version>` tag, and creates the GitHub release with
   `gradient-skills.tar.gz` attached (the asset name is version-free so
   `/releases/latest/download/` resolves). Guarded (gh auth, clean tree — which
   also catches a stale committed bundle — HEAD must equal origin/main, version
   not already released) and convergent: rerun it to finish a partial release.
   Plugin users track the repository, so their install needs no release at all.
2. Update the version and any changed feature copy in the private `gradient-web`
   repository and push its `main` (deploys the site).

Then run `make release-check` — it verifies the GitHub release and
https://gradient.md both report `cli/package.json`'s version.

## Make targets

- `make test` — run the CLI suite (vitest, from `cli/`)
- `make build` — compile `cli/` to `dist/`
- `make artifacts` — rebuild `plugin/bin/gradient.mjs` and the three `skills/gradient-*` directories
- `make publish-dry` — rebuild, then fail if any committed artifact is out of date
- `make publish` — guarded version tag + GitHub release (see Releasing)
- `make release-check` — verify GitHub and the website agree on the version

## Housekeeping

Sessions in this repo create git worktrees under `.worktrees/` and `.claude/worktrees/`. They accumulate and eat disk space, so clean up after yourself:

- When a worktree's work is finished and its branch's PR has merged, remove it in the same session: verify it's clean first (`git -C <path> status --porcelain`), then `git worktree remove <path>`.
- Delete the merged branch too — local (`git branch -d <branch>`) and remote (`git push origin --delete <branch>`) — after confirming its content is on main.
- Never remove a worktree that has uncommitted changes, belongs to a still-running session, or whose branch is unmerged.
