---
name: features
description: Manage Gradient's optional hooks: memory for Claude Code and Codex, and continuity, autopilot, board, and periodic checkups for Claude Code. Use only when the user explicitly asks to turn a feature on or off.
disable-model-invocation: true
---

**memory** installs hooks for both Claude Code and Codex; the other features
install **Claude Code hooks only**. A Codex-only setup can turn on memory and
must receive an unsupported explanation for the rest, never a claim that one was
enabled. Prefer the assistant's native memory, scheduling, and continuation when
they meet the need.

Every feature here installs a hook that runs without being asked again. Explain
what it does, then run the exact toggle the user chose — never choose for them:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" on|off <feature>

- **continuity** — a `PreCompact` hook writes a bounded, redacted checkpoint of
  recent intent, and a `SessionStart` hook reads it back after a resume or a
  compaction.
- **autopilot** — when Claude stops, a `Stop` hook asks a small model whether
  it stopped early; if so it sends "Continue." and nothing else. It never
  answers a question for the user. Bounded by a per-session judge budget and a
  progress gate. Turning it on grants `nudge` only; `full` is disabled pending
  further security hardening.
- **board** — `SessionStart` and `UserPromptSubmit` hooks report what other
  sessions are doing in this repository.
- **optimize** — a `SessionEnd` hook re-checks the setup after a session ends
  (propose-only, at most once a day), and a `SessionStart` hook surfaces the highest-severity
  pending finding at the next one. Background checks start once a first checkup has
  recorded which assistants to inspect.
- **memory** — user-level `SessionStart` hooks (`~/.claude/settings.json` and
  `~/.codex/hooks.json`) start every session in this repository with a short
  list of the user's corrections from Claude Code's auto memory: in Claude Code
  only the ones MEMORY.md does not already load, in Codex all of them. Consent
  is per repository, so every worktree of it gets the list and other
  repositories get nothing. Codex runs a new hook only after the user reviews it
  with `/hooks`; tell them that when turning it on.

With no feature named, read the current state rather than guessing at it. Both
the report and `optimize` name every feature, and say what each one that is off
would do:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"

While autopilot is on, the bare report also carries its detail — mode, judge
budget, `gradient.md` clamps, and recent decisions.

Continuity returns a local checkpoint to the existing Claude session.
Autopilot calls a separate configured model judge and can incur usage charges.
Board and periodic checks stay local. Old global optimize consent requires
per-project re-enable.
