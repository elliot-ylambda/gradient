# Dogfooding and release evidence

Gradient has two deliberately separate proof levels:

1. **Automated packaged proof** is deterministic, offline, synthetic, and a
   release gate. It proves that what the repository ships composes correctly.
2. **Live dogfooding** is opt-in and human-observed. It proves real private
   history, model, terminal, plugin, and desktop integrations in an operator's
   environment.

Keeping those labels separate prevents a synthetic green check from claiming
that somebody actually saw an OS notification or used a generated skill in a
real session.

## What "ships" means

gradient is published to no package registry. It ships as files in this
repository, in two shapes that carry the same single-file runner:

- `plugin/` — the Claude Code plugin, added with
  `/plugin marketplace add elliot-ylambda/gradient`.
- `skills/gradient-optimize`, `skills/gradient-report`, `skills/gradient-features`
  — copied into `~/.agents/skills` for Codex.

So the gate does not pack anything. It installs both shapes the way the README
tells a user to, into a disposable home, and drives them from there.

## Automated packaged proof

From the repository:

```bash
cd cli
npm ci
npm run dogfood -- --output ../artifacts/dogfood
```

The command builds the runner, regenerates the skill directories, copies both
shapes into an isolated `HOME`, and drives the copied runner with an isolated
`GRADIENT_HOME`. It needs no credentials, network access, Docker, Claude Code,
Codex, or real transcript. It writes:

- `artifacts/dogfood/report.json` — machine-readable provenance, assertions,
  bounded output, totals, and limitations.
- `artifacts/dogfood/report.md` — reviewable evidence in a pull request or text
  viewer.
- `artifacts/dogfood/report.html` — a self-contained visual report.

Pass means all 19 scenarios passed with zero failures and zero skipped
dependencies. A failure still writes reports and exits non-zero. `--keep`
preserves only the synthetic temporary sandbox for debugging; otherwise it is
removed after reporting.

### What the 19 scenarios prove

| Area | Behavior |
|---|---|
| Distribution | committed artifacts match a fresh build; both shapes install by copying; each carries the same runner byte for byte; version/help; every advertised command has a scenario |
| Isolation | disposable project/home, invented Claude and Codex histories, deterministic CLI backend protocols |
| Setup | the one first-run consent (which assistants); **every SKILL.md's own command is executed**, in both shapes, on a PATH with no `gradient` on it |
| Mining | project and cross-project scope, both collectors, the restatement filter, the suggestion cache |
| Review | findings as JSON, the local checkup page, direct apply, deny, refusal to auto-apply prose |
| Artifacts | the AGENTS.md bridge and its undo; every generated artifact family; ownership and provenance |
| Runtime | continuity checkpoint/recap, board discovery/delta/consent, autopilot continue/progress/stand-down, notification fail-open, leftover-hook exit |
| Reporting | the composed report from real state |
| Safety | unknown/malformed/corrupt/oversized/symlinked input, tamper refusal |
| Lifecycle | removal of owned artifacts and feature consent without collateral changes |
| Evidence | runner digest, source commit, sanitized paths/output, secret-sentinel absence, JSON/Markdown/HTML parity |

CI runs the same command inside the existing required `plugin` job and uploads
the three reports even when the gate fails.

**The setup scenario is the one that has caught the most.** A `SKILL.md` is
prose until an agent runs it, so a command in it that does not resolve is not a
degraded skill — it is a skill that can do nothing, and nothing finds out until
a user's session fails. Asserting the *shape* of that command is what let a
release ship in which every installed skill named a `gradient` that no install
puts on PATH. The scenario runs it.

## Live dogfood pass

Do this only with an operator who explicitly consents to reading their local
assistant history, using their logged-in model CLIs, installing local hooks and
skills, and showing a desktop notification. The automated gate never grants
that consent.

Use a throwaway repository with non-sensitive work. Do not paste raw transcript
text into an issue, PR, or report; record counts and sanitized observations.

### Record the run

```text
Operator:
Local date/time and timezone:
Gradient version:
Git commit and runner SHA-256:
Node / OS / terminal:
Claude Code version:
Codex version:
Result: PASS | FAIL | BLOCKED
```

### Checklist

Below, `G` is the runner the installed skill names — `bin/gradient.mjs` inside
the plugin, or `~/.agents/skills/gradient-optimize/bin/gradient.mjs`. Prefer
driving each step by *asking the assistant*, and fall back to typing `node $G`
only to check something the skill does not surface.

- [ ] Install the plugin in Claude Code, and copy the three skill directories
      for Codex. Confirm `node $G --version` matches the candidate in both, with
      no `gradient` on `PATH` and no npm involved.
- [ ] In each assistant, ask it to optimize your setup. Confirm it selects the
      right skill, runs the command that skill names, and that the run asks once
      which assistants to target and then remembers.
- [ ] With explicit history consent, run project and user scope. Confirm both
      Claude Code and Codex source counts are plausible and inspect a few
      redacted evidence lines without copying private text.
- [ ] Review at least one safe finding interactively. Approve it, invoke the
      resulting artifact in Claude Code and Codex, and confirm its authorization
      guard prevents unrequested consequential steps.
- [ ] Apply one project rule, one hook, and one `gradient.md` entry. Confirm the
      expected files/settings, then `remove` each and verify adjacent manual
      content survives.
- [ ] Run `optimize --page`; open the local checkup page, choose changes, and
      confirm the command it hands you runs verbatim.
- [ ] Turn `continuity` on, trigger a real compaction, resume, and confirm the
      redacted checkpoint is helpful and clearly labeled untrusted.
- [ ] In a repository with one Claude Code session and one Codex session, turn
      `board` on and confirm both appear without exposing prompt text. Confirm a
      new commit or session produces one delta line, then turn it off and
      confirm the hooks and cached board state are removed.
- [ ] Turn `autopilot` on in the throwaway project. Observe one justified
      `Continue.` and one stand-down/no-progress decision, then turn it off.
- [ ] Trigger a real Claude Code permission or idle notification and visually
      observe the desktop ping. Confirm notification failure would not block the
      assistant.
- [ ] Run `optimize --print-schedule`, install the snippet it prints, and
      confirm the scheduled run fires — a scheduler has a minimal `PATH` and no
      shell profile, which is exactly where a command that needs one fails.
- [ ] Turn every feature off; inspect settings and remove remaining generated
      artifacts. Confirm nothing gradient did not generate was touched.

For each item, record `PASS`, `FAIL`, or `BLOCKED` plus a sanitized observation
or link to non-sensitive evidence. Any safety-boundary failure, destructive
removal, real-home isolation failure, missing packaged command, or mismatched
version is a release blocker. A missing desktop environment may be `BLOCKED`,
but must not be relabeled as an automated pass.
