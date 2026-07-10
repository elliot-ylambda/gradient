# gradient v2 — Close the Funnel — Design

**Date:** 2026-07-06
**Status:** Implementation in progress (Phases A–D complete; Phase E planned)
**Scope:** Spec 4. The v2 feature set: five sequenced phases (A–E), each of
which becomes its own implementation plan. Builds on the shipped analysis
engine (Spec 1), autopilot (Spec 2), and the approved `gradient.md` layering
(Spec 3); nothing here changes those designs.

---

## 1. Context

A dogfooding pass over the author's full history (1,622 transcripts, 4,337
typed prompts) shows where gradient's current funnel — **detect → generate →
adopt** — actually leaks:

- **Adoption is the biggest leak.** The user owns 19 hand-written user-level
  commands plus per-project commands, yet transcript slash usage is almost
  entirely built-ins (`/compact` 138×, `/model` 42×). "merge main into this
  pull request and then review it" was still typed by hand 10+ times while
  `/prep` sat unused. Generating an artifact does not stop the retyping;
  *recall at typing time* does.
- **Detection misses non-lexical patterns.** 1,257 prompts (~29%) are pasted
  build/runtime errors — each textually unique, invisible to the trigram
  clusterer. 36 prompts are the single character "1" (answering Claude's
  numbered questions). Neither becomes a suggestion today.
- **Machine-generated prompts pollute the mine.** One project contains 1,318
  identical CI-injected security-review prompts and 124 "session is being
  continued" summaries. `filter.ts` does not catch these; a scan of that
  project would rank an already-automated prompt as the #1 "habit".
- **Context exhaustion is chronic and coachable.** 138 `/compact`s and 124
  out-of-context continuations across 49 sessions; the user hand-wrote a
  `/sum` command to survive it. 193 interrupted turns and 42 `/model`
  switches are similar coachable signals with obvious config remedies.

Ecosystem check (July 2026): Claude Code has **no native transcript mining**;
skills (`.claude/skills/<name>/SKILL.md`) have superseded legacy
`.claude/commands/*.md` and are **model-invoked** via their frontmatter
`description`; helper tools cluster around orchestration (claude-squad,
vibe-kanban, Conductor) and spend analytics (ccusage). Nobody generates
automations from usage, and nobody closes the adoption loop. Claude Code does
ship a built-in `/fewer-permission-prompts` skill, which caps what we should
build for permission mining (§8).

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Shape | **One spec, five phases (A–E), one implementation plan per phase.** Phases are independently shippable increments in funnel order: fix detection input (A), close adoption (B), deepen detection (C), surface insights (D), distribute (E). |
| 2 | Primary artifact | **Skills replace commands as the default emit target.** `.claude/skills/<name>/SKILL.md` with a mined `description` listing trigger phrasings, so Claude auto-invokes the workflow even when the user forgets it exists. `emitTarget: "command"` remains as a config escape hatch; the command emitter is compat code, not dead code. |
| 3 | Recall mechanism | **A `UserPromptSubmit` hook (`gradient recall`) that matches the typed prompt against installed artifacts and injects a one-line context hint.** LLM-free, index-backed, fail-open, <50 ms target. It cannot rewrite the prompt (Claude Code offers no such control) — injected context telling Claude "this matches the user's `/prep` skill" is the strongest available lever and also *executes* the workflow. |
| 4 | New payload types | **One addition to `SuggestionPayload`: `rule` (writes `.claude/rules/gradient-<name>.md`) — nothing else.** Error-paste and answer mining reuse existing `command` (→ skill) plus `rule`; paste-driven arbitrary-command hooks were rejected as an unnecessary execution surface. Unknown payload types found in `suggestions.json` are skipped with a log line (forward compatibility), same tolerant-reader stance as `gradient.md` clamps. |
| 5 | User-global rule targets | **Project rules are written; user-global rules are only printed.** gradient never edits `~/.claude/CLAUDE.md` — it is the user's file with no marker region. Project rules go in gradient-owned files under `.claude/rules/`, manifest-tracked and cleanly removable. |
| 6 | Machine-prompt filtering | **Classify, don't just drop.** `filter.ts` grows a classifier that tags machine-generated prompts (CI-injected, continuation summaries, task notifications, template floods). Mining excludes them; `insights` (Phase D) consumes the classifications as signals. |
| 7 | Adoption data | **Local only, derived from transcripts + a hook event log.** Uses of artifacts are counted from `<command-name>` tags in transcripts; near-miss retypes come from the recall hook's log. No telemetry leaves the machine, ever. |
| 8 | Permission mining | **Not built.** Claude Code's built-in `/fewer-permission-prompts` covers it; `insights` links to it instead. Building a worse in-house copy fails YAGNI. |
| 9 | Multi-assistant | **Still deferred**, but Phase E's bundle layout keeps emitters pluggable so a Codex/`AGENTS.md` emitter is additive later. |
| 10 | Dependencies | **Zero new runtime dependencies**, as in v1. All new hooks are fail-open and exit 0 unconditionally, matching `respond`'s contract. |

