---
name: gradient-report
description: Show how the user actually works — what their habits cost, which generated artifacts exist and whether anything invokes them, what other sessions are doing in this repo, and what to do next. Use when the user asks how they use Claude Code, what gradient has found, or what they should automate.
---

Run the bundled gradient CLI with no arguments. It is read-only, needs no prior
scan, and answers all of those questions at once:

    node "$HOME/.agents/skills/gradient-report/bin/gradient.mjs"

Lead with what it says. In particular:

- **cost of unautomated habits** — each line names the action that addresses it.
  The nudge line is honest about buying back attention rather than tokens; do
  not restate it as a token saving.
- **installed** — an artifact with 0 uses and a `remove` hint is dead weight.
  Say so; that number is the point of the section.
- **pending suggestions** — a `measured` tag means the evidence is counted tool
  invocations. Anything without it was inferred from repeated prompt text; read
  the evidence before repeating the claim.

Add `--user` for the same behaviour report across every project in a recent
window, and `--html` to write a self-contained private `.gradient/insights.html`.
Neither makes a model call.

If the command fails to start, this skill directory is incomplete — tell the
user to re-copy skills/gradient-report from the gradient repository.
Never look for a gradient anywhere else on the system.
