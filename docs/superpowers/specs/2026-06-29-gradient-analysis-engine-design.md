# gradient — v1 Analysis Engine: Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming complete; implementation plan pending)
**Scope:** First shippable sub-project of the `gradient` product.

---

## 1. Product context

`gradient` is an open-source toolkit for Claude Code power users. It reads a
user's own Claude Code history, learns what they repeat, and helps them automate
it. The full product has three capabilities:

1. **Autopilot loop** — an LLM-driven `Stop` hook that auto-responds ("continue
   until actually done") so the user stops manually nudging Claude. *(Phase 2 —
   not this spec.)*
2. **Habit miner** — detect recurring workflows and propose loops/automations.
3. **Slash-command generator** — turn repeated prompts into `.claude/commands/*.md`.

This spec covers the **analysis engine** (capabilities 2 + 3, plus a third
artifact type discovered during research — hook suggestions). The autopilot loop
is deferred to its own spec.

### Why analysis-engine-first

It is offline and read-only (no live hook to get wrong), fully testable against
static transcript files, and immediately useful on real history. It also builds
the shared foundation (transcript access, LLM backend, artifact emission) the
autopilot will reuse.

### Validation against real data

A manual dogfooding run over the author's real history (2,800 transcripts,
~1.0 GB, 4,992 typed prompts) confirmed the premise and the design:

- ~150 `continue` variants + ~23 `what's next?` → the dominant pattern (motivates
  the phase-2 autopilot, and shows the engine must rank by raw frequency).
- `/compact` used **143×** → long context-bound sessions → motivates a
  **hook** suggestion (a `PreCompact` auto-checkpoint), proving a third artifact
  type beyond slash-commands and loops.
- A rigid delivery workflow repeated 4–14× each: "write the implementation plan",
  "review the spec then write the plan", "push and create a PR and review it",
  "give me the PR link", "merge main into this PR" → concrete slash-command
  candidates (`/plan`, `/ship`, `/next`, `/merge-main`).
- Injected scaffolding leaked into the raw extract ("review this change" ×849 from
  a review hook; "base directory for" ×492 from the skill loader) → the engine
  **must filter hook/skill/system-injected text** or it will "discover" Claude
  Code's own plumbing.

---

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | First sub-project | Analysis engine (offline); autopilot loop is phase 2 |
| 2 | Primary interface | CLI-first (`npx gradient`); core library + thin CLI; MCP deferred |
| 3 | Output behavior | Suggest **and generate** the artifact, but the **human enables it** (review/approve flow); nothing auto-schedules |
| 4 | Artifact types | Slash commands, loop/schedule suggestions, **and** hook suggestions |
| 5 | Stack | TypeScript / Node, distributed via `npx` |
| 6 | LLM backend | `claude` CLI headless (`claude -p --output-format json`, reuses existing auth) by default; Anthropic SDK + `ANTHROPIC_API_KEY` fallback; behind one `LLMBackend` interface |
| 7 | Detection strategy | **A** — cheap local extract + cluster (no LLM), LLM only confirms/names/emits the top-N candidates |
| 8 | Driver model | LLM-as-judge/driver for the formalize step |
| 9 | Generated hooks | Emitted hooks invoke a `gradient` subcommand, **never** bespoke inline shell; v1 ships the minimal helper subcommands its emitted hooks need (`checkpoint`) |

### Reference architecture

Patterns adopted from **Graphify** (`../graphify`, a shipping YC S26 Python CLI
with the same integration surface):

- **Pipeline of single-purpose modules** — each stage is one function, plain data
  in/out, no side effects outside the output dir.
- **Provider registry for the LLM** — Graphify independently uses a `claude-cli`
  backend (`claude -p --output-format json`, reusing Claude Code auth) alongside
  API-key and local (`ollama`) backends. This validates decision #6.
- **Confidence labels** (`EXTRACTED`/`INFERRED`/`AMBIGUOUS` → here: high / inferred
  / flagged-for-review).
- **`validate` + `security` modules** gating all external input and schema.
- **`install`/`uninstall`** that writes a thin skill file into the assistant's
  config dir — note the separation between the tool's *own* install target
  (`~/.claude/skills/gradient/`) and the **artifacts it generates for the user**
  (`.claude/commands/*.md`).

Graphify's language (Python) was **not** adopted; TS/npx wins on clone-and-go and
matches where the phase-2 autopilot work lands.

### Generated hooks call `gradient`, not bespoke shell

Auto-authoring arbitrary inline shell into a user's `settings.json` hook is
fragile (quoting/escaping, cross-platform) and unsafe to generate from an LLM.
So every hook `gradient` emits points at a **small, tested `gradient` subcommand**
instead:

```jsonc
// emitted by emit/hook.ts — note the command is a gradient subcommand
{ "hooks": { "PreCompact": [ { "hooks": [
  { "type": "command", "command": "gradient checkpoint" } ] } ] } }
```

Consequences for v1:

