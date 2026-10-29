# Trustworthy checkup implementation

## Context

Base: `153448eb692025b1f8bd55b9c9c90d6b50a3248b` (v0.9.1).
The [product behavior](PRODUCT.md) is grounded in the October 27 audit and
current official documentation, researched again October 28.

- [`commands/optimize.ts`](https://github.com/elliot-ylambda/gradient/blob/153448eb692025b1f8bd55b9c9c90d6b50a3248b/cli/src/commands/optimize.ts)
  combines mining, inspection, findings, application, and the review page.
- `core/run.ts` snapshots generic changes, but workflow application bypasses it.
- `core/surface.ts` and `instructions.ts` approximate assistant discovery.
- `commands/features.ts`, `sessionStart.ts`, and `sessionEnd.ts` install and run
  the current Claude callbacks. `report.ts` exposes their state.
- `cli/scripts/skill-render.mjs` generates Codex skills from plugin sources.
- The separate `gradient-web` repository owns the public Next.js pages.

## Proposed changes

1. Reuse bounded insight collection for actual adoption evidence and page
   metrics. Stop automatically deleting skills; phrase absent observed usage as
   bounded evidence. Retain `--auto` as a propose-only compatibility flag.
2. Extend existing snapshot/write-hash bookkeeping to workflow effects and
   associated metadata. Preflight conflicts before undo and roll back failed
   applications, using existing safe filesystem and advisory-lock boundaries.
   Avoid introducing a second storage or transaction framework.
3. Add stable finding-level dismissals keyed to evidence. Preserve old workflow
   dismissals. Centralize whether a finding is actionable and use the same
   decision in JSON, CLI, apply, and the local page.
4. Persist the final ranked findings locally in a bounded project cache for
   SessionStart. Coordinate one simple shared module/type between optimizer and
   runtime code. Cached findings carry a date and are observations, not approval.
5. Update discovery and advice against current documented behavior. Read actual
   installed plugin metadata and enabled state rather than indiscriminately
   counting every cached version. Preserve read/write trust boundaries; report
   incomplete scans instead of promising exhaustive inspection.
6. Make optional runtime status/consent project-specific, honor leftover-hook
   opt-out, and debounce callbacks. Explicitly reject unsupported Gradient
   hook installation for Codex-only targets. Keep existing Codex judge backend
   support using the already implemented backend protocol. Store consent in
   `optimizeProjects`; the legacy global flag grants no authority. SessionEnd
   uses the existing advisory lock around its daily watermark and launches
   `optimize` without `--auto`. SessionStart only reads the ranked checkup cache.
   Remove board's GitHub PR fetch/cache/render path. Retain local Git and session
   observations; ignore legacy PR fields in cached board comparisons. Label the
   existing global autopilot observations across projects without adding state.
7. Escape launchd XML and shell arguments. Tests parse the generated document
   and inspect commands with spaces/special characters, beyond string matching.
8. Render Codex skill instructions using a runner relative to the activated
   SKILL.md, never another installed copy. Exercise generated commands from
   nonstandard destinations and paths with spaces in the packaged harness.
9. Rewrite user-facing documentation around the checkup. Add a concise dated
   native-capability comparison with primary sources. Keep public installation
   and core command surface stable. Update homepage examples from a deterministic
   fixture; add a code-generated social preview image and maintain existing
   styling rather than introduce a new UI stack.
10. Refresh the website within Next.js 16 to address reported dependency
    advisories, keeping its existing framework and dependencies. Verify lint,
    build, HTTP routes, social image, and responsive layout after the update.

## Testing and validation

- Behavior 2–5: regress active skill usage/no auto-delete, every finding family's
  dismissal, no-op rejection, workflow apply/undo across targets and hook/rule
  state, post-write conflicts and partial failures.
- Behavior 6–8: fixtures for real installation roots/plugin metadata, custom
  paths, Claude instruction fallback and explicit imports, assistant-specific
  duplicates, and active-feature suppression. Cite documentation assumptions.
- Behavior 9–11: Codex-only refusal, correct per-repository status, leftover
  callbacks after off, shared ranked cache, daily debounce, and parseable schedule.
- Behavior 12: run actual generated skill commands in default/custom disposable
  installs using the packaged dogfood harness.
- Behavior 13: website lint/build, inspect desktop/mobile renders if browser
  available, validate social image response and example output. Never label
  fixture output as a real user outcome.
- Run all CLI/repository tests, typecheck/build, regenerate shipping artifacts
  once integration is complete, then packaged dogfood. Inspect diffs and map
  remaining limitations back to PRODUCT.md before reporting completion.
- Real local checkup is propose-only. Use isolated homes for apply/undo, model
  backend stand-ins, notifications, and feature installation tests. Report those
  limits rather than claiming observed live assistant behavior.

## Work allocation

All agents share the feature branch and have disjoint file ownership. The
optimizer agent owns findings/application/snapshots/page/dismissals. The runtime
agent owns feature controls/hooks/report/scheduling. The discovery agent owns
instruction/skill inventory and skill rendering after official-doc research.
The root agent owns specs, documentation, website, integration, and final checks.
Shared contracts are agreed in messages before edits; only root regenerates
bundles and runs the final complete build/harness.
