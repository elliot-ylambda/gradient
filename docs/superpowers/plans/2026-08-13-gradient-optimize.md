# gradient `optimize` — implementation plan

**Spec:** `docs/superpowers/specs/2026-08-13-gradient-optimize-design.md`
**Date:** 2026-08-13
**Shape:** seven phases. Phases 1–3 build the machinery behind the existing
surface, so each is shippable alone and nothing user-visible changes. Phase 4
flips the surface and performs every deletion. Phases 5–7 add the skill, the
page, and headless operation.

---

## The measurement that justifies phase 1

Before planning the removal of the LLM from the suggestion path, read
`core/detect.ts:596-700`. On every model response the code rebuilds the artifact
locally:

| Field | Source |
|---|---|
| `body` | `toolFailureBody` / `ritualBody` / `pasteBody` / `sequenceBody` / `workflowBody` — all local |
| `triggers` | derived from `primary.kind` and the signature — local |
| `title` | `deterministicTitle(primary)` — local |
| `rationale` | template over local evidence counts |
| `cadence` | "Model-authored cadence is untrusted wording and is never allowed to replace or invent it" |
| `evidence`, `id`, `sourceSignatures` | local |
| **`name`** | **model** |
| **`payload.type`** | **model** |
| **`confidence`** | model, but clamped to `inferred` whenever any source candidate is not `high` |

The model contributes a slug and a shape selection. The shape is already implied
by `primary.kind`, which `classify.ts` and `corrections.ts` assign
deterministically. So the LLM call buys a slug.

`degradeToCommands` is **not** the replacement — it filters out `toolfail`,
`ritual`, `correction`, and `answer` kinds entirely, which is why the degraded
path loses precisely the measured tier that the skill file calls "almost always
the best items in the list." Phase 1 builds a real deterministic proposer.

**Gate:** run the existing scan fixtures before and after and diff the
suggestion sets. If a suggestion class is lost, add a deterministic rule for
that class — do not reinstate the LLM call.

---

## Phase 1 — the deterministic proposer

**`core/propose.ts` (create)** — replaces `detect(cands, llm, …)`.

```ts
export function propose(cands: Candidate[], opts?: { limit?: number; onCap?(n: number): void }): Suggestion[]
```

Same ranking (`candidateLeverage`, count, signature) and cap. Then a total
function from candidate kind to payload, replacing the model's two choices:

| `kind` | payload | body builder |
|---|---|---|
| `toolfail` | `rule` when a recovery command was observed, else `command` | `toolFailureRuleText` / `toolFailureBody` |
| `ritual` | `hook` (PostToolUse, `Edit\|Write\|NotebookEdit`) when the command is one line and not `CONSEQUENTIAL_ACTION`; else `command` | `ritualBody` |
| `loop` | `loop`, skipped if `CONSEQUENTIAL_ACTION` | `AUTHORIZATION_GUARD` + reminder |
| `correction` | `rule` | `correctionRuleText` |
| `answer` | `rule`, skipped when `ruleText` returns null | `ruleText` |
| `paste` | `command` | `pasteBody` |
| `sequence` | `command` | `sequenceBody` |
| `unknown`, `instruction` | `command` | `workflowBody` |

`name` comes from `slugFor(candidate)`: `sanitizeName` over the first four
meaningful words of the normalized signature, deduped with a `-2` suffix, capped
at 40 chars for the manifest validator. `confidence` is the minimum across
source candidates. `title`, `rationale`, `evidence`, `id`, `sourceSignatures`,
and `mergeNearDuplicates` are reused unchanged.

**`core/detect.ts` (modify)** — delete `buildDetectPrompt`, `LlmSuggestion`,
`sanitizeClarify`, `degradeToCommands`, `clarifiedWorkflowBody`, the `detect`
function with its timeout race, and the `LLMBackend` import. Keep and export
every body builder, `idFor`, `mergeNearDuplicates`, `byLeverage`,
`AUTHORIZATION_GUARD`, and the action regexes.

**`core/types.ts`** — delete `Clarify`, `ClarifyOption`, `Suggestion.clarify`.
**`core/validate.ts`** — drop clarify validation. **`commands/scan.ts`** — drop
`selectBackend`, `deps.backend`, the `LLMBackend` import, and the "no LLM
backend available" log; call `propose`.

