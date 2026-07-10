# gradient — Second Assistant (Codex) & Cost-Aware Artifacts — Design

**Date:** 2026-07-09
**Status:** Implemented
**Scope:** Spec 10. Two components: (1) **Codex as a second emit target** —
staged multi-assistant support, exercising the emitter pluggability Spec 4
Decision 9 reserved; (2) **cost-aware artifacts** — mechanical skills get a
cheap-model frontmatter, and `insights` gains a "cost of unautomated
habits" section. Builds on Spec 4 Phase A (skills emitter) and Phase D
(insights); Component 1 Stage 2 adds a second transcript parser.

---

## 1. Tier coverage map (why this spec is the Tier 3 delta)

| Tier 3 idea | Owner |
|---|---|
| Team distribution (plugin bundles) | Spec 4 Phase E + Spec 5 (plugin distribution) |
| **Codex / multi-assistant** | **This spec, Component 1** (deferred since Spec 1 §9; kept-pluggable by Spec 4 Decision 9) |
| **Cost coaching** | **This spec, Component 2** (Phase D covers model-churn/context coaching; the artifact-level and token-quantified parts live here) |

Why revisit the multi-assistant deferral now: the ecosystems converged.
Codex deprecated its custom prompts **in favor of the same
`SKILL.md` skill format**, ships stable lifecycle hooks (SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, Stop), reads `AGENTS.md`, has a
plugin system, and logs sessions as local JSONL. A Codex emitter is now a
format variant, not a second product — and cross-tool users get one mined
workflow available in both agents.

## 2. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Staging | **Stage 1: emit-only** (mine Claude Code history, also write Codex-format artifacts). **Stage 2: mine Codex history** into the same funnel. Each stage is its own implementation plan; Stage 1 ships value alone. |
| 2 | Config | `targets?: ("claude-code" \| "codex")[]`, default `["claude-code"]`. Unknown values are rejected at config load with a clear error (config is user-authored; tolerant-reader applies to *data*, not settings). No new CLI flags — `apply` fans out to every configured target. |
| 3 | Stage 1 artifact scope | **Skills only.** Rules for Codex are print-only (`AGENTS.md` is never edited — the CLAUDE.md stance, Spec 4 Decision 5, extended verbatim). Codex *hooks* and autopilot-for-Codex are explicitly out of scope (different config surface and recursion-guard semantics). |
| 4 | Manifest | Entries gain `target?: "claude-code" \| "codex"` — absent means `claude-code` (tolerant reader, no migration). `remove <name>` removes the artifact from **all** targets it was applied to; `list` shows the target column only when a non-default target exists. |
| 5 | Emitter shape | `core/emit/` becomes a target-keyed registry: `emit(s, { target, assistant })`. The Codex skill emitter reuses the Phase A skill body verbatim and emits only the frontmatter fields Codex documents (`name`, `description`); Claude-specific fields are never written to Codex files. |
| 6 | Stage 2 input | `core/parse-codex.ts` maps Codex session JSONL to the existing `Turn` shape; everything downstream (classifier, clustering, detectors, judge) is unchanged. Evidence from both assistants **merges by signature** — the same habit typed in both tools sums its support, which no single-assistant tool can see. |
| 7 | Cheap-model skills | The detect judge gains `mechanical?: boolean` (deterministic, no-judgment workflows — fixed command chains, formatters). When true, the skill emitter adds `model: <config.cheapSkillModel>`; default `"haiku"`, and an **empty string disables the feature**. Applies to the Claude Code target only (Codex model pinning is out of scope). |
| 8 | Cost quantification | `insights` gains a **"cost of unautomated habits"** section: estimated tokens attributable to nudge turns, continuation re-explains, and repeated pastes — computed from the transcripts' recorded usage fields where present, else a chars/4 estimate, always labeled "≈". **Tokens, never dollars** — pricing drifts; ccusage owns spend accounting. Each row keeps Phase D's pattern: number + one gradient action. |
| 9 | Privacy & deps | Unchanged and zero: Codex transcripts are the same local-files posture as Claude Code's; redaction runs before anything reaches a model; no new runtime dependencies. |

## 3. Component 1 — Codex target

### Stage 1 (emit)

