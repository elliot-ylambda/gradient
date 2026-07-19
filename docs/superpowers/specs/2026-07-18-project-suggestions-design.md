# gradient — Project suggestions → committed `gradient.md` — Design

**Date:** 2026-07-18
**Status:** Implemented and validated (merged in PR #20)
**Scope:** Builds the increment deferred in
[`2026-07-01-gradient-md-design.md`](./2026-07-01-gradient-md-design.md) §6: a
project-level suggestion payload written into the committed `<repo>/gradient.md`
only after `review` approval — and gives that file's prose a mechanical
consumer again via locally consented hash-pinning.

---

## 1. Context

The committed `gradient.md` currently contributes machine-readable clamps only
(`autopilot.max-mode`, `autopilot.budget`); its prose never reaches the judge.
That hardening (see the 2026-07-18 amendment on the gradient.md design spec)
closed a supply-chain hole — anyone who can merge a PR can edit the file — but
left the prose with no mechanical consumer. A feature that writes approved
rules/workflows into judge-inert prose would be dead on arrival, so this design
pairs the writer with a consent path that makes the prose live again without
reopening the hole.

Environment fact that shapes the design: repos here are worked by multiple
agents (Claude Code and Codex) that read each other's transcripts and know
about each other. The pipeline already models this — `Turn.assistant`,
`Candidate.assistants`, `evidence.assistants`, dual emit roots (`.claude/`,
`.agents/`). The committed file is therefore the repo's **agent-neutral
operator contract**: it describes how this repo is operated, not how one agent
behaves.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Prose consumer | **Hash-pinned judge context.** The judge sees the committed file's prose only when the local user's pin records a sha-256 of those exact prose bytes. Approving in `review` (or applying a suggestion) pins; any unapproved edit unpins. Unpinned → prose inert, clamps still enforced. Completes the original merged-prose design *through* the hardening: consent, then context. |
| 2 | Consent surface | **`gradient review`.** An unpinned or changed project playbook is presented first in review, as a diff against the last pinned prose; approve pins the bytes. `gradient autopilot status` reports pin state. No new command — review is where consent happens (core promise). |
| 3 | Suggestion source | **Existing miner, repo-routed.** Repo-local sequence chains and strong cadence-less nudges — which today feed only the personal mined region — additionally yield a project-playbook suggestion at ≥3 occurrences across ≥2 sessions in the repo. No new mining machinery. |
| 4 | Write mechanics | **Per-entry provenance tags.** Each applied suggestion appends one bullet under `## Rules` or `## Workflows` ending in `<!-- gradient:<id> -->`. Appends never rewrite existing lines; `gradient remove` deletes exactly the tagged line. Frontmatter is never touched by apply. |
| 5 | Multi-agent stance | **Agent-neutral contract, pooled evidence.** Evidence merges across assistants and the review prompt shows which assistants exhibited the pattern. Prose is written agent-neutral. Today's only mechanical consumer is the Claude Code Stop-hook judge; a Codex-side responder reads the same contract when it exists (deferred, §10). |
| 6 | Pin storage | **Dedicated pin file in the per-project cache** (`playbook-pin.json`: prose sha-256 + pinned prose for diffing). The artifact-approvals ledger was rejected: its entries are manifest-shaped immutable approvals; a pin is rolling consent that moves on every approved hand-edit. |

## 3. Payload and validation

New `SuggestionPayload` variant:

```ts
{ type: "project-playbook"; section: "rules" | "workflows"; text: string }
```

- `text`: single line after normalization, ≤500 chars, `stripUnsafeControls`
  clean, non-empty — validated in `validate.ts` with the same discipline as
  `rule`. It must not contain the literal `<!--`/`-->` sequences or the mined
  markers (splice safety).
- `section` is closed-set. Unknown sections are a validation error, not a
  fallback.
- `suggestion.name` naming and id rules unchanged.

## 4. Mining and routing

`scan` already clusters per repo. Routing additions, no new collectors:

- **Workflows:** a sequence chain confined to this repo (`ChainFinding`) with
  count ≥3 and sessions ≥2 produces a project-playbook suggestion
  (`section: "workflows"`), text rendered like the playbook chain line
  ("After X, the typical next step is Y").
- **Rules:** a repo-local cadence-less nudge with the same threshold produces
  `section: "rules"` only when the same classifier that produces `rule`
  payloads today judges its instruction constraint-shaped; otherwise it stays
  a personal nudge.
- The same pattern still feeds the personal mined region — the project
  suggestion is additive, and the review prompt labels it as writing to the
  committed file, with `evidence.assistants` shown.

## 5. Emitter and apply

New emitter `emit/project-playbook.ts` returning a splice plan rather than a
whole file: `{ section, line }` where `line` is the redacted bullet plus
`<!-- gradient:<id> -->`.

Apply mechanics for this payload type:

- Read the existing `<repo>/gradient.md` (size-capped). Missing file → create
  with a minimal header and empty `## Rules` / `## Workflows` sections, no
  frontmatter (clamps are the team's hand-authored call). Missing section →
  append the section.
- Append the tagged bullet at the end of its section. Never reorder, rewrite,
  or delete untagged lines. A bullet with the same suggestion id already
  present → no-op (idempotent re-apply).
- `assertInside` gains one deliberate, path-exact exception: apply may write
  `<repo>/gradient.md` itself and nothing else outside `.claude`/`.agents`.
- Ordering: write the file → record the exact-bytes approval-ledger entry →
  add the manifest entry (new artifact type `playbook-entry`) → re-pin the new
  prose bytes (apply is consent). The existing rollback-on-manifest-failure
  behavior restores the file; the pin is written only after the manifest
  succeeds, so rollback never has a pin to undo.
- `gradient remove <name>` deletes exactly the tagged line — nothing else,
  including any section heading the line lived under — and re-pins.

## 6. Pinning and the respond pipeline

Pin file: `<projectCacheDir>/playbook-pin.json` —
`{ hash: sha256(prose), prose, pinnedAt }`, mode 0600, written via `safeFs`.

`respond` gate chain, after the existing clamp gate (which is unchanged):

1. Load the project playbook as today. Clamps enforce exactly as before.
2. Hash the prose. Pin present and hash matches → include the prose in the
   judge prompt as a provenance-labeled block, capped at 4,096 chars and
   passed through the redaction pass:

   ```
   PROJECT PLAYBOOK (this repo):
   <pinned prose>

   YOUR PLAYBOOK:
   <personal gradient.md>
   ```

3. No file, no pin, hash mismatch, or unreadable pin file → the prose is
   silently excluded. The stop stands or proceeds on the personal playbook
   alone, clamps still applied.

The pin covers the prose only — `parseProjectPlaybook().prose`, the file minus
its frontmatter block. Frontmatter edits never unpin: clamps can only
restrict, so they need no consent.

`buildJudgePrompt`'s currently unused `_projectPlaybook` parameter becomes live
again; callers pass pinned prose or `""`. The full-mode system sentence
"unless both playbooks' Rules explicitly allow it" is already shipped and now
has real referents.

## 7. Review UX and status

- `gradient review`: when `<repo>/gradient.md` exists and its prose is
  unpinned or differs from the pin, present it **before** mined suggestions:
  a unified diff against the pinned prose (whole file body when never
  pinned), rendered through the terminal-safety filters. Approve → pin.
  Skip → inert, re-offered next review. Quit → untouched.
- `gradient autopilot status` adds one line: `project playbook: pinned` /
  `changed since pin` / `not pinned` / `none`.
- `reviewJson` (plugin surface) includes a `projectPlaybook` field with the
  same four-way state so the plugin skill can surface it.

## 8. Failure directions

Consistent with the house rule — every failure resolves to less automation:

- Unreadable/corrupt pin file → unpinned (prose inert). Never "assume
  consent".
- Malformed frontmatter → clamps to `off` exactly as today; pinning cannot
  override a clamp.
- Splice target unreadable/oversized at apply time → apply fails loudly for
  that suggestion; nothing written, nothing pinned.
- Judge/spawn errors keep failing open (stop stands); pin-check errors fail
  closed (prose excluded). Both directions end at "no added authority".

## 9. Deltas

- `core/types.ts` — payload variant; `ArtifactType` gains `playbook-entry`.
- `core/validate.ts` — project-playbook arm (§3).
- `core/cluster.ts` / `core/sequence.ts` call sites in `scan` — routing (§4).
- `core/emit/project-playbook.ts` (+ `emit/index.ts` dispatch) — splice plan.
- `core/apply.ts` — splice write path, `assertInside` carve-out, re-pin.
- `core/playbook.ts` — pin read/write/hash helpers next to
  `loadProjectPlaybook`.
- `core/judge.ts` — `_projectPlaybook` → `projectPlaybook`, §6 prompt block.
- `commands/respond.ts` — pin gate feeding the judge prompt.
- `commands/review.ts` — playbook diff/pin step; `reviewJson` field.
- `commands/autopilot.ts` — status line.
- `commands/remove.ts` — tagged-line removal + re-pin.
- `commands/list.ts` / `core/bundle.ts` — honest labels for the new
  `playbook-entry` artifact type.
- README — replace the "prose never reaches the judge" description with the
  pinned-consent model.

### Outdated after execution (must be updated in the same change)

- `judge.test.ts`: "embeds only the trusted personal playbook" and "does not
  create a repository playbook section" assert the pre-pinning world —
  rewritten to assert prose inclusion **iff** pinned.
- `respond.test.ts`: "repository prose never reaches the judge prompt"
  becomes "unpinned repository prose never reaches…", plus the positive
  pinned-prose sentinel test.
- The 2026-07-18 amendment note on `2026-07-01-gradient-md-design.md` gets
  one added sentence pointing here: prose now reaches the judge under
  local hash-pinned consent.
- No shipped code becomes dead: the `ProjectPlaybook.prose` field and the
  unused judge parameter — both currently write-only — become consumers'
  inputs.

## 10. Deferred (recorded, not built)

- **Codex-side responder** consuming the same contract file.
- **Autopilot-log mining** (nudges that worked, stand-down reasons) as a
  second suggestion source.
- **Clamp suggestions** (mined `max-mode`/`budget` frontmatter proposals).
- **Cross-agent sequence stitching** (chains spanning Claude and Codex
  transcript streams; today chains are per-stream, evidence merely pooled).

## 11. Testing

- Payload validation: bounds, closed-set section, marker-injection rejection.
- Splice: create/append/idempotent-reapply/remove round-trips on hand-edited
  files; untagged lines byte-identical before and after; frontmatter
  untouched.
- Pinning: match/mismatch/absent/corrupt × respond — prose reaches the judge
  prompt only on exact match (sentinel both directions); clamps unaffected in
  all four.
- Review: never-pinned and changed-since-pin diffs; approve pins exact bytes;
  skip leaves state untouched.
- Apply: re-pin only after manifest success; rollback restores the file and
  leaves the previous pin untouched; `assertInside` still rejects any path
  that is not exactly `<repo>/gradient.md` outside the roots.
- Status and `reviewJson` report all four pin states.
- Multi-assistant evidence renders in the review prompt.