**Tests** — `propose.test.ts`: one case per row, including both branch
decisions; consequential command refused for hook and loop; slug determinism,
collision suffixing, and length cap; confidence is the minimum across sources.
Update `detect.test.ts` and `scan.test.ts`.

---

## Phase 2 — the inspector

**`core/instructions.ts` (create)**

```ts
export interface InstructionSource { path: string; scope: "project"|"user"|"managed"; assistant: Assistant; kind: "claude-md"|"claude-local"|"rule"|"agents-md" }
export interface InstructionLine { source: InstructionSource; line: number; text: string; normalized: string }
export interface InstructionSet { sources: InstructionSource[]; lines: InstructionLine[]; bridge: BridgeState }
export async function loadInstructions(projectDir: string, targets: Assistant[], home?: string): Promise<InstructionSet>
```

All read-only, through `safeReadFile` with a 256KB cap and no symlink traversal:

| Assistant | Paths |
|---|---|
| claude-code | `./CLAUDE.md`, `./.claude/CLAUDE.md`, `./CLAUDE.local.md`, `./.claude/rules/**/*.md`, `~/.claude/CLAUDE.md`, `~/.claude/rules/**/*.md` |
| codex | `./AGENTS.md`, `~/.codex/AGENTS.md` |

Managed-policy locations are read for context and marked `scope: "managed"` so
nothing can propose a change to them. Line extraction follows Spec 7 Decision 3:
a list item or short paragraph line, 8–200 chars, outside code fences and
outside gradient's own marker regions; `normalized` via `cluster.ts#normalize`.

`BridgeState` is `{ agentsMdExists, claudeMdExists, importsAgentsMd, symlinked }`
— CLAUDE.md scanned for an `@AGENTS.md` reference outside code spans and
backticks (docs are explicit that backticked `@paths` stay literal), plus an
`lstat` symlink check.

**`core/surface.ts` (create)**

```ts
export async function loadSurface(projectDir: string, targets: Assistant[], home?: string): Promise<Surface>
```

Enumerates `.claude/skills/*/SKILL.md`, `~/.claude/skills/*/SKILL.md`,
`.agents/skills/*/SKILL.md`, `~/.agents/skills/*/SKILL.md`, and
`.claude/commands/*.md`; parses frontmatter with a bounded flat-YAML reader (no
dependency — skills frontmatter is flat by spec). Per-skill `problems`:

- `unknown-key` — outside `allowed-tools, compatibility, description, license,
  metadata, name` and outside the documented Claude Code extensions
- `description-over-cap` — `description` + `when_to_use` > 1,536 chars
- `no-description` — selection falls back to the first paragraph
- `duplicate-description` — normalized similarity ≥ 0.8 against another skill

Loads the manifest and `adoptionFromEvents` so `unused-30d` needs no recompute.
Also performs Decision 8's two auto-memory checks here rather than in a module
of their own: index size against the 200-line / 25KB load limit, and entries
whose normalized text already appears in CLAUDE.md. Never writes to the memory
directory.

**`core/staleness.ts` (create)** — family 2, the self-fixing core.

```ts
export async function findStaleRefs(lines: InstructionLine[], projectDir: string): Promise<StaleRef[]>
```

References are extracted only from unambiguous forms — backticked spans, and
bare tokens containing `/` or a known source extension — to keep precision high.
Resolution: path-shaped → `lstat` from the project root, retried one level up
for a monorepo root; `npm run <x>` / `pnpm <x>` / `make <x>` → `package.json`
scripts and Makefile targets. A bare command word is **never** reported: a
binary missing from this machine is not evidence the instruction is wrong. Refs
inside fences, and paths matching gitignored build output, are skipped.

**`core/findings.ts` (create)** — the single presentation type.

```ts
export interface Change { path: string; assistant: Assistant; op: "create"|"splice-line"|"replace-line"|"delete-line"|"delete-file"|"prepend-import"; before?: string; after?: string; baseSha?: string }
export interface Finding { id: string; family: Family; severity: "high"|"medium"|"low"; title: string; detail: string; evidence: Evidence; deterministic: boolean; commandBearing: boolean; changes: Change[] }
export function buildFindings(input): Finding[]
```

