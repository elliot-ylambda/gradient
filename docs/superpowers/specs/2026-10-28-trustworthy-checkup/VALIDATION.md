# Checkup validation — October 28, 2026

Implementation is on `fix/trustworthy-checkup-20261028` in `gradient` and the
separate `gradient-web` checkout, versioned v0.10.0 and based on Gradient v0.9.1.
This record is not itself a claim that the public release or website is updated.

## Verified

| Check | Result |
|---|---|
| CLI suite | 1,022 tests passed across 85 files (after the October 29 review fixes) |
| CLI TypeScript/build | Passed |
| Repository script tests | 5 passed |
| Skill validation | All four skill directories passed |
| Bundled entrypoint | Smoke test passed |
| Packaged installation/workflow harness | 20 scenarios, 282 assertions; zero failures or skipped dependencies |
| Public checkup fixture | Found two known issues, applied both, rechecked to zero, restored original files byte for byte |
| Production dependency audits | CLI and website: zero reported vulnerabilities |
| Website | Lint and production build passed; homepage, docs, skills, and social image returned HTTP 200 |
| Browser | Desktop and 390 × 844 mobile navigation checked; homepage/docs/skills had no horizontal page overflow; no browser errors observed |
| Local review page | Actual renderer: fix selection and observation dismissal produced the exact expected apply/deny command; observations offered no fix button |
| Social preview | Generated 1,200 × 630 PNG visually inspected, including corrected logo glyph |
| Patch hygiene | Both checkouts pass `git diff --check` |

CLI verification used macOS and Node v23.10.0. The website also passed lint/build
on Node v24.22.1 after updating Next.js and its lint configuration to 16.4.3 and
refreshing vulnerable transitive dependencies. The existing CI matrix covers
Node 20, 22, and 24 on Linux when the branch is submitted. That remote matrix
has not run for these local changes.

Bundle SHA-256:
`8b188627a08d48b5b5164ce63b8b2284e7b100035f473b3ee6db9dd42afa6df9` (v0.10.0).

## Independent review — October 29, 2026

A separate review of this change found seven defects that the suite above did
not catch. Each fix carries a regression test.

- **Undo of earlier runs.** Workflow runs snapshotted gradient's shared
  bookkeeping (manifest, approval ledger, `config.json`) as whole files, so any
  later apply or `gradient on|off` turned every earlier undo into a conflict.
  Bookkeeping now rolls back on failure but is reversed entry by entry on undo:
  this run's manifest entries and any consent it granted. Content-keyed
  approvals are left, as the ledger already treats them as inert.
- **Pre-0.10 runs.** Old `--auto` deletions were recorded as the hash of empty
  content and no-ops without a snapshot; both now undo instead of conflicting.
- **Dismissals.** The evidence hash included occurrence counts and the target
  selection, so a dismissed workflow returned on the next mining run. Workflows
  use the existing signature-keyed dismissal; other findings hash the proposed
  change and digit-masked evidence.
- **Trust boundary.** A file inside the repository — including through a
  linked directory or an `@import` — must resolve inside it. Claude Code asks
  before loading such external imports; Gradient reports them uninspected.
- **`--auto --apply <id>`** silently applied nothing; `--auto` no longer filters
  named fixes.
- **Targets.** `on optimize` no longer records Claude-only targets without
  asking; background checks wait for the first interactive choice.
- **Autopilot provider.** An unpinned judge could fall through to Codex;
  Codex is used only when `backend` pins it.

Removed as dead: `autoEligible` (always false), `autoApplicable`, the
`delete-file` change operation, and the board's legacy `pr-cache.json`.
A reviewed concern about ancestor `CLAUDE.md` files blocking native
`AGENTS.md` loading matches Claude Code's documented behavior and was kept.

## Product behavior coverage

- **2–5:** Shared fix/observation handling, all-family evidence-based dismissal,
  rejection of changed review evidence, real bounded adoption, propose-only
  automatic checks, workflow transactions and partial-failure rollback,
  conflict-preserving undo, idempotent undo, separate applied-run retention,
  and run-ID traversal refusal have regression coverage.
- **6–8:** Custom assistant roots, installer locations, active Claude plugins,
  ancestor instructions, precedence, imports, metadata differences, native-first
  advice, and suppression of already-installed workflows have fixture coverage.
  Unsupported dynamic/managed surfaces are explicitly reported.
- **9–11:** Project consent, Codex-only hook refusal, inert callbacks after
  opt-out, cached SessionStart findings, daily SessionEnd checks, and local-only
  board/report have regression coverage. launchd output was parsed and its
  command executed from a path with special characters. Cron percent escaping
  was exercised. Windows output was structurally checked, not run on Windows.
- **12:** Copied plugin and skill commands execute with no Gradient on PATH;
  custom paths containing spaces, quotes, and dollar signs are covered.
- **13–14:** Public copy matches the checkup scope. The example is explicitly
  synthetic and now runs in CI. Managed-memory imports remain readable while
  both finding and executor layers refuse modification.

## Observed local checkup

A propose-only check of the actual Gradient project completed with one workflow
suggestion and zero applied changes. It inspected 104 prompts and explicitly
reported incomplete history coverage. This establishes that the runner can
inspect the local setup; it does not establish a productivity benefit or prove
that every installed skill was observed. Private evidence is not included here.

## Remaining release and live checks

No personal assistant settings were repaired, background features enabled,
paid model calls made, social posts published, release created, or website
deployed by this verification. The packaged harness uses deterministic backend
stand-ins. Live assistant skill selection, paid judge behavior, visible desktop
notifications, and Windows scheduling remain separate checks described in
[`docs/dogfood.md`](../../../dogfood.md).

Release the product changes before deploying docs that link to the new demo.
Update version metadata as part of that release. Share the reproducible
check/fix/verify/undo example as evidence of mechanics; do not present passing
tests or transcript counts as measured time saved.
