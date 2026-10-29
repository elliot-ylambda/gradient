---
name: features
description: Manage Gradient's optional Claude Code hooks: continuity, autopilot, board, and periodic checkups. Use only when the user explicitly asks to turn a feature on or off.
disable-model-invocation: true
---

These optional features currently install **Claude Code hooks only**. Codex has
native hooks, but Gradient does not install them. A Codex-only setup must receive
an unsupported explanation, never a claim that a feature was enabled. Prefer the
assistant's native memory, scheduling, and continuation when they meet the need.

Every feature here installs a hook that runs without being asked again. Explain
what it does, then run the exact toggle the user chose — never choose for them:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" on|off <feature>

- **continuity** — a `PreCompact` hook writes a bounded, redacted checkpoint of
  recent intent, and a `SessionStart` hook reads it back after a resume or a
  compaction.
- **autopilot** — a `Stop` hook answers routine nudges the way the user would,
  bounded by a per-session judge budget and a progress gate. Turning it on
  grants `nudge` only; `full` is disabled pending further security hardening.
- **board** — `SessionStart` and `UserPromptSubmit` hooks report what other
  sessions are doing in this repository.
- **optimize** — a `SessionEnd` hook re-checks the setup after a session ends
  (propose-only, at most once a day), and a `SessionStart` hook surfaces the highest-severity
  pending finding at the next one. Background checks start once a first checkup has
  recorded which assistants to inspect.

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
