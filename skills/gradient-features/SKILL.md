---
name: gradient-features
description: Turn one of gradient's background features on or off — continuity, autopilot, board, or optimize. Each installs a hook that runs on its own afterwards, so this is the user's decision to make.
---

Every feature here installs a hook that runs without being asked again. Explain
what it does, then run the exact toggle the user chose — never choose for them:

    node "$(ls ~/.codex/skills/gradient-features/bin/gradient.mjs ~/.agents/skills/gradient-features/bin/gradient.mjs 2>/dev/null | head -1)" on|off <feature>

- **continuity** — a `PreCompact` hook writes a bounded, redacted checkpoint of
  recent intent, and a `SessionStart` hook reads it back after a resume or a
  compaction.
- **autopilot** — a `Stop` hook answers routine nudges the way the user would,
  bounded by a per-session judge budget and a progress gate. Turning it on
  grants `nudge` only; `full` is disabled pending further security hardening.
- **board** — `SessionStart` and `UserPromptSubmit` hooks report what other
  sessions are doing in this repository.
- **optimize** — a `SessionEnd` hook re-checks the setup after a session ends
  (at most once a day), and a `SessionStart` hook surfaces the highest-severity
  pending finding at the next one.

With no feature named, read the current state rather than guessing at it. Both
the report and `optimize` name every feature, and say what each one that is off
would do:

    node "$(ls ~/.codex/skills/gradient-features/bin/gradient.mjs ~/.agents/skills/gradient-features/bin/gradient.mjs 2>/dev/null | head -1)"

While autopilot is on, the bare report also carries its detail — mode, judge
budget, `gradient.md` clamps, and recent decisions.
