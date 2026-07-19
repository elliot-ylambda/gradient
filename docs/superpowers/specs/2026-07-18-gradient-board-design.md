# gradient — `gradient board`: cross-session awareness — Design

**Date:** 2026-07-18
**Status:** Implemented and validated
**Scope:** New feature. A derived, read-only "board" that tells each live
Claude Code or Codex session in a repository what the *other* sessions are
doing — branches, worktrees, recently edited files, recent merges, open PRs —
injected at session start and refreshed only when something actionable
changes. No new stored database; the board is computed from artifacts both
agents already write.

---

## 1. Context

Working a repo with several concurrent agent sessions (Claude Code and Codex,
main checkout plus worktrees) fails in recurring ways:

- Two sessions duplicate work because neither knows the other picked it up.
- A session merges a PR; a sibling session keeps working on a stale base and
  walks into merge conflicts.
- Coordination happens manually: the operator sets up isolation worktrees by
  hand and carries state between sessions in their head.

Existing mechanisms don't cover this:

- **Memory / CLAUDE.md / `.remember`** are longitudinal — "what was learned",
  written at session end, single-author. This problem is *live presence* —
  "who is active right now" — multi-author, ephemeral, needing liveness
  semantics that memory has no concept of.
- **Git already knows** most of the facts (`git worktree list`, `gh pr list`,
  branch tips) but captures no intent, and no session checks any of it
  proactively. The gap is not storage; it is *injection at the right moment*.

A "shared markdown file all sessions write to" was considered and rejected as
the mechanism (see Decision 1): a single committed file is the worst-case
concurrent-write pattern, physically cannot converge across worktrees (each
checkout has its own copy on its own branch), and depends on every agent
conscientiously writing updates — which Codex, with its weak lifecycle-hook
story, will not do.

## 2. Decisions

### Decision 1 — Derived, passive board (no registration, no writes)

The board is **computed on demand**, never stored. Sources:

- Live Claude Code transcripts under `~/.claude/projects/`.
- Live Codex sessions via the existing `collect-codex` discovery, which
  already yields `cwd`, `branch`, `sessionId`, and `subagent` per session.
- Local git state (worktrees, branch tips, recent merges to main).
- Best-effort `gh pr list` (cached, timeout-bounded).

Alternatives rejected:

- *Registration board* (sessions write/heartbeat/remove their own state file
  via hooks): richer intent capture, but Codex cannot reliably run lifecycle
  hooks, so the agent most in need of coverage goes dark; requires TTL and
  ghost-cleanup logic; dead sessions leave stale claims.
- *Hybrid* (derived + optional `board note` intent writes): deferred, not
  rejected — it layers onto the derived base without rework (§9).

Rationale: when every participant already journals its activity, deriving
state beats maintaining a second copy that can drift. Liveness falls out of
transcript mtime for free: a crashed session simply stops being live.

### Decision 2 — Board identity is the git common dir, not the project path

`projectKey()` resolves the realpath of the *current* directory, so each
worktree gets a different key. The board instead keys on the repository's
common dir (`git rev-parse --git-common-dir`, resolved to the main checkout's
realpath) — the **board root**. Every worktree of a repo maps to one board,
which is the entire point: sessions in `.worktrees/x` and the main checkout
must see each other. Board state (fingerprints, PR cache) lives in
`projectCacheDir(boardRoot)`.

### Decision 3 — `gradient.md` is untouched

The project `gradient.md` stays clamps-only, per the hardened Decision 3 of
the 2026-07-01 gradient.md spec. The board writes nothing into the
repository, and no committed file becomes an inter-agent message channel. A
committed file writable by anyone who can merge a PR is a prompt-injection
surface; the board's digest is built only from the operator's own local
artifacts.

### Decision 4 — Freshness: start digest plus change-only refresh

A full digest is injected at SessionStart. A UserPromptSubmit hook re-checks
a **fingerprint** of the board and stays silent (empty stdout, exit 0) when
nothing actionable changed; on change it emits a single delta line. This
keeps steady-state token cost at zero while preventing the stale-9am-view
failure, where a long-lived session never learns that a sibling merged a PR.

### Decision 5 — Untrusted-text discipline

Transcript-derived text is data, not instructions. The digest contains file
paths, branch names, and session metadata; it **never** quotes another
session's assistant prose. Everything derived from transcripts passes through
the existing `redact()` and hard length caps.

## 3. Architecture

Two new files, following the existing command layout:

- `cli/src/core/board.ts` — pure logic: board-root resolution, session
  discovery, liveness classification, digest assembly, fingerprint and delta
  computation. All functions take `home` / `projectDir` parameters (like
  `checkpoint`) so tests need no real home directory.
- `cli/src/commands/board.ts` — CLI wiring: subcommands, hook payload
  parsing, hook install/remove, output.

### Session discovery (read-only)

1. Enumerate candidate transcript files, **mtime-filtered first** (only files
   touched within the liveness horizon are opened — this prunes nearly
   everything cheaply).
2. Claude Code: read a bounded tail of each candidate `.jsonl` to extract
   `cwd`; Codex: take `cwd`/`branch` from `collect-codex` metadata. Codex
   subagent sessions are excluded.
3. A session belongs to the board if its cwd's git common dir resolves to the
   board root.
4. Liveness by transcript mtime: ≤ 10 min → `live`; 10–60 min → `idle`;
   older → not shown.
5. Self-exclusion: hook payloads carry `session_id` on stdin; the digest
   lists *other* sessions and marks the caller's own entry `(you)` when
   present.

