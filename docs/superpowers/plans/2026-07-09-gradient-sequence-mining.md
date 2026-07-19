# gradient — Sequence Mining — Implementation Plan

**Status:** Complete and merged into the v2 pipeline. Unchecked boxes below
preserve the original plan; the security revision documents shipped behavior.

> **Security revision (0.1.1):** This historical plan's pair-merging and
> playbook sink were superseded by the public-release audit. The shipped code
> counts actual same-session bigrams/trigrams, never infers a triple from
> overlapping aggregates, emits authorization-preserving advisory checklists,
> and does not write raw/unapproved sequences into the autopilot playbook.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring prompt chains ("review the spec" → "write the plan") become
reviewable advisory checklist suggestions with exact ordered provenance. Spec:
`docs/superpowers/specs/2026-07-09-gradient-sequence-mining-design.md`.

**Architecture:** A new pure module `core/sequence.ts` counts adjacent same-session prompt pairs (nudges transparent, unclustered prompts break chains) and merges overlapping pairs into chains. `scan` feeds chains into the detect window as `kind: "sequence"` candidates (skill sink) and into `writePlaybook` (playbook sink). No new payload type; no new dependency.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Execute after Spec 4 Phase A merges** (`spec/v2-phase-a`): scan.ts anchors below reference the post-A2 shape (config loaded before `filterPrompts`, template-flood filter applied to `cluster()` output), and the detect prompt already carries A5's `triggers` wording.
- **Constants (spec §2, pinned here):** `SEQ_MIN_COUNT = 3`, `SEQ_MIN_SESSIONS = 2`, `SEQ_MAX_BIGRAMS = 2000`, detect-window share `Math.ceil(window / 4)`.
- Exact adjacent n-grams only: chains are at most 3 steps and every full tuple
  must actually occur in the stated order.
