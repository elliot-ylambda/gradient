---
name: features
description: Turn one of gradient's background features on or off — continuity, autopilot, board, or session-scan. Each installs a hook that runs on its own afterwards, so this is the user's decision to make.
disable-model-invocation: true
---

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
- **session-scan** — a `SessionStart` hook surfaces one cached suggestion and
  rescans in the background.

With no feature named, run the bare report and read its `features:` line rather
than guessing at state:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"

Autopilot keeps a status view of its own — mode, judge budget, `gradient.md`
clamps, and recent decisions:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" autopilot status
