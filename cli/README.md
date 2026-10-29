# Gradient CLI development

TypeScript source for the runner shipped in the Claude plugin and Codex skills.
This package is private and is not installed from a package registry. Node.js 20+
is required. See the [root README](../README.md) for the user-facing workflow.

## Architecture

- Collection/parsing reads bounded local histories from enabled assistants.
- `instructions.ts` and `surface.ts` inspect local instruction and skill sources.
- `findings.ts` combines deterministic file evidence with labeled history evidence.
- `commands/optimize.ts` proposes, applies, dismisses, and persists checkups.
- `run.ts` snapshots changes and guards undo against subsequent edits.
- `page.ts` renders a self-contained offline review page.
- `commands/report.ts` assembles observed activity and current project state.

The checkup makes no model or network calls. Absence from a bounded event corpus
is not proof of non-use. Automatic mode is a compatibility alias for a propose-only checkup. Apply requires a concrete change; informational findings remain
review-only. Dismissals apply to every finding family while evidence is unchanged.

Workflow application records both generated files and supporting metadata.
Undo preflights conflicts before restoring the run, avoiding an artifact/manifest
mismatch when a later edit must be preserved. Writes retain the safe-filesystem
and advisory-lock boundaries. Managed memory is never changed.

## Optional runtime

The optional feature installer writes Claude Code hooks. It rejects Codex-only
activation explicitly; Codex's own hook system is a separate integration.
Consent and displayed state are scoped to the current project. SessionStart
surfaces a cached pending finding; SessionEnd requests a propose-only checkup,
debounced daily. Leftover callbacks after opt-out must do nothing.

Continuity writes a local checkpoint and returns it to the existing Claude
session. Autopilot calls a separate judge through the configured backend.
Autopilot relays only a fixed continuation nudge, with tools disabled in the
judge, a per-session budget, and a progress gate. Repository `gradient.md`
frontmatter can lower mode/budget, never grant additional authority. Full mode
remains disabled. Board and reports use local data without GitHub requests.

## Validate

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run build:plugin
npm run smoke:bin
npm run dogfood:run -- --output ../artifacts/dogfood
```

The packaged harness copies both shipping shapes into a disposable home, runs
the generated skill commands, and uses invented histories and model protocol
stand-ins. It does not exercise real accounts, read personal history, spend model
credits, or prove real assistant dispatch. See [dogfood.md](../docs/dogfood.md).

`GRADIENT_HOME=/absolute/path` isolates Gradient and assistant-history roots for
tests. Never run mutation fixtures against a real home or repository setup.

Only `plugin/skills/` is authored. `build:plugin` regenerates the bundled runner
and the Codex skill copies. Keep generated artifacts in sync with source.

## Release

Follow [CLAUDE.md](../CLAUDE.md): validate and rebuild artifacts, release from a
clean main tip using `make publish`, then update the separate homepage repository
and verify `make release-check`. Neither validation nor a local build publishes.