---

## 3. Phase A — Honest input & skills output (foundation)

### A1. Machine-prompt classifier

`core/filter.ts` gains a classification layer:

```ts
export type PromptClass =
  | "human"            // mine this
  | "injected"         // existing INJECTED_PATTERNS (unchanged)
  | "continuation"     // "This session is being continued from a previous…"
  | "notification";    // "<task-notification>…"

export function classifyPrompt(text: string): PromptClass;
```

- `filterPrompts` keeps its signature and now returns only `"human"` turns;
  a new `classifyPrompts(turns)` returns per-class buckets for Phase D.
- `ci-template` is a post-cluster classification rather than a `PromptClass`:
  it needs occurrence and session counts that do not exist on an individual
  turn. `isTemplateFlood(candidate)` supplies that signal to `scan` and Phase D.
- **Template-flood heuristic** (numbers pinned by fixtures in the plan): a
  cluster is `ci-template` when its normalized signature exceeds ~240 chars
  **and** occurrences-to-sessions ratio is ≈1 **and** count ≥ ~25 — human
  habits are short or repeated within sessions; injected templates are long,
  once-per-session, and voluminous. Applied post-cluster in `scan` so single
  pastes are unaffected.
- Config gains `ignorePatterns?: string[]` (regex strings, applied verbatim
  in `classifyPrompt`) for site-specific injectors.
- Fixture: a captured (redacted) sample of the 1,318-prompt security-review
  flood becomes a regression test — the scan of that fixture must produce
  zero suggestions from it.

### A2. Skills emitter + intent merge

- `core/types.ts`: `ArtifactType` gains `"skill"`. The `command` payload
  gains optional `triggers?: string[]` (distinct mined phrasings). No new
  payload variant — the emit target decides the format.
- `core/emit/skill.ts`: emits `.claude/skills/<name>/SKILL.md`:

  ```markdown
  ---
  name: <sanitized name>
  description: <title>. Use when the user says things like: "lgtm",
    "looks good", "ship it".
  ---
  <body>
  ```

  Frontmatter values emitted as JSON string scalars (same injection guard as
  `emitCommand`). No `disable-model-invocation` — auto-invocation is the
  point. `emit(s)` grows an options arg — `emit(s, { target })` with target
  resolved by callers from `config.emitTarget ?? "skill"` — so `emit` stays
  config-free and testable.
- `core/apply.ts`: skill writes go through `assertInside(join(projectDir,
  ".claude"))` unchanged; manifest entry `type: "skill"`, `path` = the
  SKILL.md file. Apply refuses to overwrite a same-named untracked artifact,
  while reapplying the same manifest-owned artifact remains supported.
  `remove` deletes the skill *directory* when it becomes empty.
- `core/detect.ts` prompt changes: (1) instruct the model to **merge
  same-intent clusters** before typing them (the `lgtm` / `looks-good`
  duplicate becomes one suggestion with both `triggers`); (2) return
  `triggers` for command-type suggestions; (3) allowed types now read
  "command (emitted as a Claude Code skill)".
- `gradient migrate` (new command): converts manifest-tracked
  `.claude/commands/*.md` entries to skills — writes the skill, updates the
  manifest entry, deletes the old command file. Only touches
  gradient-authored files (manifest is the source of truth), and skips unsafe
  source paths or collisions with untracked skills. Prints a summary;
  `--dry-run` supported.

### Testing (A)

- Classifier: each class; template-flood boundary cases; `ignorePatterns`.
- Regression fixture: security-review flood → zero suggestions.
- Skill emit: frontmatter injection attempts; trigger list rendering;
  `emitTarget` fallback to command.
- Migrate: converts + deletes + re-points manifest; non-gradient files
  untouched; dry-run writes nothing.

---

## 4. Phase B — Recall & adoption (close the loop)

### B1. `gradient recall` — UserPromptSubmit hook

- **Install:** `gradient recall on|off|status`, reusing
  `core/settings.ts#installHook` / `removeHook` (event `UserPromptSubmit`,
  command `gradient recall`, timeout 5). Per-project, like autopilot.