Family 1 findings wrap a mined `Suggestion` and derive `changes[]` from the
existing `emit()` — no parallel pipeline. Family 7 is a table of pinned
predicates over `InstructionSet` + `Surface` (file over 200 lines; a rule with
no `paths:` whose content only concerns one directory; the same instruction in
both CLAUDE.md and a rules file), not a module.

`id` is a stable hash of `(family, subject, changed paths)` so a denial sticks
across runs through `core/dismiss.ts`. Ranking: severity, then family order
(drift → stale → skill-health → dead-letter → workflow → practice → memory),
then evidence count.

**Tests** — a fixture tree at `test/fixtures/optimize-project/` with a
CLAUDE.md, a rules file, an AGENTS.md, three skills (healthy / unknown key /
over-cap description), a `package.json`, and a deliberately stale path. Unit
tests per module plus one integration test asserting the exact finding set.

---

## Phase 3 — writes

**`core/run.ts` (create)** — built here because this is the phase that needs it.

```ts
export async function beginRun(home?): Promise<Run>
export async function withLock<T>(fn: () => Promise<T>, home?): Promise<T>
export async function snapshot(run: Run, absPath: string, home?): Promise<void>
export async function undoRun(runId: string, home?): Promise<string[]>
export async function pruneRuns(home?, keep = 10): Promise<void>
```

`runId` is `YYYYMMDD-HHMMSS-<6 hex>`; the directory is
`~/.config/gradient/runs/<runId>/` at mode 0700 via `safeMkdir`. The lock at
`runs/.lock` holds `{pid, startedAt}`, goes stale after 10 minutes or a dead
pid, and is taken only by `--apply` / `--auto` / `--undo` — never by a read-only
run. `snapshot` stores `{path, sha256, content}`, once per path per run.
`undoRun` restores a snapshot only if the file still hashes to what the run
wrote, otherwise reports a conflict and leaves it alone.

**`core/playbook-splice.ts` (modify)** — generalize `spliceLine` /
`removeTaggedLine` / `entryTag` from `gradient.md` to any `(host file, heading)`
pair, so AGENTS.md's `## gradient` section reuses the implementation and its
tests wholesale. This replaces the fenced-managed-block design of the first
draft: tagged lines already give per-rule idempotent insert and per-rule
removal.

**`core/apply-change.ts` (create)** — executes one `Change`.

- `create` — a gradient-owned file (`.claude/rules/gradient-<n>.md`,
  `~/.claude/rules/gradient-<n>.md`, a skill directory) carrying
  `artifactMarker` and the `remove with:` comment; registered in the manifest.
- `splice-line` — the AGENTS.md `## gradient` section, via the generalized
  splice. Idempotent; leaves every byte outside the section untouched.
- `replace-line` / `delete-line` — hand-written prose. Requires `baseSha` to
  match the file's current hash **and** the target line to still equal `before`.
  Snapshots first. Never reachable from `--auto`.
- `prepend-import` — the bridge: `@AGENTS.md` as CLAUDE.md's first line, blank
  line after, creating CLAUDE.md if absent.
- `delete-file` — only a path carrying a gradient marker or named by a manifest
  entry.

```ts
export function screenInstruction(text: string): { ok: boolean; reason?: string; commandBearing: boolean }
```

Rejects > 200 chars, a URL, a fenced or indented code block, and the
shell/credential/network lexicon (`curl`, `wget`, `ssh`, `sudo`, `eval`,
`base64`, `token`, `secret`, `api[_-]?key`, `password`, `| sh`, `> /dev/`).
Flags `commandBearing` for a backticked command or a leading
`CONSEQUENTIAL_ACTION` verb; `--auto` refuses those in every family.

**`core/manifest.ts` (modify)** — `ArtifactType` gains `"block-rule"` for a rule
that lives as a tagged line inside AGENTS.md. **`commands/remove.ts` (modify)** —
`block-rule` splices its line out and drops the `## gradient` heading when the
section empties, following the existing `playbook-entry` branch. Without this,
the first `gradient remove` of a Codex rule would unlink the user's AGENTS.md.

**`core/emit/rule.ts`** — `target: "user"` returns
`~/.claude/rules/gradient-<name>.md` instead of `{ printed }`.
**`core/emit/codex-rule.ts`** — returns a `splice-line` change instead of
`{ printed }`.