- `apply` fan-out: for each configured target, resolve the emitter, write,
  record one manifest entry per (name, target). A failure on the second
  target rolls back nothing — each entry stands alone and `remove` cleans
  whichever exist (apply reports per-target results).
- Path: Codex's documented repository Agent Skills directory,
  `.agents/skills/<name>/SKILL.md` (verified 2026-07-09).
- `review` shows the target list on the approve prompt when it is more
  than the default, so approving is informed consent for both writes.

### Stage 2 (mine)

- `scan` gains Codex sessions as an additional collect source when
  `targets` includes `codex` and the sessions directory exists; the scan
  report states both sources and their prompt counts.
- Signature-level evidence merge (Decision 6); `explain` evidence lines
  carry an assistant tag only when sources are mixed.

## 4. Component 2 — cost-aware artifacts

- **Mechanical skills** (Decision 7): the judge's briefing defines
  mechanical narrowly — *would a reasonable person expect zero judgment
  calls executing this?* — with the `fix-push` retarget flow as the
  canonical yes and "review the spec then write the plan" as the canonical
  no. Emitted frontmatter is one line; `review` shows it in the artifact
  preview so the model choice is approved, not sneaked in.
- **Insights section** (Decision 8): three rows (nudges, continuations,
  re-pastes), each `≈ tokens · what that is in prompts · one action`, data
  from the same single collect+parse pass Phase D already makes. Degrades
  to hiding rows whose inputs (e.g. C1 paste classes) have not landed.

## 5. Out of scope (YAGNI)

- **Codex hooks, autopilot, and AGENTS.md writes** — Decision 3. Phase E bundles
  now include a Codex plugin manifest because the shared `skills/` payload is
  already portable; Claude-only hooks remain absent from that manifest.
- **Other assistants** (Gemini CLI, Cursor CLI) — the registry leaves the
  door open; no code until a user asks.
- **Dollar accounting, budgets, or spend dashboards** — ccusage territory.
- **Codex-side recall/adoption tracking** — Phase B is Claude Code-only
  until Stage 2 proves the parser.
- **Per-skill effort/thinking tuning** — one `model:` line is the whole
  feature; more knobs need evidence.

## 6. Sequencing & dead code

- **After Spec 4 Phase A** (needs the skills emitter and its options seam;
  registry refactor touches the same files). Component 2's insights rows
  land **with or after Phase D**; the mechanical-skill flag can ship with
  Stage 1 independently of D.
- Docs updated in the same commits: README's "multi-assistant: deferred"
  lines (Spec 1 §9, Spec 4 Decision 9) get pointed here; `init` help gains
  `targets`; Spec 4's Decision 9 is fulfilled, not contradicted.
- Dead code: none removed. The emitter registry refactor migrates the
  existing command/skill emitters without leaving a parallel old path —
  `emit()`'s previous signature is deleted in the same change, not kept as
  a wrapper.

## 7. Testing

- Config: target validation (unknown → error), default, empty
  `cheapSkillModel` disables frontmatter.
- Fan-out: two-target apply → two manifest entries; per-target failure
  reporting; `remove` deletes both; pre-Spec-10 manifests (no `target`)
  list and remove cleanly.
- Codex emitter: golden SKILL.md (frontmatter minimal, body identical to
  the Claude skill); path containment (`assertInside` equivalent for the
  Codex dir).
- Stage 2 parser: fixture Codex JSONL → `Turn[]`; malformed lines skipped
  with counts; merged-evidence support sums across sources.
- Mechanical flag: emitted only when judge says so; preview shows it;
  never emitted for Codex target.
- Cost section: fixture with known usage fields; chars/4 fallback; rows
  hide when inputs missing; zero-history no-op.

## 8. Resolved implementation questions

- Codex repo skills are `.agents/skills/<name>/SKILL.md`; user skills are
  `~/.agents/skills`. Only `name` and `description` are emitted.
- Codex sessions are local rollout JSONL under `~/.codex/sessions`; genuine
  prompts use `event_msg/user_message`, with a guarded legacy fallback.
- Claude Code documents the `model` skill field and accepts aliases such as
  `haiku`; an empty `cheapSkillModel` disables it.
- One `maxPrompts` recency budget is shared across assistants, and evidence is
  weighted equally regardless of source.
