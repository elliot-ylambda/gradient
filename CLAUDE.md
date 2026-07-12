# CLAUDE.md

## Housekeeping

Sessions in this repo create git worktrees under `.worktrees/` and `.claude/worktrees/`. They accumulate and eat disk space, so clean up after yourself:

- When a worktree's work is finished and its branch's PR has merged, remove it in the same session: verify it's clean first (`git -C <path> status --porcelain`), then `git worktree remove <path>`.
- Delete the merged branch too — local (`git branch -d <branch>`) and remote (`git push origin --delete <branch>`) — after confirming its content is on main.
- Never remove a worktree that has uncommitted changes, belongs to a still-running session, or whose branch is unmerged.