- v1 ships exactly the **hook-helper subcommands** required to back the hooks it
  can emit. The only evidence-backed hook in v1 is `precompact-checkpoint`
  (143 `/compact`s), so v1 ships `gradient checkpoint` — a tiny command that writes
  a progress snapshot (e.g. `progress.md`) before compaction.
- `emit/hook.ts` may **only** emit a hook whose backing subcommand exists; the
  schema gate (`validate.ts`) rejects any hook referencing an unknown subcommand,
  so `gradient` never writes a broken hook.
- New hook types in future versions arrive as new helper subcommands, not as new
  inline-shell templates.

---

## 3. Architecture

A pure-functional **core library** wrapped by a thin **CLI**, with a pluggable
**LLM backend**.

```
src/
  cli.ts                 # arg parse + dispatch (thin)
  config.ts              # load/save config (~/.config/gradient + project .gradient/)
  commands/              # one file per verb
    scan.ts review.ts apply.ts list.ts remove.ts init.ts
    checkpoint.ts        # hook-helper verb: writes a progress snapshot (backs the PreCompact hook)
  core/
    collect.ts           # scope → transcript file paths
    parse.ts             # JSONL → Turn[]   (prompts, tool-uses, ts, project, branch)
    filter.ts            # strip hook/skill/system-injected text → genuine prompts
    cluster.ts           # frequency + textual-similarity grouping → Candidate[]  (NO LLM, pure)
    detect.ts            # top-N candidates → LLM → Suggestion[]  (graceful no-LLM path)
    emit/
      command.ts         # Suggestion → .claude/commands/<name>.md content
      loop.ts            # Suggestion → ready-to-run /loop or /schedule line
      hook.ts            # Suggestion → settings.json snippet that calls a gradient subcommand
    manifest.ts          # .gradient/manifest.json  (track generated artifacts → reversible)
    validate.ts          # schema-gate Suggestions + artifacts
    security.ts          # path containment, name sanitize, secret redaction
  llm/
    backend.ts           # LLMBackend interface
    claudeCli.ts         # `claude -p --output-format json`  (default, key-free)
    anthropic.ts         # Anthropic SDK + ANTHROPIC_API_KEY  (fallback)
    index.ts             # auto-detect & select backend
skill/
  SKILL.md               # the /gradient skill template installed by `init`
tests/                   # one spec per core module + fixture transcripts
```

### Module responsibilities

| Module | Function (sketch) | Input → Output |
|--------|-------------------|----------------|
| `collect.ts` | `collect(scope)` | scope (project/all/since) → `string[]` file paths |
| `parse.ts` | `parse(path)` | JSONL file → `Turn[]` |
| `filter.ts` | `filterTurns(turns)` | `Turn[]` → genuine user prompts (injected text removed) |
| `cluster.ts` | `cluster(prompts, toolSeqs)` | prompts → `Candidate[]` (freq + similarity), **pure, no LLM** |
| `detect.ts` | `detect(candidates, llm)` | top-N `Candidate[]` → `Suggestion[]` |
| `emit/command.ts` | `emitCommand(s)` | `Suggestion` → `{path, content}` for `.claude/commands/*.md` |
| `emit/loop.ts` | `emitLoop(s)` | `Suggestion` → ready-to-run `/loop`/`/schedule` line |
| `emit/hook.ts` | `emitHook(s)` | `Suggestion` → `settings.json` snippet calling a `gradient` subcommand |
| `checkpoint.ts` | `checkpoint()` | session context → writes a progress snapshot (backs PreCompact hook) |
| `manifest.ts` | `add/list/remove` | manifest CRUD |
| `validate.ts` | `validateSuggestion(x)` | object → validated or throws |
| `security.ts` | `assertInside`, `sanitizeName`, `redact` | input → safe or throws |

---

## 4. Data model

```ts
// One genuine history event after parse+filter.
type Turn = {
  ts: string;            // ISO timestamp
  project: string;       // last path segment of cwd
  branch?: string;       // gitBranch if present
  role: "user" | "assistant";
  text?: string;         // typed prompt (user) — injected text already removed
  toolUses?: string[];   // tool names invoked (assistant)
};

// Pre-LLM grouping produced by cluster.ts (no model involved).
type Candidate = {
  kind: "command" | "loop" | "hook" | "unknown";
  signature: string;     // normalized key the cluster grouped on
  examples: string[];    // a few representative raw prompts
  count: number;         // frequency across history
  confidence: "high" | "inferred" | "flagged"; // exact repeat vs fuzzy vs weak
};

// Post-LLM, ready to present/emit.
type Suggestion = {
  id: string;            // stable hash of signature
  type: "command" | "loop" | "hook";
  name: string;          // e.g. "ship"
  title: string;         // human summary
  rationale: string;     // why, with evidence
  evidence: { count: number; sessions: number };
  confidence: "high" | "inferred" | "flagged";
  artifact:
    | { kind: "command"; path: string; content: string }
    | { kind: "loop"; command: string }              // a line the user runs
    | { kind: "hook"; event: string; subcommand: string; settingsPatch: string };
    //   hook always invokes a gradient subcommand; `subcommand` must exist (validate.ts)
};
```