- **Index:** `.gradient/recall.json`. One entry per installed artifact:
  `{name, kind, invocation ("/prep"), triggers: string[], signature}` where
  `signature` is the normalized body's first ~200 chars. Also indexes
  *hand-written* commands/skills found on disk (`.claude/commands/*.md`,
  `.claude/skills/*/SKILL.md`, and their `~/.claude` user-level
  equivalents) — recall must cover `/prep`, not just gradient's own output.
- **Freshness:** built by `gradient recall on` at install time; rebuilt by
  `apply`, `remove`, `migrate`, and `scan`; and self-healing on the hot
  path — the index records `builtAt`, and `recall` checks the four artifact
  roots plus the relevant command/skill file mtimes before rebuilding inline
  when any is newer. Hand-edited artifacts therefore surface without any
  gradient command running first; the index remains small enough for this
  local metadata walk to stay inside the hook's latency target.
- **Hot path** (mirrors `respond`'s gate style, but LLM-free):
  1. Read stdin JSON `{prompt, cwd, session_id}`; empty/parse failure → exit
     0, no output.
  2. Prompt shorter than ~15 chars or starting with `/` → exit 0 (never
     hint on nudges or existing slash use).
  3. Load index (single small JSON read). Normalize prompt
     (`cluster.ts#normalize`), compare against triggers + signatures with
     `cluster.ts#similarity`; N is dozens, so no LSH needed.
  4. Best match ≥ 0.55 (pinned by fixtures) → emit:

     ```json
     { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
         "additionalContext": "The user's prompt closely matches their installed skill \"/prep\" (mined from their own history). Prefer following that skill's workflow." } }
     ```

  5. Append `{ts, artifact, similarity, hinted}` to
     `.gradient/adoption.jsonl` (also on near-misses ≥ 0.4, for stats).
     Log write failures are swallowed; the hint still ships.
  - Every path exits 0. No spawn, no network. Target <50 ms.

### B2. Adoption stats

`stats` owns the adoption section; project-scoped Phase D `insights` consumes
its unused-artifact signal only to route users back to `gradient remove`:

- **Uses:** count `<command-name>/x</command-name>` occurrences in the
  project's transcripts since each artifact's `createdAt` (skill and command
  invocations both surface as command tags; verify against a live fixture in
  the plan — an open question below).
- **Retypes caught:** matches from `adoption.jsonl`.
- **Output per artifact:** `uses · last used · retypes caught`, plus a
  nudge: artifacts with 0 uses and 0 matches for 30+ days → "consider
  `gradient remove <name>`".

### Testing (B)

- Hook I/O: malformed stdin, short prompts, slash prompts, no index, corrupt
  index — all exit 0 silently.
- Matching: exact trigger hit; fuzzy body hit; below-threshold miss; the
  real "merge main into this PR" vs `/prep` case as a fixture.
- Index rebuild on apply/remove/migrate (remove must drop entries — a stale
  index must never hint at a deleted artifact).
- Adoption counting excludes uses before `createdAt`; unused-artifact nudge.

---

## 5. Phase C — New detectors (mine the other 29%)

### C1. Error-paste detector

- `core/paste.ts`: pre-cluster classifier for `"human"` prompts with
  `length > ~400` and error markers (`error|exception|failed|traceback|…`).
  Extraction key = a strict executable plus optional harmless-looking
  subcommand, or only the error class. Arguments, URLs, credentials, PII, and
  arbitrary free-form headers are dropped — pasted
  output of the same failing command shares its head (`make dev …`,
  `xcodebuild …`) even when bodies differ.
- Groups with ≥3 occurrences become `Candidate`s with a new `kind:
  "paste"` hint and the key as `signature`; they bypass trigram clustering
  (which cannot see them) and join the normal detect window.
- `detect.ts` turns paste candidates into an **advisory troubleshooting skill**.
  It may inspect output the user supplies, but prior pasting is never permission
  to rerun the command or take side effects; consequential actions require
  explicit confirmation in the current conversation.
  `PostToolUseFailure` was deliberately rejected: no gradient subcommand owns
  arbitrary failure repair, and executing inferred commands from a hook would
  add a new security boundary for no product benefit.
- Paste-shaped groups still pass through the Phase A count/session flood gate,
  so machine injectors cannot bypass template filtering by containing an error
  marker.
- Evidence lines in `review` show the reconstructed command, never the
  pasted bodies (redaction unchanged).

### C2. Answer mining → rules

- `core/parse.ts` gains an opt-in mode that also yields assistant text turns so
  Q→A pairs can be built; generic tool blocks remain ignored. Structured
  `AskUserQuestion` results are reconstructed from their explicit question and
  user-authored answer fields rather than mining the synthetic tool wrapper.
  The default user-prompt mining path is unchanged.
- `core/answers.ts`: a Q→A pair is (assistant turn whose tail looks like a
  question) followed by a short (≤40 chars) semantic answer in the same
  session. Only low-impact formatting/style/tool-preference questions qualify;
  yes/no, ordinals, secrets/PII, and consequential approvals are rejected.
  Pairs cluster by normalized answer + question-topic similarity. Repeats ≥3
  across ≥2 distinct sessions → candidate. Cross-project scans skip this pass.
- `detect.ts` gains payload type `rule`:

  ```ts
  { type: "rule"; target: "project" | "user"; ruleName: string; text: string }
  ```

- `core/emit/rule.ts`: `target: "project"` → writes
  `.claude/rules/gradient-<ruleName>.md` (manifest-tracked, removable);
  `target: "user"` → printed only (Decision 5).
- Rule target and text are constructed locally, never copied from model output.
  Rules explicitly preserve confirmation for commands, changes, external or
  production actions, publishing, deletion, spending, credential use, and data
  disclosure. Positional answers such as "1" never become standing rules.

### Testing (C)

- Paste keying: same command / different bodies group; different commands
  don't; sub-400-char errors ignored.
- Q→A precision on redacted fixtures; production confirmations, secrets,
  one-session repetitions, and positional answers produce no rule.
- Rule emit: project write path + manifest + remove; user target never
  writes; name sanitization.

---

## 6. Phase D — `gradient insights` (the report card)

- New command: `gradient insights [--user] [--html]`. Local-only; no LLM
  required (and none used — the numbers speak).
- `--user` uses the same `userScopeDays` window as `scan --user` (seven days
  by default). Project scope remains all history.
- **Division of labor:** `stats` stays the *artifact* view (pattern coverage
  + B2 adoption per artifact); `insights` is the *behavior* view (the metric
  table below + recommendations). Neither duplicates the other's sections.
- One collect+parse pass (reusing `classifyPrompts` from A1) computes:

  | Metric | Source | Paired recommendation |
  |---|---|---|
  | Nudges typed | nudge lexicon over human prompts | `gradient autopilot nudge` (or "already on — N avoided", from autopilot session logs) |
  | Context deaths | `continuation` class + `/compact` command tags | continuity pack (below) |
  | Interrupted turns | `[Request interrupted` markers | "consider plan mode for big asks" (informational) |
  | Error pastes | C1 classifier | the paste-derived skill suggestions |
  | Model/effort churn | `/model`, `/effort` tags | per-project `defaultModel` in `.claude/settings.json` |
  | Adoption | B2 data | unused-artifact removals, recall hook if off |
  | Permission friction | n/a (not mined, Decision 8) | pointer to built-in `/fewer-permission-prompts` |

- Every metric renders as a number. Hot metrics cross conservative thresholds
  into recommendation lines, most of which are existing gradient actions;
  the permissions pointer always renders. Insights is a router into the
  product, not a dashboard for its own sake. Unused-artifact removal appears
  only in all-history project scope; a seven-day user corpus cannot safely
  prove 30-day non-use.
- `--html` writes a self-contained `.gradient/insights.html` (inline CSS, no
  deps) for sharing; terminal output is the primary surface. The write uses the
  same symlink-safe private-file boundary as other `.gradient` artifacts.
- **Continuity pack** (the productized `/sum`): an explicit opt-in manager,
  `gradient continuity on|off|status`, installs `PreCompact` → existing
  `gradient checkpoint`, plus `SessionStart` (matcher `resume|compact`) → new
  `gradient recap`. `checkpoint` stores a bounded, redacted recent conversation
  tail (via `core/tail.ts`) plus recent user intents in the private per-project
  user cache. `recap` returns it inside an explicit untrusted-context wrapper.
  Both hook targets independently require private per-project consent, so a
  committed or stale hook is inert. Nothing is installed until the user runs
  `continuity on`; `off` revokes consent before removing only these two hooks.

### Testing (D)

- Each metric against a synthetic fixture with known counts.
- Insights runs green on an empty/new project (all zeros, no crash).
- `recap` is silent (exit 0) when consent or the private checkpoint is absent;
  symlinked caches and injected wrapper tags are rejected/neutralized.
- HTML output contains no external references (CSP-safe single file).

---

## 7. Phase E — `gradient bundle` (team distribution)

- `gradient bundle <name>`: packages **manifest-tracked, approved** artifacts
  into a Claude Code plugin:

  ```
  .gradient/bundle/<name>/
    .claude-plugin/plugin.json   # {name, description, version}
    skills/<skill>/SKILL.md
    hooks/hooks.json             # only gradient-subcommand hooks the user opts to include
    README.md                    # provenance: generated by gradient from usage evidence
  ```

- Skill bodies are copied as-is; evidence counts (personal telemetry) are
  **stripped** from anything bundled — same privacy stance as Spec 3's
  suggest-only project file.
- Prints the `marketplace.json` snippet for hosting the bundle in a git repo;
  publishing itself stays manual (out of scope).
- Hooks that reference `gradient` subcommands are included only with
  `--with-hooks`, and the README documents that teammates need `gradient`
  installed for them — skills-only bundles have zero dependencies.
- Rules files (`C2`) are bundleable the same way once they exist.

### Testing (E)

- Bundle contains only manifest entries; unapproved suggestions never leak.
- plugin.json validity; evidence stripping; `--with-hooks` gating.
- Round-trip: `claude --plugin-dir` smoke instructions documented (manual).

---

## 8. Explicitly out of scope (YAGNI)

- **Permission mining** — built-in `/fewer-permission-prompts` owns it
  (Decision 8); insights links, we don't rebuild.
- **Prompt rewriting / blocking** in the recall hook — hint-only; blocking a
  typed prompt because it resembles a command would be infuriating.
- **Marketplace publishing / registry hosting** — bundle emits files; git
  hosting is the user's.
- **Multi-assistant emitters** (Codex `AGENTS.md`) — layout keeps the door
  open (Decision 9); no code now.
- **Embeddings clustering, daemon/watch mode, desktop notifications, local
  LLM backend, MCP wrapper** — all still deferred from Specs 1–2.
- **Editing `~/.claude/CLAUDE.md` or answering permission prompts** — never.

## 9. Sequencing & dependencies

```
A (classifier + skills + migrate)
└─→ B (recall index needs triggers + skills on disk)
      └─→ D (insights consumes A's classes + B's adoption data; degrades gracefully without B)
A ─→ C (detectors feed the A2 detect prompt; independent of B)
A ─→ E (bundle packages skills; benefits from C's rules)
```

Each phase lands as its own branch + implementation plan
(`docs/superpowers/plans/…`), test-first, matching Specs 1–3. Spec 3
(`gradient.md`) ships before any of this — Phase A touches the same
`scan.ts` seams.

## 10. Dead code & outdated content (removed as part of execution)

- `gradient migrate` deletes converted `.claude/commands/*.md` files and
  re-points their manifest entries (A2) — no orphaned command files.
- `remove`/`apply`/`migrate` rebuild `.gradient/recall.json`; a removed
  artifact must vanish from the index in the same operation (B1).
- `detect.ts`'s prompt text describing "command (a repeated instruction →
  slash command)" is replaced by the skills wording (A2) — no stale
  instruction text.