- Playbook marker-splice contract unchanged: user content outside `<!-- gradient:mined:* -->` is never touched; markers-gone → `null`.
- The committed project `gradient.md` is never written.
- Tests: vitest, no network, no real `claude`. Run from `cli/`: `npm test`, `npm run typecheck`.
- Branch: `spec/sequence-mining`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/sequence.ts` (create) | `NUDGE_PROMPT_RE`, `ChainFinding`, `mineSequences` — exact adjacent bigram/trigram counting |
| `cli/src/core/types.ts` (modify) | `Candidate.kind` gains `"sequence"` |
| `cli/src/core/playbook.ts` (modify) | defensive sanitization; scan does not sink raw chains here |
| `cli/src/commands/scan.ts` (modify) | wire `mineSequences` → detect window; cap logging |
| `cli/src/core/detect.ts` (modify) | briefing for `kind: "sequence"` candidates |

---

### Task S1: `core/sequence.ts` — pair mining with nudge transparency

**Files:**
- Create: `cli/src/core/sequence.ts`
- Modify: `cli/src/core/types.ts`
- Test: `cli/src/core/sequence.test.ts` (create)

**Interfaces:**
- Consumes: `Turn` from `types.ts`.
- Produces (later tasks rely on these exact names):
  - `NUDGE_PROMPT_RE: RegExp`
  - `interface ChainFinding { steps: string[]; count: number; sessions: number; sessionIds: string[]; examples: string[][] }`
  - `mineSequences(turns: Turn[], assign: (text: string) => string | null): { chains: ChainFinding[]; capped: boolean }`
  - `SEQ_MIN_COUNT`, `SEQ_MIN_SESSIONS`, `SEQ_MAX_BIGRAMS` (exported consts)
  - `types.ts`: `Candidate.kind: ArtifactType | "unknown" | "sequence"`

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/sequence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mineSequences, NUDGE_PROMPT_RE, SEQ_MIN_COUNT } from "./sequence.js";
import type { Turn } from "./types.js";

const turn = (sessionId: string, ts: string, text: string): Turn =>
  ({ ts, project: "p", role: "user", sessionId, text });

/** assign: normalized lookup over a fixed signature set. */
const assignOf = (sigs: string[]) => (text: string) => {
  const n = text.toLowerCase().trim();
  return sigs.includes(n) ? n : null;
};

/** One A→B occurrence per session s1..sN. */
function sessions(n: number, a = "review the spec", b = "write the plan"): Turn[] {
  return Array.from({ length: n }, (_, i) => [
    turn(`s${i}`, "2026-07-01T00:00:00Z", a),
    turn(`s${i}`, "2026-07-01T00:01:00Z", b),
  ]).flat();
}

describe("mineSequences", () => {
  const assign = assignOf(["review the spec", "write the plan", "push it"]);

  it("finds a chain at the support floor (3 occurrences, 2+ sessions)", () => {
    const { chains } = mineSequences([...sessions(2), ...sessions(1)], assign);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      steps: ["review the spec", "write the plan"], count: 3,
    });
    expect(chains[0].sessions).toBeGreaterThanOrEqual(2);
    expect(chains[0].sessionIds.length).toBe(chains[0].sessions);
    expect(chains[0].examples[0]).toEqual(["review the spec", "write the plan"]);
  });

  it("drops pairs below the floor", () => {
    expect(mineSequences(sessions(SEQ_MIN_COUNT - 1), assign).chains).toHaveLength(0);
  });

  it("requires 2 distinct sessions even at 3 occurrences", () => {
    const oneSession = [
      turn("s1", "t1", "review the spec"), turn("s1", "t2", "write the plan"),
      turn("s1", "t3", "review the spec"), turn("s1", "t4", "write the plan"),
      turn("s1", "t5", "review the spec"), turn("s1", "t6", "write the plan"),
    ];
    expect(mineSequences(oneSession, assign).chains).toHaveLength(0);
  });

  it("nudges are transparent — adjacency bridges over them", () => {
    const withNudges = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "continue"),
      turn(`s${i}`, "t3", "write the plan"),
    ]).flat();
    expect(mineSequences(withNudges, assign).chains).toHaveLength(1);
  });

  it("unclustered prompts break chains", () => {
    const broken = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "something totally novel here"),
      turn(`s${i}`, "t3", "write the plan"),
    ]).flat();
    expect(mineSequences(broken, assign).chains).toHaveLength(0);
  });

  it("never bridges across sessions", () => {
    const alternating = Array.from({ length: 3 }, (_, i) => [
      turn(`a${i}`, "t1", "review the spec"),
      turn(`b${i}`, "t1", "write the plan"),
    ]).flat();
    expect(mineSequences(alternating, assign).chains).toHaveLength(0);
  });

  it("ignores same-signature repeats (A→A is not a chain)", () => {
    const rep = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "review the spec"),
    ]).flat();
    expect(mineSequences(rep, assign).chains).toHaveLength(0);
  });

  it("merges overlapping bigrams into one 3-step chain when sessions overlap", () => {
    const triple = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "write the plan"),
      turn(`s${i}`, "t3", "push it"),
    ]).flat();
    const { chains } = mineSequences(triple, assign);
    expect(chains).toHaveLength(1);
    expect(chains[0].steps).toEqual(["review the spec", "write the plan", "push it"]);
  });

  it("orders turns by timestamp within a session", () => {
    const shuffled = [
      turn("s1", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s1", "2026-07-01T00:01:00Z", "review the spec"),
      turn("s2", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s2", "2026-07-01T00:01:00Z", "review the spec"),
      turn("s3", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s3", "2026-07-01T00:01:00Z", "review the spec"),
    ];
    expect(mineSequences(shuffled, assign).chains[0]?.steps)
      .toEqual(["review the spec", "write the plan"]);
  });
});

describe("NUDGE_PROMPT_RE", () => {
  it.each(["continue", "Continue.", "what's next?", "keep going", "ok", "proceed"])(
    "matches %s", t => expect(NUDGE_PROMPT_RE.test(t)).toBe(true));
  it.each(["continue the migration", "next step is tests", "1"])(
    "does not match %s", t => expect(NUDGE_PROMPT_RE.test(t)).toBe(false));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/sequence.test.ts`
Expected: FAIL — module `./sequence.js` not found.

