# Dogfooding and release evidence

Gradient has two deliberately separate proof levels:

1. **Automated packaged proof** is deterministic, offline, synthetic, and a
   release gate. It proves the packed npm artifact composes correctly.
2. **Live dogfooding** is opt-in and human-observed. It proves real private
   history, model, terminal, plugin, and desktop integrations in an operator's
   environment.

Keeping those labels separate prevents a synthetic green check from claiming
that somebody actually saw an OS notification or used a generated skill in a
real session.

## Automated packaged proof

From the repository:

```bash
cd cli
npm ci
npm run dogfood -- --output ../artifacts/dogfood
```

The command builds and packs `gradient.md`, installs the tarball into a fresh
consumer, and invokes its executable with an isolated `GRADIENT_HOME`. It needs
no credentials, network access, Docker, Claude Code, Codex, or real transcript.
It writes:

- `artifacts/dogfood/report.json` — machine-readable provenance, assertions,
  bounded output, totals, and limitations.
- `artifacts/dogfood/report.md` — reviewable evidence in a pull request or text
  viewer.
- `artifacts/dogfood/report.html` — a self-contained visual report.

Pass means all 19 scenario groups passed with zero failures and zero skipped
dependencies. A failure still writes reports and exits non-zero. `--keep`
preserves only the synthetic temporary sandbox for debugging; otherwise it is
removed after reporting.

### What the 19 groups prove

| Area | Packaged behavior |
|---|---|
| Distribution | pack/install, executable mode, version/help, npm skill, plugin-binary parity, advertised-command coverage |
| Isolation | disposable project/home, invented Claude and Codex histories, deterministic CLI backend protocols |
| Setup and mining | dual-target init, project/user scans, both collectors and backends, cache, explain, review JSON, session-start rescan |
| Artifacts | legacy command and migration; Claude/Codex skills; project/user/Codex rules; loop; built-in/command hooks; committed `gradient.md` entry |
| Review and consent | direct apply, interactive approval, exact-prose playbook pinning, list, provenance, private modes |
| Portability | team bundle, both plugin manifests, portable inclusion, hook/loop exclusion |
| Runtime | recall hit and adoption, stats, terminal/HTML insights, continuity checkpoint/recap, board discovery/delta/consent, autopilot continue/progress/stand-down, notification fail-open |
| Safety and cleanup | unknown/malformed/corrupt/oversized/symlinked input, disabled hook export, tamper refusal, line-surgical and hook-specific removal |
| Evidence | tarball digest, source commit, sanitized paths/output, secret-sentinel absence, JSON/Markdown/HTML parity |

CI runs the same command inside the existing required `plugin` job and uploads
the three reports even when the gate fails. `prepublishOnly` also runs the gate,
so npm publication stops on a failing composition scenario.

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
Git commit or npm tarball SHA-256:
Node / OS / terminal:
Claude Code version:
Codex version:
Result: PASS | FAIL | BLOCKED
```

### Checklist

- [ ] Install the candidate npm tarball or plugin in a fresh throwaway project;
      verify `gradient --version` matches the candidate.
- [ ] Run `gradient init --target both --session-scan`; start a new Claude Code
      session and observe one cached suggestion plus the background rescan log.
- [ ] With explicit history consent, run project and user scans. Confirm both
      Claude Code and Codex source counts are plausible and inspect a few
      redacted `gradient explain` examples without copying private text.
- [ ] Review at least one safe suggestion interactively. Approve it, invoke the
      resulting skill in Claude Code and Codex, and confirm its authorization
      guard prevents unrequested consequential steps.
- [ ] Apply one project rule, one hook, and one `gradient.md` entry. Confirm the
      expected files/settings, then remove each and verify adjacent manual
      content survives.
- [ ] Enable recall and type a matching natural-language prompt. Observe the
      hint, then verify `gradient stats` reports adoption without storing the
      prompt text.
- [ ] Run `gradient insights --html`; compare the visible report with known
      recent behavior and open the HTML artifact.
- [ ] Enable continuity, trigger a real compaction, resume, and confirm the
      redacted checkpoint is helpful and clearly labeled untrusted.
- [ ] In a repository with one Claude Code session and one Codex session, run
      `gradient board` and confirm both appear without exposing prompt text.
      Enable `gradient board on`, confirm a new commit or session produces one
      delta line, then turn it off and confirm the hooks and cached board state
      are removed.
- [ ] Enable `gradient autopilot nudge` in the throwaway project. Observe one
      justified `Continue.` and one stand-down/no-progress decision; inspect
      `gradient autopilot status`, then turn it off.
- [ ] Trigger a real Claude Code permission or idle notification and visually
      observe the desktop ping. Confirm notification failure would not block the
      assistant.
- [ ] Build `gradient bundle live-dogfood`, load it as a local Claude plugin and
      through the supported Codex marketplace path, then invoke one bundled
      skill. Confirm hooks were not exported.
- [ ] Run `gradient recall off`, `gradient continuity off`, `gradient board
      off`, and `gradient autopilot off`; inspect settings and remove remaining
      generated artifacts.

For each item, record `PASS`, `FAIL`, or `BLOCKED` plus a sanitized observation
or link to non-sensitive evidence. Any safety-boundary failure, destructive
removal, real-home isolation failure, missing packaged command, or mismatched
version is a release blocker. A missing desktop environment may be `BLOCKED`,
but must not be relabeled as an automated pass.
