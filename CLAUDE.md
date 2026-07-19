# CLAUDE.md

## Project infrastructure

- **This repo (`elliot-ylambda/gradient`)** — the gradient CLI. `cli/` publishes to npm as **`gradient.md`** (the bin stays `gradient`, so `npx gradient.md scan` runs the `gradient` command). Specs and implementation plans live in `docs/superpowers/`.
- **`elliot-ylambda/gradient-web` (private repo)** — the marketing site at https://gradient.md. Next.js on Vercel; pushing its `main` deploys. When CLI features or copy change, keep the site's hero and feature grid in sync with the shipped `gradient` help output.
- **CI**: `.github/workflows/ci.yml`. Dependabot is enabled; keep the `@types/node` major pinned to the `engines` floor in `cli/package.json` (types must not exceed the oldest supported Node).

## Releasing

Two commands, in order, so npm and the GitHub "Latest" badge stay in sync:

1. `make publish` — publishes `cli/` to npm and pushes the `v<version>` tag. Guarded: refuses when not logged in, the tree is dirty, or the version is already live.
2. `gh release create v<version> --title "gradient <version>"` — with release notes and the exact registry tarball attached (`npm pack gradient.md@<version>`).

## Make targets

- `make test` — run the CLI suite (vitest, from `cli/`)
- `make build` — compile `cli/` to `dist/`
- `make publish-dry` — preview exactly what `make publish` would ship
- `make publish` — guarded npm publish + version tag (see Releasing)

## Housekeeping

Sessions in this repo create git worktrees under `.worktrees/` and `.claude/worktrees/`. They accumulate and eat disk space, so clean up after yourself:

- When a worktree's work is finished and its branch's PR has merged, remove it in the same session: verify it's clean first (`git -C <path> status --porcelain`), then `git worktree remove <path>`.
- Delete the merged branch too — local (`git branch -d <branch>`) and remote (`git push origin --delete <branch>`) — after confirming its content is on main.
- Never remove a worktree that has uncommitted changes, belongs to a still-running session, or whose branch is unmerged.