- [ ] **Step 3: Implement** — create `cli/src/core/sequence.ts`:

```ts
import type { Turn } from "./types.js";

export const SEQ_MIN_COUNT = 3;
export const SEQ_MIN_SESSIONS = 2;
export const SEQ_MAX_BIGRAMS = 2000;

/** Whole-prompt nudges only — "continue the migration" is content, not a nudge. */
export const NUDGE_PROMPT_RE =
  /^(continue|keep going|go( on)?|next|what'?s next|proceed|carry on|resume|ok(ay)?|yes|y|do it)[.!?\s]*$/i;

/** A recurring ordered chain of cluster signatures (spec §3). */
export interface ChainFinding {
  steps: string[];
  count: number;
  sessions: number;
  sessionIds: string[];
  examples: string[][];   // ≤3 raw prompt tuples, one prompt per step
}

interface PairStat { count: number; sessions: Set<string>; examples: string[][] }

export function mineSequences(
  turns: Turn[],
  assign: (text: string) => string | null,
): { chains: ChainFinding[]; capped: boolean } {
  const bySession = new Map<string, Turn[]>();
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }

  const pairs = new Map<string, PairStat>();
  let capped = false;
  for (const [sid, arr] of bySession) {
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    let prev: { sig: string; text: string } | null = null;
    for (const t of arr) {
      const text = t.text!;
      if (NUDGE_PROMPT_RE.test(text.trim())) continue;      // transparent (spec Decision 2)
      const sig = assign(text);
      if (sig === null) { prev = null; continue; }          // unclustered → chain breaker
      if (prev && prev.sig !== sig) {
        const key = `${prev.sig}\u0000${sig}`;
        let p = pairs.get(key);
        if (!p) {
          if (pairs.size >= SEQ_MAX_BIGRAMS) { capped = true; prev = { sig, text }; continue; }
          p = { count: 0, sessions: new Set(), examples: [] };
          pairs.set(key, p);
        }
        p.count++;
        p.sessions.add(sid);
        if (p.examples.length < 3) p.examples.push([prev.text, text]);
      }
      prev = { sig, text };
    }
  }

  const bigrams: ChainFinding[] = [];
  for (const [key, p] of pairs) {
    if (p.count < SEQ_MIN_COUNT || p.sessions.size < SEQ_MIN_SESSIONS) continue;
    bigrams.push({
      steps: key.split("\u0000"), count: p.count,
      sessions: p.sessions.size, sessionIds: [...p.sessions], examples: p.examples,
    });
  }

  // One merge pass: A→B + B→C with overlapping sessions → A→B→C (spec Decision 3).
  const consumed = new Set<number>();
  const chains: ChainFinding[] = [];
  for (let i = 0; i < bigrams.length; i++) {
    if (consumed.has(i)) continue;
    const ab = bigrams[i];
    let merged: ChainFinding | null = null;
    for (let j = 0; j < bigrams.length; j++) {
      if (j === i || consumed.has(j)) continue;
      const bc = bigrams[j];
      if (ab.steps[ab.steps.length - 1] !== bc.steps[0]) continue;
      const shared = ab.sessionIds.filter(s => bc.sessionIds.includes(s));
      if (shared.length < SEQ_MIN_SESSIONS) continue;
      merged = {
        steps: [...ab.steps, ...bc.steps.slice(1)],
        count: Math.min(ab.count, bc.count),
        sessions: shared.length,
        sessionIds: shared,
        examples: ab.examples.map((e, k) => [...e, ...(bc.examples[k]?.slice(1) ?? [])]).slice(0, 3),
      };
      consumed.add(i); consumed.add(j);
      break;
    }
    chains.push(merged ?? ab);
  }
  return { chains: chains.sort((a, b) => b.count - a.count), capped };
}
```

In `cli/src/core/types.ts`, widen the candidate kind:

```ts
  kind: ArtifactType | "unknown" | "sequence";
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/sequence.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/sequence.ts cli/src/core/sequence.test.ts cli/src/core/types.ts
git commit -m "feat(core): sequence mining — adjacent prompt pairs with nudge transparency"
```

---