**Tests** — run dir permissions; lock acquired / released / stale-reclaimed /
live-pid-respected; snapshot idempotent; undo byte-identical; undo refuses a
file changed after the run; prune keeps 10. Splice: insert / idempotent
re-insert / surrounding prose byte-identical / removal empties the section.
Hash precondition: a file mutated between find and apply is refused with
nothing written. Bridge: absent → inserted; imported → no-op; symlinked →
no-op; backticked mention → still inserted. `screenInstruction`: one test per
rejection reason plus a `commandBearing` case that interactive apply allows and
`--auto` refuses. **`remove.ts`: a `block-rule` removal leaves AGENTS.md
present and its other content intact.**

---

## Phase 4 — the verb, and every deletion

**`core/targets.ts` (create)** — the one prompt `optimize` ever issues.

```ts
export function parseTargetFlag(v: string | boolean | undefined): Assistant[] | undefined
export async function ensureTargets(opts, deps): Promise<Assistant[]>
```

Returns `config.targets` when set. When unset and interactive, asks *"Optimize
for Claude Code, Codex, or both?"*, persists, returns. Non-interactive with no
config throws with the exact one-liner (`gradient optimize --target both`).

**`commands/optimize.ts` (create)** — spec §7's flow. `--apply` / `--auto` /
`--undo` wrap the write phase in `withLock`, write `result.json`, call
`pruneRuns`.

**`core/setup.ts` (create)** — the skill-install half of `init.ts`, called on
first run, keeping the `INIT_SKILL_MARKER` ownership check that refuses to
overwrite an unowned file.

**`cli.ts` (rewire)** — the switch becomes: bare report · `optimize` · `remove`
· `on|off` · `hook <target>` · `--version` / `--help` / `help`. `HELP` rewritten
to four verbs. `autopilotStatusReport`'s block moves into `commands/report.ts`
and renders when autopilot is on for the project, which is what lets the
`autopilot` verb go.

**Deletion ledger** — each with its tests:

| Delete | Notes |
|---|---|
| `commands/scan.ts`'s verb wiring | the module becomes `mine()`, called by optimize |
| `commands/review.ts`, `review.test.ts` | walkthrough, clarifier, playbook prompter, `reviewJson` (superseded by `optimize --json`) |
| `commands/apply.ts` verb case | module keeps `loadSuggestions` / `saveSuggestions` / `applyByIds` |
| `commands/init.ts`, `init.test.ts` | logic moves to `core/setup.ts` |
| `commands/bundle.ts`, `core/bundle.ts` + tests | plus `posixShellQuote` / `terminalSafePath` if they lose their last caller |
| `commands/autopilot.ts#autopilotStatus` verb path | folds into the report |
| `RETIRED` map + its `cli.test.ts` cases | Decision 15 |
| alias cases `insights` `stats` `mirror` `list` `review` `continuity` `autopilot` `board` | Decision 15 |
| `case "recall"` + `commands/retire.ts` + `retire.test.ts` | **resolved:** no `gradient recall` hook exists in any settings file on this machine, so there is nothing left to self-remove. Delete outright. |
| `renderInsightsHtml`, `writeInsightsHtml`, `--html` | superseded by the page |
| `emit/command.ts`, `EmitTarget`, `config.emitTarget` | skills only |
| `FEATURES` entry `session-scan` | replaced by `optimize` in phase 7 |

`llm/` is retained for autopilot's Stop-hook judge — the one consumer the skill
cannot replace. After phase 1 its importers are `commands/respond.ts` and
`commands/autopilot.ts`; dropping `init`'s backend probe also drops
`llm/index.ts#defaultCandidates`'s last non-autopilot caller.

**Tests** — `cli.test.ts` rebuilt around four verbs: unknown command exits 2; a
data-driven test over the deleted-verb list asserting each is genuinely unknown
(this shape is what caught the `explain` omission in 0.7.0); `optimize` flag
parsing; `--target` values; non-interactive consent error.

---

## Phase 5 — the skill

**`src/skill/SKILL.md` (rewrite)** — the driver:

1. Run `gradient optimize --json`. One command, not six.
2. Ask the target question if the CLI reports none configured.
3. Read the findings, grouped by family, deterministic flag shown.
4. **Fetch current Claude Code and Codex documentation and release notes** and
   judge the `practice` findings against today's guidance — the CLI ships only
   a pinned baseline and does not pretend to know what shipped this week. Public
   documentation only; no file or transcript content leaves the machine.