- README + `cli/README.md`: "slash commands" → "skills"; the "v1 analysis
  engine" status section is rewritten around the funnel (A–E) once Phase A
  merges; Quickstart gains `recall`/`insights` once shipped.
- `stats`'s coverage section is subsumed by the adoption view (B2) — the old
  coverage-only rendering is removed, not kept alongside.
- `emit/command.ts` is **retained deliberately** as the `emitTarget:
  "command"` compat path (Decision 2) — compat, not dead code.

## 11. Open questions for the implementation plans

- **A1:** exact template-flood constants (char floor, count floor, ratio
  band), pinned against the captured security-review fixture.
- **B1 (resolved 2026-07-09):** the current Claude Code hooks reference
  documents `hookSpecificOutput: {hookEventName: "UserPromptSubmit",
  additionalContext}`; Phase B ships that structured form.
- **B2 (resolved 2026-07-09):** live transcripts contain skill invocations
  such as `/codex` and `/plan-review` in `<command-name>` tags, matching custom
  command invocations; usage counting is pinned to that shared representation.
- **C2 (resolved 2026-07-09):** use both assistant text whose final 40
  characters contain `?` and structured `AskUserQuestion` results. A local
  30-day sample (1,730 transcripts) contained 514 structured results and 840
  qualifying adjacent short-answer pairs; ignoring tool results would miss a
  material share of real preference answers. Generic tool output remains
  excluded.
- **D (resolved 2026-07-09):** `insights --user` shares `scan --user`'s
  `userScopeDays` window (seven days by default). Consistency keeps the report
  bounded and makes the label unambiguous.
- **E:** minimum viable `plugin.json` fields for current Claude Code plugin
  loading (`name`, `description`, `version` assumed; verify).