### Task S2: Playbook chain lines (deterministic sink)

**Files:**
- Modify: `cli/src/core/playbook.ts`
- Test: `cli/src/core/playbook.test.ts` (append)

**Interfaces:**
- Consumes: `ChainFinding` from S1.
- Produces:
  - `renderMinedSection(suggestions: Suggestion[], chains?: ChainFinding[]): string` — chain lines under the **existing** "My workflows (mined)" heading, capped at `PLAYBOOK_MAX_CHAINS = 5`.
  - `generatePlaybook(suggestions, existing?, chains?)`, `writePlaybook(suggestions, home?, chains?)` — optional trailing params, back-compatible.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/playbook.test.ts`:

```ts
import { PLAYBOOK_MAX_CHAINS } from "./playbook.js";
import type { ChainFinding } from "./sequence.js";

const chain = (a: string, b: string, count = 5, sessions = 3): ChainFinding =>
  ({ steps: [a, b], count, sessions, sessionIds: ["s1", "s2", "s3"], examples: [[a, b]] });

describe("renderMinedSection with chains", () => {
  it("renders chain lines under the workflows heading", () => {
    const out = renderMinedSection([], [chain("review the spec", "write the plan")]);
    expect(out).toContain("## My workflows (mined)");
    expect(out).toContain('- After "review the spec", you usually follow with "write the plan" (5× · 3 sessions)');
  });
  it("renders 3-step chains with a then-clause", () => {
    const c: ChainFinding = { ...chain("a", "b"), steps: ["a", "b", "c"] };
    expect(renderMinedSection([], [c])).toContain('- After "a", you usually follow with "b" then "c" (5× · 3 sessions)');
  });
  it("caps chains at PLAYBOOK_MAX_CHAINS", () => {
    const many = Array.from({ length: PLAYBOOK_MAX_CHAINS + 2 }, (_, i) => chain(`a${i}`, `b${i}`));
    const out = renderMinedSection([], many);
    expect(out.match(/you usually follow with/g)).toHaveLength(PLAYBOOK_MAX_CHAINS);
  });
  it("generatePlaybook splices chains inside markers, user Rules untouched", () => {
    const out = generatePlaybook([], undefined, [chain("a", "b")]);
    expect(out).toContain('you usually follow with "b"');
    expect(out!.indexOf("you usually follow")).toBeLessThan(out!.indexOf("## Rules"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/playbook.test.ts`
Expected: FAIL — `PLAYBOOK_MAX_CHAINS` not exported / chain lines missing.

- [ ] **Step 3: Implement** — in `cli/src/core/playbook.ts`:

```ts
import type { ChainFinding } from "./sequence.js";

export const PLAYBOOK_MAX_CHAINS = 5;

function chainLine(ch: ChainFinding): string {
  const [first, second, third] = ch.steps;
  const tail = third ? ` then "${third}"` : "";
  return `- After "${first}", you usually follow with "${second}"${tail} (${ch.count}× · ${ch.sessions} sessions)`;
}
```

Extend `renderMinedSection` (chains render after the command lines, same heading):

```ts
export function renderMinedSection(suggestions: Suggestion[], chains: ChainFinding[] = []): string {
  // ...nudgeLines and cmdLines unchanged...
  const chainLines = chains.slice(0, PLAYBOOK_MAX_CHAINS).map(chainLine);
  const workflowLines = [...cmdLines, ...chainLines];
  return [
    "## How I nudge (mined)",
    "",
    ...(nudgeLines.length ? nudgeLines : ["_no nudge patterns mined yet_"]),
    "",
    "## My workflows (mined)",
    "",
    ...(workflowLines.length ? workflowLines : ["_no workflow commands mined yet_"]),
  ].join("\n");
}
```

Thread the optional param through (both stay back-compatible):

```ts
export function generatePlaybook(suggestions: Suggestion[], existing?: string, chains: ChainFinding[] = []): string | null {
  // body unchanged, pass chains to renderMinedSection
export async function writePlaybook(suggestions: Suggestion[], home?: string, chains: ChainFinding[] = []): Promise<string | null> {
  // body unchanged, pass chains to generatePlaybook
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS — existing playbook tests stay green (params are optional).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/playbook.ts cli/src/core/playbook.test.ts
git commit -m "feat(core): mined chains render in gradient.md workflows"
```

---

### Task S3: Scan wiring — both sinks + cap logging

**Files:**
- Modify: `cli/src/commands/scan.ts`
- Test: `cli/src/commands/scan.test.ts` (append)

**Interfaces:**
- Consumes: `mineSequences`, `normalize` (from `cluster.ts`), post-A2 `scan` shape.
- Produces: sequence candidates (`kind: "sequence"`, signature = steps joined with `" → "`) appended to the detect input, capped at `Math.ceil(window / 4)` with a log line; `writePlaybook(valid, opts.home, seq.chains)`.

- [ ] **Step 1: Write the failing test** — append to `cli/src/commands/scan.test.ts` (reuse the file's injected-deps pattern; `backend: null` exercises the degraded path, whose command suggestions include sequence candidates):

```ts
it("mines sequences into candidates and logs the sequence count", async () => {
  const seqTurns = Array.from({ length: 3 }, (_, i) => [
    { ts: "2026-07-01T00:00:00Z", project: "p", role: "user" as const, sessionId: `s${i}`, text: "review the spec" },
    { ts: "2026-07-01T00:01:00Z", project: "p", role: "user" as const, sessionId: `s${i}`, text: "write the plan" },
  ]).flat();
  const logs: string[] = [];
  const out = await scan(
    { scope: "project", projectPath: dir },
    { backend: null, collectFn: async () => ["f"], parseFn: async () => seqTurns, log: m => logs.push(m) },
  );
  expect(logs.join("\n")).toContain("sequences: 1 recurring chain(s)");
  // Degraded path: the sequence candidate surfaces as a high-confidence command suggestion.
  expect(out.some(s => s.payload.type === "command" && /review the spec → write the plan/.test(s.title))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/scan.test.ts`
Expected: FAIL — no sequence log line, no chain-derived suggestion.

- [ ] **Step 3: Implement** — in `cli/src/commands/scan.ts`, after the (post-A2) template-flood filter and before `detect`:

```ts
import { mineSequences } from "../core/sequence.js";
import { normalize } from "../core/cluster.js";
import type { Candidate } from "../core/types.js";

// Sequence sink 1: chains join the detect window as candidates (spec §4).
const sigSet = new Set(candidates.map(c => c.signature));
const seq = mineSequences(kept, text => {
  const n = normalize(text);
  return sigSet.has(n) ? n : null;
});
if (seq.capped) log(`sequence pair cap hit — oldest pairs dropped (raise SEQ_MAX_BIGRAMS if this recurs)`);
if (seq.chains.length > 0) log(`sequences: ${seq.chains.length} recurring chain(s)`);
const seqCap = Math.ceil(window / 4);
if (seq.chains.length > seqCap) log(`sequence candidates capped to ${seqCap}; ${seq.chains.length - seqCap} dropped`);
const seqCandidates: Candidate[] = seq.chains.slice(0, seqCap).map(ch => ({
  kind: "sequence",
  signature: ch.steps.join(" → "),
  examples: ch.examples.map(e => e.join(" ⏎ ")),
  count: ch.count,
  sessions: ch.sessions,
  sessionIds: ch.sessionIds,
  confidence: "high",
}));
```

Pass them into detect alongside the prompt candidates, and the chains to the playbook (sink 2):

```ts
const suggestions = await detect([...candidates, ...seqCandidates], backend, { ... });
// ...
const pb = await writePlaybook(valid, opts.home, seq.chains);
```

Note the `window` variable already exists (`opts.limit ?? DEFAULT_DETECT_WINDOW`); move its declaration above the sequence block if it sits below.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS, all pre-existing scan tests green.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/scan.ts cli/src/commands/scan.test.ts
git commit -m "feat(scan): sequence chains feed the detect window and gradient.md workflows"
```

---

### Task S4: Detect briefing for sequence candidates

**Files:**
- Modify: `cli/src/core/detect.ts`
- Test: `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: `Candidate.kind === "sequence"` from S1/S3.
- Produces: `buildDetectPrompt` includes `kind` for non-`"unknown"` candidates and briefs the model to emit ONE numbered multi-step command per sequence, `triggers` from the first step only.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/detect.test.ts`:

```ts
it("briefs the model on sequence candidates and forwards their kind", () => {
  const seq = { kind: "sequence" as const, signature: "review the spec → write the plan",
    examples: ["review the spec ⏎ write the plan"], count: 5, sessions: 3,
    sessionIds: ["a", "b", "c"], confidence: "high" as const };
  const { system, prompt } = buildDetectPrompt([seq]);
  expect(system).toContain("sequence");
  expect(system).toContain("numbered");
  expect(JSON.parse(prompt)[0].kind).toBe("sequence");
});

it("omits kind for unknown candidates (prompt stays unchanged for them)", () => {
  const c = { kind: "unknown" as const, signature: "lgtm", examples: ["lgtm"],
    count: 5, sessions: 3, sessionIds: ["a"], confidence: "high" as const };
  expect(JSON.parse(buildDetectPrompt([c]).prompt)[0].kind).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/detect.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Implement** — in `cli/src/core/detect.ts`:

In `buildDetectPrompt`, append to the `system` string (after the existing merge/triggers sentences; do not modify them):

```ts
"Clusters with kind 'sequence' are ordered multi-step workflows the user performs in order " +
"(their signature joins the steps with ' → '). For each, produce ONE command suggestion whose " +
"body is an advisory numbered checklist. The first step is not authorization for later steps; " +
"the skill must ask which steps the user wants performed now. " +
```

In the candidate mapping inside `buildDetectPrompt`, forward the kind:

```ts
    cands.map(c => ({
      ...(c.kind !== "unknown" ? { kind: c.kind } : {}),
      signature: redact(c.signature),
      // ...rest unchanged
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/detect.ts cli/src/core/detect.test.ts
git commit -m "feat(detect): sequence candidates become single multi-step skills"
```

---

## Execution notes (2026-07-09, post-implementation review)

Implemented by Codex CLI (S1–S4, one commit per task), then reviewed. Deviations from the plan as written, all deliberate:

- **S1 support-floor fixture:** the planned `[...sessions(2), ...sessions(1)]` reuses session `s0` with duplicate timestamps — after the stable sort its pair counts once, giving 2 total, below `SEQ_MIN_COUNT`. The committed test uses `sessions(3)`.
- **S1 merge pass (review fix):** the plan's `chains.push(merged ?? ab)` emitted a bigram standalone the moment it failed to merge as a *left* side, even though a later merge could still consume it as a *right* side — output depended on pair-map insertion order and could report `B→C` both standalone and inside `A→B→C`. Standalone bigrams now emit only after the merge pass completes.
- **S3 pre-Phase-A wiring:** this branch was built before Spec 4 Phase A merged, so `mineSequences` wires directly after `cluster()` (no template-flood filter exists yet) and the sequence briefing sentence stands alone rather than following A5's triggers wording. **Rebase note for Phase A:** move the sequence block below the flood filter and let the briefing follow A5's sentence.
- **S3 scan test isolation:** the planned snippet reused an absent shared `dir` fixture and omitted `home`, which would have made the suite write the developer's real `~/.config/gradient/gradient.md`. The committed test creates temp `dir` and `home`.
- **S3 cap log (review fix):** "oldest pairs dropped" misstated the cap — pairs first seen *after* the cap are ignored while existing pairs keep counting. Log reworded.
- **S4:** unknown candidates already omitted `kind` before the change, so the second regression test was green pre-implementation; kept as a guard.
- **Mainline integration:** the Phase A rebase note is complete. Sequence mining
  consumes only flood-filtered lexical candidates; paste, answer, and sequence
  candidates then share the final ranked detect window. The sequence briefing
  follows the common trigger guidance.
- **Degraded-path integration:** without an LLM, sequence suggestions now keep
  explicit numbered steps and trigger on the first step only, matching the
  sequence skill contract instead of emitting the raw joined example.