5. Author the prose for `dead-letter` and `practice` findings — the part the CLI
   cannot do — and show a diff.
6. Present and confirm per finding. Never apply without explicit approval; never
   enable a background feature unprompted.
7. `gradient optimize --apply <ids>`, then report what changed and how to undo.

Carries forward the existing evidence-quality guidance (measured vs. possible,
restatement worthlessness, `estMinutesSavedPerMonth` is a guess) and the
standing-authorization rule — unchanged truths about the data.

**Tests** — the file parses as valid frontmatter, uses only the six standard
keys, and its description stays under the 1,536-char cap. `setup.test.ts`
inherits `init.test.ts`'s ownership cases.

---

## Phase 6 — the page

**`core/page.ts` (create)** — `renderPage(findings, metrics, runId): string`.

Self-contained: inline CSS and JS, no external reference of any kind, so it
renders identically from `file://`. Light and dark via `prefers-color-scheme`.
Run header, the insights metrics table (absorbing the deleted
`renderInsightsHtml` rows), then one card per finding with family chip,
severity, evidence line, and a `<pre>` diff. Accept/deny per card; a sticky
footer shows the live `gradient optimize --apply a1,c4` line with a copy button.

Every mined string goes through `escapeHtml`; diffs render as text. These
strings come from transcripts and must never be able to inject markup.

**Tests** — output contains no external host reference; a finding titled
`<script>` renders escaped; the apply line is built from ids only; zero
findings renders.

---

## Phase 7 — headless and scheduling

- **`--auto`** — applies only `deterministic && !commandBearing` findings, and
  only `create` / `splice-line` / `delete-file` ops on gradient-owned paths.
  Logs every skipped finding with its reason. `--json` prints
  `{runId, applied[], skipped[], undo}`.
- **`gradient on optimize`** — replaces the `session-scan` feature. Installs a
  `SessionEnd` hook (`gradient hook optimize`) that mines incrementally from a
  per-transcript watermark in the project cache, debounces to one real run per
  24h, and fails open with empty stdout; plus the old `session-scan`
  `SessionStart` surface, printing the single highest-severity pending finding.
- **`--print-schedule`** — prints the exact command to schedule and one cron
  example. gradient installs no timer and owns no daemon; the README carries the
  launchd and systemd variants as documentation.
- **Docs** — `README.md` and `cli/README.md` rewritten around four verbs;
  `plugin/` command list updated. Per the project release rule, `gradient-web`'s
  hero and feature grid must match the new `gradient --help` before the release
  is complete.

**Tests** — `--auto` refuses every non-deterministic family, every
command-bearing line, and every op touching a non-gradient path; the watermark
advances and a second run within 24h is a no-op; the SessionEnd hook returns 0
and writes nothing to stdout when the mine throws.

---

## Risk

| Risk | Mitigation |
|---|---|
| The deterministic proposer is worse than the LLM was | Phase 1's fixture diff is a gate, not a formality; a lost class gets a deterministic rule, not the LLM back |
| A stale-reference false positive edits a correct instruction | Unambiguous reference forms only; project-local paths only; never auto-applies a line edit |
| A concurrent session writes the same file | Advisory lock plus a per-op precondition (a line edit must find its exact text) |
| Transcript text becomes an instruction the agent obeys | `screenInstruction` plus the `commandBearing` bar on `--auto` |
| Removing a Codex rule deletes AGENTS.md | The `block-rule` type and its `remove.ts` branch, with a test asserting the file survives |
| Deleting the readline walkthrough strands non-agent CLI users | `--page` covers review, `--json` covers scripting; called out in the README rewrite |

---

## Execution record

All seven phases shipped, plus an eighth for open-source presentation. Final
state: **930 unit tests across 81 files**, and the packaged dogfood gate at
**18 scenarios passed, 0 failed, 0 skipped** — a real `npm pack`, an offline
install into a disposable consumer, and the installed binary driven against
synthetic Claude Code and Codex histories.

### Where the build diverged from the plan