- **Suggestions cache:** `.gradient/suggestions.json` (output of `scan`).
- **Manifest:** `.gradient/manifest.json` — `[{ name, type, path, createdAt, suggestionId }]`.

---

## 5. Data flow

- **`scan`** → `collect(scope) → parse → filter → cluster → detect(LLM) → validate`
  → write `suggestions.json` + print summary. **Read-only** on the user's project.
  Flags: `--since 7d`, `--all` / `--project <path>`, `--type command|loop|hook`,
  `--json`, `--limit N`.
- **`review`** → read cache → walk suggestions interactively → on approve:
  `emit(type) → security check → write artifact → manifest.add`.
- **`apply <id…>`** → same emit/write path, non-interactive (CI/scripting).
- **`list`** → read manifest → print generated artifacts.
- **`remove <name>`** → delete artifact + manifest entry (clean uninstall).
- **`init`** → write config; self-install the `/gradient` skill into
  `~/.claude/skills/gradient/SKILL.md`.
- **`checkpoint`** → *not a primary user verb;* invoked by a generated PreCompact
  hook to write a progress snapshot before compaction. Ships in v1 only to back the
  `precompact-checkpoint` hook the engine can emit.

Two distinct write targets, kept separate by design:
- Tool's own install: `~/.claude/skills/gradient/` (via `init`).
- Generated user artifacts: `.claude/commands/*.md`, plus printed `/loop` lines and
  `settings.json` patches (via `review`/`apply`).

---

## 6. Error handling & guardrails

- **Graceful LLM degradation:** `high`-confidence (exact-repeat) candidates can
  become Suggestions **without** the LLM, so `scan` still produces value when
  `claude` is absent and no API key is set. LLM is required only to formalize
  `inferred`/`flagged` candidates.
- **No silent truncation:** the model sees only the top-N candidates; the cap and
  the count of dropped candidates are printed every run.
- **Resilient parsing:** malformed JSONL lines are skipped and counted; subagent /
  sidechain lines and tool-result blocks are excluded; "no transcripts found" is an
  explicit, friendly error.
- **Path safety:** `security.ts` refuses to write outside approved directories
  (`.claude/commands/`, `~/.claude/skills/gradient/`) and sanitizes artifact names.
- **Idempotency:** `review`/`apply` are idempotent via the manifest — re-approving
  an existing suggestion updates rather than duplicates.
- **Suppress already-covered patterns:** before suggesting, scan existing
  `.claude/commands/` and skills; do not re-propose a command the user already has
  (e.g. their existing `/build`).
- **No broken hooks:** `emit/hook.ts` may only reference a `gradient` subcommand
  that exists; `validate.ts` rejects any hook naming an unknown subcommand, so a
  generated hook is always runnable.

---

## 7. Privacy

- Approach A minimizes exposure: only small candidate snippets reach the model,
  never whole transcripts.
- A **redaction pass** (`security.redact`) strips obvious secrets/keys/env values
  before any LLM call.
- Default backend (`claude` CLI) keeps auth local but still sends snippets to
  Anthropic; the `LLMBackend` interface leaves a clean seam for a **local backend**
  (Graphify's `ollama` pattern) in a later version.

---

## 8. Testing strategy

- One unit spec per `core/` module, run against **fixture transcripts** committed
  under `tests/fixtures/`. No network, no filesystem writes outside a temp dir.
- `detect.ts` tested with a **mocked** `LLMBackend`; a separate **contract test**
  for `claudeCli.ts` JSON parsing of `claude -p --output-format json`.
- **Golden tests** for each `emit/` module (Suggestion → exact artifact content).
- One **integration test**: fixtures dir → `scan` → assert cache contents →
  `apply <id>` → assert files written + manifest updated.

---

## 9. Explicitly out of scope for v1 (YAGNI)

These are clean later additions; none is required now, and none should be stubbed:

- The **MCP server** wrapper (`gradient-mcp`).
- The **autopilot loop** / any live `Stop`-hook behavior (phase 2, own spec).
- `stats` and `explain` commands.
- **Embeddings**-based clustering (v1 uses normalization + textual similarity).
- **Multi-assistant** install (v1 targets Claude Code only).
- A **local LLM** backend (interface leaves room; not implemented in v1).

---

## 10. Open questions for the implementation plan

- Exact CLI framework (e.g. a minimal hand-rolled parser vs a small dep) — keep
  dependencies lean for `npx` startup cost.
- Clustering specifics in `cluster.ts`: normalization rules + similarity metric
  (token Jaccard / trigram) and thresholds — to be pinned with fixtures.
- Interactive `review` UX (prompt library vs minimal readline).
- Config file location/precedence (`~/.config/gradient` vs project `.gradient/`).
