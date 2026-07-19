# Dogfood evidence

**Status:** Implemented and validated
**Date:** 2026-07-18

## Summary

Gradient provides a single, repeatable dogfood command that installs the exact
npm artifact intended for release, exercises its public features in an
isolated synthetic environment, and produces inspectable evidence in JSON,
Markdown, and HTML. The automated proof is paired with an explicit live
checklist for the small set of behaviors that require a human, real history, or
an operating-system UI.

## Problem

The project has broad unit and integration coverage, but its release checks do
not currently demonstrate that the packaged CLI's features compose correctly.
A passing test count and a version smoke test cannot show that users can scan,
review, apply, recall, remove, bundle, or run hooks through the artifact that is
actually published.

## Goals

- Make packaged end-to-end dogfooding one command and one CI release gate.
- Make the result reviewable without trusting a green check alone.
- Cover every advertised command and every generated artifact family.
- Keep automated runs deterministic, offline, private, and safe to repeat.
- Clearly distinguish synthetic proof from live human proof.

## Non-goals

- The automated run does not read a developer's real Claude Code or Codex
  history.
- It does not spend model credits, contact external services, publish a package,
  merge code, or display a real desktop notification.
- It does not replace focused unit, integration, security, or compatibility
  tests.

## Behavior

1. From a clean checkout, a contributor can run one documented command to
   execute the complete automated dogfood suite. The command requires only Git
   plus the supported Node and npm toolchain already used by the checkout; it
   does not require Docker, credentials, network access, Claude Code, or Codex.

2. The suite builds and packs `gradient.md`, installs that tarball into a fresh
   consumer project, and invokes the installed executable. Passing by importing
   the source checkout in place does not count as packaged proof.

3. The suite runs in a newly created project and Gradient home. It never reads
   or writes the contributor's real Gradient configuration, state, installed
   skills, assistant transcripts, or repository artifacts.

4. The installed binary accepts `GRADIENT_HOME` as an optional state-isolation
   override. When absent, Gradient's existing default paths and behavior remain
   unchanged. Every stateful public command and hook target honors the override.

5. Synthetic Claude Code and Codex histories contain only invented prompts,
   tool activity, command events, and assistant output. Deterministic local
   stand-ins exercise both CLI backend protocols without invoking a real model
   or inheriting personal agent customizations.

6. The automated suite proves the distribution surface: tarball installation,
   executable permission, package version, help output, the bundled npm skill,
   and the committed plugin binary's version and help output.

7. The suite derives the advertised command set from the installed binary's
   help output and fails when any advertised command lacks an explicit dogfood
   scenario. Adding a public command without adding proof is therefore a release
   failure.

8. The suite exercises the setup and mining funnel with both assistant targets:
   initialization, skill installation, project scan, cross-project scan,
   Claude Code transcript collection, Codex transcript collection, model-backed
   classification, cached suggestions, session-start surfacing, and
   non-interactive review output.

9. The suite exercises the review lifecycle through public CLI surfaces:
   evidence explanation, interactive approval, direct apply, listing, safe
   removal, dismissal or empty-state behavior, and project-playbook pin
   approval after a manual edit.

10. The suite installs and inspects every artifact family Gradient can produce:
    Claude and Codex skills, legacy Claude commands, project rules, print-only
    user/Codex rules, loops, built-in hooks, reviewed command hooks, and tagged
    entries in the committed `gradient.md`.

11. The suite proves migration and portability behavior: legacy command dry
    run, command-to-skill migration, team bundle creation, valid plugin metadata,
    portable-file inclusion, and deliberate hook/loop exclusion.

12. The suite proves the runtime assistance features: recall enable/status/hit
    and disable, adoption accounting, stats, terminal insights, HTML insights,
    continuity enable/checkpoint/recap/disable, autopilot enable/status/judge
    stand-down/disable, notification hook fail-open behavior, and hook-target
    structured output contracts.

13. Consent round-trips leave adjacent settings intact. Turning recall,
    continuity, or autopilot off removes only the hook and private consent owned
    by that feature.

14. Safety scenarios exercise at least unknown input, malformed hook input,
    corrupt configuration, corrupt and oversized suggestion caches, symlink
    refusal, disabled hook bundling, and tampered generated-artifact removal.
    Expected refusal and fail-open behavior count as passes only when the
    protected file or user action remains unchanged.

15. The suite checks important filesystem invariants, including private modes
    for configuration, caches, approvals, state, and generated agent artifacts;
    provenance markers; settings merges; and removal round-trips.

16. Each scenario records its human-readable purpose, sanitized command,
    outcome, duration, assertions, bounded stdout/stderr, and relevant artifact
    paths. Temporary absolute paths and home-directory details are replaced by
    stable placeholders.

17. Every run writes `report.json`, `report.md`, and `report.html` to the chosen
    evidence directory, including package name/version, tarball digest, source
    commit, Node/platform metadata, scenario totals, and limitations. Reports
    contain no transcript or credential data other than the committed synthetic
    fixtures generated by the run.

18. A fully passing run exits zero. Any failed assertion, command contract, or
    missing advertised-command scenario exits non-zero after still writing all
    three reports. Dependent scenarios may be marked skipped rather than
    misreported as passes.

19. Temporary package, home, transcript, and project directories are removed
    after reporting by default. An explicit keep option may preserve only the
    synthetic sandbox for local debugging, and the report clearly identifies
    that choice.

20. CI runs the dogfood suite in an existing required check and uploads the
    reports even when the suite fails. A release cannot pass `prepublishOnly`
    without a passing dogfood run.

21. The documentation includes a live dogfood checklist for real Claude Code
    and Codex history, real model responses, installed plugin skills, an
    interactive terminal, and a visible desktop notification. These checks are
    opt-in because they may expose private history, spend credits, or affect a
    user's machine.

22. Automated reports label their conclusion as synthetic packaged proof, not
    as evidence that a live personal workflow or OS integration was observed.
    The live checklist records who ran it, when, against which version/commit,
    and links or notes for each observation.