| Planned | Built | Why |
| --- | --- | --- |
| One apply path for every finding | Two executors behind one `Finding` list | A mined workflow goes through `applySuggestion`, which already knows how to emit for both assistants, install a hook, and record a removable manifest entry. Reimplementing that as a generic `Change` would have been a rewrite of the most safety-critical code in the repository. One list, one renderer, one dismissal key; two well-scoped executors. |
| `--apply` recomputes findings | `--apply` does not re-mine | It is a follow-up to a run the user is already looking at. Re-reading hundreds of transcripts to rebuild findings would make approving a one-line change the slowest thing gradient does. The cheap inspector still re-runs, so a moved file is still caught. |
| `unknown-key` means a skill will not load | It means the skill is not portable | A dogfood run flagged a working installed skill. Claude Code tolerates keys outside its documented set; what they actually break is claude.ai upload, the Skills API, and packaging. Only unterminated frontmatter genuinely stops a load. |
| Setup gated on "did we ask" | Gated on "was anything configured" | `gradient optimize --target both` on a fresh machine configured itself and installed nothing, because the flag path skipped the prompt and therefore skipped setup. |
| `--print-schedule` prints one snippet | Prints the platform's snippet | launchd, cron/systemd, and schtasks respectively. Still printed, never installed. |

### Bugs the work surfaced, all fixed

Five of these were invisible to unit tests and only appeared when the packaged
binary ran against a real machine or a real tarball:

1. **Artifact names built from paths.** `git -C <path> status` produced
   `git-c-redacted-projects-magister-marketi`, spending the whole 40-character
   budget naming the path rather than the habit. `slugFor` now drops flags,
   paths, and redaction placeholders.
2. **A working skill reported as broken.** See the table above.
3. **Frontmatter reader stricter than the product.** It rejected the nested maps
   real skills carry, so a loading skill was reported as unreadable.
4. **Every bulleted line silently refused.** `--apply` compared a finding's
   marker-free `before` against the raw file line, so no `stale` or
   `dead-letter` deletion could ever apply — and it failed silently.
5. **A duplicated `ARTIFACT_TYPES` list** in `approvals.ts` rejected the new
   type. Same shape as the hand-maintained verb list that shipped `explain`
   broken in 0.7.0; now one exported set.
6. **An unreadable suggestion cache failed the whole CLI** instead of degrading
   to empty. A symlinked cache is refused for good reason — degrading rather
   than throwing is what stops that refusal being a denial of service.
7. **The most measured finding labelled "inferred."** Two definitions of
   "measured" had drifted apart; `findings.ts` now uses `isMeasured`, the
   existing predicate, rather than reading the raw evidence field.
8. **Unmatched `--apply` ids did nothing, silently.** Findings are recomputed
   each run, so an id from an earlier run only matches while the thing it
   described is still true. That is now said out loud.

### Deletion ledger, as executed

Deleted outright, with their tests: `commands/review.ts`, `commands/init.ts`,
`commands/bundle.ts`, `core/bundle.ts`, `commands/retire.ts`,
`core/emit/command.ts`, `cli.chain.test.ts`, the `RETIRED` map, every retired
alias in the switch, `renderInsightsHtml`/`writeInsightsHtml`/`--html`,
`EmitTarget`/`config.emitTarget`, `Clarify`/`ClarifyOption`/`resolveClarify`,
and the LLM half of `detect.ts` (renamed to `propose.ts`).

`llm/` is retained: autopilot's Stop-hook judge runs where no agent is in the
loop, and is the one consumer the skill cannot replace.

`recall` keeps a two-line silent fast path in `bin.ts` — not for compatibility,
but because it ran on `UserPromptSubmit`, whose stdout the model reads as
context, and a stray settings entry reaching the unknown-command handler would
inject usage text into a live session.

### Phase 8 — open-source presentation

- A logo: `∇`, the gradient operator, knocked out of the violet→coral brand ramp
  (`assets/logo.svg`, `assets/logo-wordmark.svg`, and the site's `icon.svg`).
- `README.md` and `cli/README.md` rewritten around the four verbs and the
  CLI-is-offline / skill-brings-the-model split.
- The plugin's `scan` skill replaced by `optimize`; manifests and the
  marketplace entry re-described.
- `gradient-web`: hero, feature grid, how-it-works, quickstart capture, FAQ, and
  the whole docs command reference rebuilt for the new surface. Builds clean.
- Version bumped to 0.8.0 across the CLI, the plugin bundle, and the site.