Per live session, the board extracts: agent brand (claude/codex), branch,
worktree path (relative to board root), last-activity age, and recently
edited files (deduped file paths from the last ~20 tool events in the
transcript tail, capped at 5).

### Repo-state facts

Gathered fresh per digest: `git worktree list`; commits and merges landed on
`main` in the last 24 h — PR numbers and branch names for this line come from
merge-commit subjects (`Merge pull request #N from …`), so it needs no
network and no `gh`; the current session's branch relationship to `main`
(ahead/behind); and `gh pr list` (open PRs) with a ~2 s timeout and a
5-minute on-disk cache under the board state dir. Only the open-PR line
depends on `gh`.

## 4. Digest format

Plain text, hard-capped at ~25 lines:

```
gradient board — 2 other sessions in this repo
• codex · codex/release-cleanup · .worktrees/release-cleanup · live (3m)
  editing: cli/package.json, Makefile
• claude · spec/plugin · main checkout · idle (41m)
landed on main (24h): PR #16 gradient plugin, PR #17 spec amendment
open PRs: #18 codex/release-cleanup → main
heads-up: your branch is 2 commits behind main
```

The `heads-up` line appears only when the current session's branch is behind
`main`. When `gh` is unavailable the PR line reads `(PR info unavailable)`;
when only the cache is available it is labeled with its age
(`open PRs (12m ago): …`). Absence of information is always stated, never
silent.

## 5. Change-only refresh

The fingerprint hashes only **actionable** state: the set of live session ids
and their branches, the `main` tip, and the open-PR set. It deliberately
excludes noisy fields (mtimes, `editing:` lists) so that keystrokes in a
sibling session do not defeat the silence. The stored fingerprint lives at
`<board state dir>/seen/<session-id>`.

`gradient board refresh`:

1. If the stored fingerprint file was checked less than 30 s ago, exit
   silently (floor against rapid prompting).
2. Recompute the fingerprint. Unchanged → empty stdout, exit 0 (no
   injection).
3. Changed → print one delta line, e.g.
   `board: PR #18 merged to main; codex session on release-cleanup ended`,
   and update the stored fingerprint.

Seen-files older than 7 days are opportunistically deleted during refresh.

## 6. Command surface and consent

Mirrors the `continuity` command precisely — it solved the same
opt-in-hooks-plus-config-consent problem:

- **`gradient board`** — human-readable digest on demand. No consent gate:
  it reads only the operator's own local files, the same data `gradient
  scan` already touches.
- **`gradient board on`** — installs two project hooks (SessionStart →
  `gradient board digest`, UserPromptSubmit → `gradient board refresh`) and
  records consent in config as `boardProjects` (same shape as
  `continuityProjects`, keyed by board root). Fail-closed rollback as in
  `setContinuity`: if the second install fails, the first is removed and
  consent revoked.
- **`gradient board off`** — revokes consent *first* (so a stale committed
  hook is inert), then removes both hooks and deletes the board state dir.
- **`gradient board digest` / `gradient board refresh`** — hook entry
  points; read the hook payload JSON on stdin for `session_id`. Both check
  consent and no-op silently when the board root is not in `boardProjects` —
  this is what makes a stale hook in another worktree inert after
  `board off` (same consent-check pattern as `checkpoint`). Harmless if run
  manually.
- **Codex side: nothing to install.** Codex sessions appear on the board
  passively. Suggesting `gradient board` in `AGENTS.md` is optional
  documentation, not machinery.

Hooks are installed into the current checkout's settings, so each worktree
that wants injection runs `board on` once; consent and board state are
shared repo-wide via the board root.

## 7. Error handling

- **Not a git repo** → `gradient board` prints one line explaining the board
  requires a git repository; `board on` refuses.
- **`gh` missing / unauthenticated / slow** → `(PR info unavailable)` or
  age-labeled cache; never blocks or fails the hook.
- **Unparseable or oversized transcripts** → skipped and counted; the count
  is visible under `--verbose`. All reads reuse the byte/entry caps
  established in `collect-codex` and the symlink refusals in `safeFs`.
- **Hooks never break a session**: `digest` and `refresh` catch all errors
  and exit 0 — worst case is a missing digest, never a blocked prompt. The
  manual `gradient board` command surfaces errors loudly (fail-open hides
  outages; only the hook paths swallow).
- **Untrusted text**: branch names, paths, and any transcript-derived string
  are length-capped and pass through `redact()`.

## 8. Testing

TDD throughout (`cd cli && npm test`, `npm run build` before claiming done).

- `cli/src/core/board.test.ts` — fixture home dirs (fake
  `~/.claude/projects` and `~/.codex/sessions` trees) and tmp git repos with
  real worktrees: cross-worktree discovery converges on one board root;
  liveness buckets by mtime; self- and subagent-exclusion; digest snapshot;
  25-line cap; a planted secret is redacted; fingerprint is stable under
  mtime churn and `editing:` changes but moves on a merge to `main`; the
  30-second refresh floor holds.
- `cli/src/commands/board.test.ts` — `on`/`off` install, rollback, and
  consent parity with `continuity.test.ts` patterns; hook entry points exit
  0 under induced errors; `gh` failure renders `(PR info unavailable)`;
  `off` deletes board state.

## 9. Out of scope (v1)

- **Intent notes / claims** (`gradient board note`, `board claim`) — the
  natural next increment; layers onto the derived board without rework.
- **Codex-side hooks** of any kind.
- **Cross-machine boards** — the board root is a local realpath; remote
  coordination is a different problem.
- **Any write to `gradient.md`** — the clamps-only contract stands.
- **Message passing between sessions** — agents cannot respond mid-turn;
  awareness, not conversation, is the product.
