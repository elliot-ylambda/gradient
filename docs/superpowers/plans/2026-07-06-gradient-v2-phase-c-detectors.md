# gradient v2 Phase C — New Detectors (Error Pastes & Answer Mining) — Implementation Plan

> **Security revision (0.1.1):** This historical execution plan predates the
> public-release audit. The shipped implementation does not rerun pasted
> commands, forward free-form paste headers, infer rules from yes/no or ordinal
> answers, accept one-session support, or persist model-authored rule text.
> Paste skills are advisory; preference rules are locally reconstructed,
> project-scoped, low-impact, and preserve consequential confirmations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine the two pattern shapes the lexical clusterer can't see: repeated
pastes become advisory troubleshooting suggestions, and repeated safe
preferences become guarded project-rule suggestions. Spec:
`docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md` §5.

**Architecture:** `core/paste.ts` keys long error-ish prompts by their command/error head line and emits `Candidate`s with `kind: "paste"` that bypass trigram clustering but retain the template-flood gate. `core/parse.ts` gains a dialogue parser (assistant + user turns, including explicit structured question results) feeding `core/answers.ts`, which pairs assistant questions with short human answers and emits `kind: "answer"` candidates. `detect` learns both kinds plus the new `rule` payload; `emit/rule.ts` writes project rules (user-target rules are print-only).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Depends on Phase A** (classifier, skills emit, triggers). Branch: `spec/v2-phase-c`.
- **Spec deviation (recorded):** spec §5 C1 offered a `PostToolUseFailure` hook variant for pastes. Not built: `assertHookRunnable` only permits hooks that call known gradient subcommands, and no gradient subcommand can "fix failures" — that is Claude's job. Paste candidates emit **skill suggestions only**. Arbitrary-command hooks would be a new security surface; explicitly rejected.
- **Constants (pinned here):** `PASTE_MIN_CHARS = 400`, `PASTE_MIN_COUNT = 3`, `PASTE_KEY_CHARS = 80`; `ANSWER_MAX_CHARS = 80`, `PAIR_MIN_COUNT = 3`, `QUESTION_SIM = 0.4`.
- **Privacy:** pasted bodies NEVER reach the LLM or `suggestions.json` examples — only the extracted key line (redacted). Answer-pair examples are redacted like all others.
- **Rules:** project target writes `.claude/rules/gradient-<sanitized ruleName>.md` (manifest-tracked, `remove`-able); `target: "user"` never writes — printed only (spec Decision 5).
- Tests: vitest with injected deps, no network. Run from `cli/`: `npm test`, `npm run typecheck`.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `Candidate.kind` += `"paste" | "answer"`; `ArtifactType` += `"rule"`; `rule` payload |
| `cli/src/core/paste.ts` (create) | `extractPasteKey`, `detectPasteCandidates` |
| `cli/src/core/parse.ts` (modify) | `parseDialogueLines` / `parseDialogueFile` (assistant + user text turns) |
| `cli/src/core/answers.ts` (create) | Q→A pair extraction + answer candidates |
| `cli/src/core/detect.ts` (modify) | prompt: paste/answer kinds + rule payload schema; kind passthrough |
| `cli/src/core/validate.ts` (modify) | `rule` payload validation |
| `cli/src/core/emit/rule.ts` (create) + `emit/index.ts` (modify) | rule emit (write vs print) |
| `cli/src/core/apply.ts` (modify) | rule artifact write + manifest |
| `cli/src/commands/scan.ts` (modify) | wire both detectors into the pipeline |
| `cli/src/core/ui.ts`, `cli/src/cli.ts`, `README.md` (modify) | label, HELP/docs |

---

### Task C1: Paste detector

**Files:**
- Create: `cli/src/core/paste.ts`
- Modify: `cli/src/core/types.ts`
- Test: `cli/src/core/paste.test.ts` (create)

**Interfaces:**
- Consumes: `Turn`.
- Produces:
  - `types.ts`: `Candidate.kind: ArtifactType | "unknown" | "paste" | "answer"` (add `"answer"` now so types change once).
  - `extractPasteKey(text: string): string | null` — null unless `length > PASTE_MIN_CHARS` and error markers present; else first non-empty line, trimmed, truncated to `PASTE_KEY_CHARS`.
  - `detectPasteCandidates(prompts: Turn[]): Candidate[]` — groups by key; groups with `count >= PASTE_MIN_COUNT` → `Candidate` with `kind: "paste"`, `signature: key`, `examples: ["pasted output of: " + key]` (bodies excluded), `confidence: "high"` (single key) — sessions/sessionIds tracked exactly like `cluster()` does.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/paste.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractPasteKey, detectPasteCandidates, PASTE_MIN_CHARS } from "./paste.js";
import type { Turn } from "./types.js";

const t = (sessionId: string, text: string): Turn => ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId, text });
const errBody = (head: string) => `${head}\n` + "error: something failed\n".repeat(30); // > 400 chars

describe("extractPasteKey", () => {
  it("keys a long error paste by its first line", () => {
    expect(extractPasteKey(errBody("make dev"))).toBe("make dev");
  });
  it("truncates keys to 80 chars", () => {
    expect(extractPasteKey(errBody("x".repeat(120)))!.length).toBe(80);
  });
  it("returns null for short texts and non-error long texts", () => {
    expect(extractPasteKey("error: short")).toBeNull();
    expect(extractPasteKey("just a very long design discussion ".repeat(20))).toBeNull();
  });
});

describe("detectPasteCandidates", () => {
  it("groups same-command pastes across differing bodies", () => {
    const prompts = [
      t("s1", errBody("make dev") + "AAA"), t("s2", errBody("make dev") + "BBB"), t("s3", errBody("make dev") + "CCC"),
      t("s1", errBody("xcodebuild -scheme App")), // below min count
    ];
    const out = detectPasteCandidates(prompts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "paste", signature: "make dev", count: 3, sessions: 3 });
  });
  it("never leaks paste bodies into examples", () => {
    const prompts = [t("s1", errBody("make dev")), t("s2", errBody("make dev")), t("s3", errBody("make dev"))];
    const [c] = detectPasteCandidates(prompts);
    expect(c.examples).toEqual(["pasted output of: make dev"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/paste.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts` — change the `Candidate.kind` line:

```ts
  kind: ArtifactType | "unknown" | "paste" | "answer";
```

Create `cli/src/core/paste.ts`:

```ts
import type { Turn, Candidate } from "./types.js";

export const PASTE_MIN_CHARS = 400;
export const PASTE_MIN_COUNT = 3;
export const PASTE_KEY_CHARS = 80;

const ERROR_MARKERS = /error|exception|failed|fatal|traceback|cannot find|undefined is not|command not found/i;

/** Long error-ish pastes share their head line (the command / error header)
 * even when bodies differ — that head is the grouping key (spec §5 C1). */
export function extractPasteKey(text: string): string | null {
  if (text.length <= PASTE_MIN_CHARS || !ERROR_MARKERS.test(text)) return null;
  const first = text.split("\n").find(l => l.trim().length > 0);
  return first ? first.trim().slice(0, PASTE_KEY_CHARS) : null;
}

export function detectPasteCandidates(prompts: Turn[]): Candidate[] {
  const groups = new Map<string, { count: number; sessions: Set<string> }>();
  for (const p of prompts) {
    if (p.role !== "user" || !p.text) continue;
    const key = extractPasteKey(p.text);
    if (!key) continue;
    const g = groups.get(key) ?? { count: 0, sessions: new Set<string>() };
    g.count++; g.sessions.add(p.sessionId);
    groups.set(key, g);
  }
  const out: Candidate[] = [];
  for (const [key, g] of groups) {
    if (g.count < PASTE_MIN_COUNT) continue;
    out.push({
      kind: "paste",
      signature: key,
      examples: [`pasted output of: ${key}`], // bodies never leave the machine
      count: g.count,
      sessions: g.sessions.size,
      sessionIds: [...g.sessions],
      confidence: "high",
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/paste.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/paste.ts cli/src/core/paste.test.ts cli/src/core/types.ts
git commit -m "feat(core): paste detector — key long error pastes by command head line"
```

---

### Task C2: Dialogue parser

**Files:**
- Modify: `cli/src/core/parse.ts`
- Test: `cli/src/core/parse.test.ts` (append)

**Interfaces:**
- Consumes: existing raw-line parsing internals.
- Produces:
  - `interface DialogueTurn { role: Role; text: string; ts: string; sessionId: string }`
  - `parseDialogueLines(lines: string[]): DialogueTurn[]` — user turns as today, plus assistant turns' concatenated text blocks (tool blocks ignored); sidechains skipped; empty-text turns skipped. The default `parseLines`/`parseFile` mining contract is **unchanged**.
  - `parseDialogueFile(path: string): Promise<DialogueTurn[]>`

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/parse.test.ts`:

```ts
import { parseDialogueLines } from "./parse.js";

describe("parseDialogueLines", () => {
  const mk = (o: object) => JSON.stringify(o);
  it("yields assistant text turns alongside user turns, in order", () => {
    const lines = [
      mk({ type: "user", sessionId: "s", timestamp: "t1", cwd: "/p", message: { role: "user", content: "hi" } }),
      mk({ type: "assistant", sessionId: "s", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "Which db?" }, { type: "tool_use", name: "Bash" }] } }),
      mk({ type: "user", sessionId: "s", timestamp: "t3", cwd: "/p", message: { role: "user", content: "postgres" } }),
    ];
    const out = parseDialogueLines(lines);
    expect(out.map(d => [d.role, d.text])).toEqual([["user", "hi"], ["assistant", "Which db?"], ["user", "postgres"]]);
  });
  it("skips sidechains and tool-only assistant turns", () => {
    const lines = [
      mk({ type: "assistant", isSidechain: true, sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "side" }] } }),
      mk({ type: "assistant", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
    ];
    expect(parseDialogueLines(lines)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/parse.test.ts`
Expected: FAIL — `parseDialogueLines` not exported.

- [ ] **Step 3: Implement** — append to `cli/src/core/parse.ts` (reuse the existing `Raw`/`RawBlock` interfaces; widen `Raw.type` handling only inside the new function):

```ts
export interface DialogueTurn { role: Role; text: string; ts: string; sessionId: string }

/** Q→A mining needs assistant turns too. Separate from parseLines, whose
 * user-prompts-only contract serves the mining pipeline (and tail.ts serves
 * the autopilot judge) — this is the third, dialogue-shaped view. */
export function parseDialogueLines(lines: string[]): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Raw;
    try { raw = JSON.parse(line) as Raw; } catch { continue; }
    if (raw.isSidechain || (raw.type !== "user" && raw.type !== "assistant")) continue;
    const content = raw.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ");
    if (!text.trim()) continue;
    out.push({ role: raw.type as Role, text, ts: raw.timestamp ?? "", sessionId: raw.sessionId ?? "?" });
  }
  return out;
}

export async function parseDialogueFile(path: string): Promise<DialogueTurn[]> {
  const content = await readFile(path, "utf8");
  return parseDialogueLines(content.split(/\r?\n/));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/parse.test.ts`
Expected: PASS (all pre-existing parse tests untouched and green).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/parse.ts cli/src/core/parse.test.ts
git commit -m "feat(core): dialogue parser — assistant+user text turns for answer mining"
```

---

### Task C3: Answer miner

**Files:**
- Create: `cli/src/core/answers.ts`
- Test: `cli/src/core/answers.test.ts` (create)

**Interfaces:**
- Consumes: `DialogueTurn` (C2), `classifyPrompt` (Phase A), `similarity`, `normalize` (`core/cluster.ts`).
- Produces:
  - `interface AnswerPair { question: string; answer: string; sessionId: string; ts: string }`
  - `extractAnswerPairs(dialogue: DialogueTurn[]): AnswerPair[]` — a pair is an assistant turn whose trimmed text contains `?` within its final 40 chars, immediately followed (same session) by a user turn whose text is `human`-classified and `< ANSWER_MAX_CHARS` after trim.
  - `mineAnswerCandidates(pairs: AnswerPair[]): Candidate[]` — group by `normalize(answer)`; within a group, greedy sub-group by question similarity ≥ `QUESTION_SIM` against the sub-group's first question; sub-groups with `count >= PAIR_MIN_COUNT` → `Candidate` with `kind: "answer"`, `signature: "${normalized answer} ← ${first question, ≤60 chars}"`, examples up to 5 of `Q: … → A: …` form, `confidence: "inferred"`.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/answers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractAnswerPairs, mineAnswerCandidates } from "./answers.js";
import type { DialogueTurn } from "../core/parse.js";

const d = (role: "user" | "assistant", text: string, sessionId = "s1", ts = "t"): DialogueTurn => ({ role, text, sessionId, ts });

describe("extractAnswerPairs", () => {
  it("pairs a trailing question with the next short human answer", () => {
    const pairs = extractAnswerPairs([
      d("assistant", "I can use npm or pnpm. Which package manager should I use?"),
      d("user", "pnpm"),
    ]);
    expect(pairs).toEqual([{ question: "I can use npm or pnpm. Which package manager should I use?", answer: "pnpm", sessionId: "s1", ts: "t" }]);
  });
  it("skips long answers, non-questions, injected answers, and cross-session pairs", () => {
    expect(extractAnswerPairs([d("assistant", "Which one?"), d("user", "x".repeat(100))])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Done. All tests pass."), d("user", "1")])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Which one?"), d("user", "<task-notification>x</task-notification>")])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Which one?", "s1"), d("user", "2", "s2")])).toEqual([]);
  });
});

describe("mineAnswerCandidates", () => {
  it("mines the repeated '1' answer to similar option questions", () => {
    const pairs = [
      { question: "Which approach should I take? 1) minimal 2) full", answer: "1", sessionId: "a", ts: "t" },
      { question: "Which approach do you prefer? 1) quick 2) thorough", answer: "1", sessionId: "b", ts: "t" },
      { question: "Which approach works best here? 1) x 2) y", answer: "1", sessionId: "c", ts: "t" },
      { question: "Should I delete the old branch?", answer: "1", sessionId: "d", ts: "t" },  // dissimilar question
    ];
    const out = mineAnswerCandidates(pairs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "answer", count: 3, sessions: 3, confidence: "inferred" });
    expect(out[0].signature.startsWith("1 ← ")).toBe(true);
  });
  it("requires PAIR_MIN_COUNT", () => {
    const pairs = [
      { question: "Which db?", answer: "postgres", sessionId: "a", ts: "t" },
      { question: "Which db?", answer: "postgres", sessionId: "b", ts: "t" },
    ];
    expect(mineAnswerCandidates(pairs)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/answers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/core/answers.ts`:

```ts
import type { Candidate } from "./types.js";
import type { DialogueTurn } from "./parse.js";
import { classifyPrompt } from "./filter.js";
import { normalize, similarity } from "./cluster.js";

export const ANSWER_MAX_CHARS = 80;
export const PAIR_MIN_COUNT = 3;
export const QUESTION_SIM = 0.4;

export interface AnswerPair { question: string; answer: string; sessionId: string; ts: string }

function endsWithQuestion(text: string): boolean {
  const t = text.trim();
  const tail = t.slice(-40);
  return tail.includes("?");
}

export function extractAnswerPairs(dialogue: DialogueTurn[]): AnswerPair[] {
  const out: AnswerPair[] = [];
  for (let i = 0; i < dialogue.length - 1; i++) {
    const q = dialogue[i], a = dialogue[i + 1];
    if (q.role !== "assistant" || a.role !== "user") continue;
    if (q.sessionId !== a.sessionId) continue;
    if (!endsWithQuestion(q.text)) continue;
    const answer = a.text.trim();
    if (answer.length === 0 || answer.length >= ANSWER_MAX_CHARS) continue;
    if (classifyPrompt(answer) !== "human") continue;
    out.push({ question: q.text.trim(), answer, sessionId: a.sessionId, ts: a.ts });
  }
  return out;
}

export function mineAnswerCandidates(pairs: AnswerPair[]): Candidate[] {
  const byAnswer = new Map<string, AnswerPair[]>();
  for (const p of pairs) {
    const key = normalize(p.answer);
    byAnswer.set(key, [...(byAnswer.get(key) ?? []), p]);
  }
  const out: Candidate[] = [];
  for (const [answer, group] of byAnswer) {
    // Greedy sub-grouping by question similarity (host = first question in the sub-group).
    const subs: AnswerPair[][] = [];
    for (const p of group) {
      const host = subs.find(s => similarity(normalize(s[0].question), normalize(p.question)) >= QUESTION_SIM);
      if (host) host.push(p); else subs.push([p]);
    }
    for (const sub of subs) {
      if (sub.length < PAIR_MIN_COUNT) continue;
      const sessions = new Set(sub.map(p => p.sessionId));
      out.push({
        kind: "answer",
        signature: `${answer} ← ${sub[0].question.slice(0, 60)}`,
        examples: sub.slice(0, 5).map(p => `Q: ${p.question.slice(0, 80)} → A: ${p.answer}`),
        count: sub.length,
        sessions: sessions.size,
        sessionIds: [...sessions],
        confidence: "inferred",
      });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/answers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/answers.ts cli/src/core/answers.test.ts
git commit -m "feat(core): answer miner — repeated short answers to similar questions"
```

---

### Task C4: `rule` payload — types, validation, emit, apply/remove

**Files:**
- Modify: `cli/src/core/types.ts`, `cli/src/core/validate.ts`, `cli/src/core/emit/index.ts`, `cli/src/core/apply.ts`, `cli/src/core/ui.ts`
- Create: `cli/src/core/emit/rule.ts`
- Test: `cli/src/core/emit/emit.test.ts`, `cli/src/core/apply.test.ts`, `cli/src/core/validate.test.ts` (append)

**Interfaces:**
- Consumes: `sanitizeName`, `assertInside`, manifest machinery.
- Produces:
  - `types.ts`: `ArtifactType` += `"rule"`; payload union += `{ type: "rule"; target: "project" | "user"; ruleName: string; text: string }`.
  - `emit/rule.ts`: `emitRule(s): { path: string; content: string } | { printed: string }` — project → `path: ".claude/rules/gradient-<name>.md"`, content = title heading + text + provenance comment; user → `printed` instruction for manual paste.
  - `emit/index.ts`: `EmitResult` += `{ kind: "rule"; path: string; content: string } | { kind: "rule-print"; text: string }`.
  - `apply.ts`: `rule` kind writes (inside `.claude/`) with manifest `type: "rule"`; `rule-print` behaves like `loop` (printed, `path: ""`). `remove` needs no change (rules are plain files inside `.claude/`).
  - `validate.ts`: `rule` payload requires string `ruleName`, string `text`, and `target` ∈ {`project`,`user`}.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/emit/emit.test.ts`:

```ts
import { emitRule } from "./rule.js";

const ruleSug = (target: "project" | "user") => ({
  id: "r1", name: "prefer-recommended", title: "Prefer the recommended option",
  rationale: "", evidence: { count: 36, sessions: 27 }, confidence: "inferred" as const,
  payload: { type: "rule" as const, target, ruleName: "Prefer Recommended!", text: "When presenting options, default to the recommended one instead of asking." },
});

describe("emitRule", () => {
  it("project rules write to .claude/rules/gradient-<sanitized>.md with provenance", () => {
    const r = emitRule(ruleSug("project"));
    if (!("path" in r)) throw new Error("expected a write");
    expect(r.path).toBe(".claude/rules/gradient-prefer-recommended.md");
    expect(r.content).toContain("# Prefer the recommended option");
    expect(r.content).toContain("default to the recommended one");
    expect(r.content).toContain("generated by gradient");
  });
  it("user rules are print-only", () => {
    const r = emitRule(ruleSug("user"));
    expect("printed" in r && r.printed).toContain("~/.claude/CLAUDE.md");
  });
  it("emit dispatches rule payloads", () => {
    expect(emit(ruleSug("project")).kind).toBe("rule");
    expect(emit(ruleSug("user")).kind).toBe("rule-print");
  });
});
```

Append to `cli/src/core/apply.test.ts`:

```ts
it("applies a project rule as a manifest-tracked file that remove deletes", async () => {
  const s = { id: "r1", name: "prefer-recommended", title: "Prefer the recommended option",
    rationale: "", confidence: "inferred" as const, evidence: { count: 36, sessions: 27 },
    payload: { type: "rule" as const, target: "project" as const, ruleName: "prefer-recommended", text: "Default to the recommended option." } };
  const r = await applySuggestion(s, dir);
  expect(r.written).toContain(join(".claude", "rules", "gradient-prefer-recommended.md"));
  expect((await loadManifest(dir))[0].type).toBe("rule");
});
```

Append to `cli/src/core/validate.test.ts`:

```ts
it("validates rule payloads", () => {
  const base = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high" };
  expect(() => validateSuggestion({ ...base, payload: { type: "rule", target: "project", ruleName: "n", text: "t" } })).not.toThrow();
  expect(() => validateSuggestion({ ...base, payload: { type: "rule", target: "everyone", ruleName: "n", text: "t" } })).toThrow(/target/);
  expect(() => validateSuggestion({ ...base, payload: { type: "rule", target: "project", ruleName: "n" } })).toThrow(/text/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/emit/emit.test.ts src/core/apply.test.ts src/core/validate.test.ts`
Expected: FAIL — `./rule.js` not found; validate rejects type `rule`.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts`:

```ts
export type ArtifactType = "command" | "loop" | "hook" | "skill" | "rule";
// payload union gains:
  | { type: "rule"; target: "project" | "user"; ruleName: string; text: string }
```

Create `cli/src/core/emit/rule.ts`:

```ts
import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

/** Rules: standing instructions mined from repeated answers (spec §5 C2).
 * Project rules are gradient-owned files under .claude/rules/; user-global
 * rules are only printed — gradient never edits ~/.claude/CLAUDE.md. */
export function emitRule(s: Suggestion): { path: string; content: string } | { printed: string } {
  if (s.payload.type !== "rule") throw new Error("emitRule needs a rule payload");
  if (s.payload.target === "user") {
    return { printed: `add to ~/.claude/CLAUDE.md (gradient never edits it):\n  ${s.payload.text}` };
  }
  const name = sanitizeName(s.payload.ruleName);
  const title = s.title.replace(/[\r\n]+/g, " ").trim();
  const content = `<!-- generated by gradient · remove with: gradient remove ${s.name} -->\n# ${title}\n\n${s.payload.text}\n`;
  return { path: `.claude/rules/gradient-${name}.md`, content };
}
```

`cli/src/core/emit/index.ts` — extend `EmitResult` and dispatch:

```ts
  | { kind: "rule"; path: string; content: string }
  | { kind: "rule-print"; text: string };
// in emit():
    case "rule": {
      const r = emitRule(s);
      return "path" in r ? { kind: "rule", ...r } : { kind: "rule-print", text: r.printed };
    }
```

`cli/src/core/apply.ts` — extend the write branch (`result.kind === "command" || result.kind === "skill" || result.kind === "rule"` share the write path; `type = result.kind === "rule" ? "rule" : result.kind`) and add `rule-print`:

```ts
} else if (result.kind === "rule-print") {
  printed = result.text;
  type = "rule";
}
```

`cli/src/core/validate.ts` — add `"rule"` to `TYPES` and:

```ts
if (payload.type === "rule") {
  if (payload.target !== "project" && payload.target !== "user") throw new Error("rule payload target must be project|user");
  if (typeof payload.ruleName !== "string") throw new Error("rule payload needs ruleName");
  if (typeof payload.text !== "string") throw new Error("rule payload needs text");
}
```

`cli/src/core/ui.ts` — `kindLabel` gains a `rule` case.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS (including `remove` on a rule via existing manage tests — rules are ordinary manifest files inside `.claude/`).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/emit/rule.ts cli/src/core/emit/index.ts cli/src/core/emit/emit.test.ts cli/src/core/apply.ts cli/src/core/apply.test.ts cli/src/core/validate.ts cli/src/core/validate.test.ts cli/src/core/ui.ts
git commit -m "feat(core): rule artifact — mined standing instructions in .claude/rules/"
```

---

### Task C5: Scan + detect wiring for both detectors

**Files:**
- Modify: `cli/src/commands/scan.ts`, `cli/src/core/detect.ts`, `cli/src/cli.ts`, `README.md`
- Test: `cli/src/commands/scan.test.ts`, `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: `detectPasteCandidates` (C1), `parseDialogueFile`/`extractAnswerPairs`/`mineAnswerCandidates` (C2/C3), the flood-filtered `candidates` list (Phase A Task A2).
- Produces:
  - `scan` merges `[...clustered (minus floods), ...pasteCandidates, ...answerCandidates]` before `detect` (they compete for the same detect window by count — no reserved slots).
  - `buildDetectPrompt` includes each candidate's `kind` and an opaque source ID.
    Paste output becomes an advisory troubleshooting guide; answer candidates
    can only become locally reconstructed, low-impact project rules.
  - Answer mining runs a bounded second parse pass only for project scope,
    applies the same time/ignore controls, and is injectable via
    `deps.parseDialogueFn` for tests.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/detect.test.ts`:

```ts
it("describes paste and answer kinds and the rule payload in the system prompt", () => {
  const { system } = buildDetectPrompt([]);
  expect(system).toContain("'paste'");
  expect(system).toContain("'answer'");
  expect(system).toContain("type:'rule'");
});

it("includes candidate kind in the prompt JSON", () => {
  const { prompt } = buildDetectPrompt([{ kind: "paste", signature: "make dev", examples: [], count: 3, sessions: 3, sessionIds: [], confidence: "high" }]);
  expect(JSON.parse(prompt)[0].kind).toBe("paste");
});
```

Append to `cli/src/commands/scan.test.ts`:

```ts
it("feeds paste and answer candidates into detection (degraded path: pastes surface, answers need the LLM)", async () => {
  const errBody = "make dev\n" + "error: boom\n".repeat(40);
  const turns = ["s1", "s2", "s3"].map(sessionId =>
    ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user" as const, sessionId, text: errBody }));
  const logs: string[] = [];
  await scan(
    { scope: "project", projectPath: dir },
    { backend: null, collectFn: async () => ["f"], parseFn: async () => turns,
      parseDialogueFn: async () => [], log: m => logs.push(m) },
  );
  expect(logs.join("\n")).toMatch(/1 paste pattern/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/detect.test.ts src/commands/scan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cli/src/core/detect.ts` — in `buildDetectPrompt`, add `kind: c.kind` to the mapped JSON, and extend the system prompt (keep all existing sentences):

```ts
"Clusters with kind 'paste' are the user repeatedly pasting failing output of one command; the signature is that command's head line. " +
"For those, emit a command payload whose body tells Claude to run that command itself and fix what fails — never ask the user to paste output again. " +
"Clusters with kind 'answer' are the same short answer repeatedly given to similar questions; emit a rule payload — a standing instruction that removes the need to ask. " +
```

and the payload schema line becomes:

```ts
"{type:'command',commandName,body,triggers?} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description} | {type:'rule',target:'project'|'user',ruleName,text}. " +
```

Also update `degradeToCommands` to keep paste candidates useful without an LLM: `candidateToCommand` on a `kind: "paste"` candidate produces `body: "Run \`" + c.signature + "\` yourself, read the failures, and fix them. Do not ask the user to paste output."` (answers are dropped in degraded mode — a rule needs judgment). Guard: `if (c.kind === "answer") skip`.

`cli/src/commands/scan.ts` — `ScanDeps` gains `parseDialogueFn?: (path: string) => Promise<DialogueTurn[]>`. Paste turns must be pulled out **before** clustering, or a verbatim-identical paste repeated 3× would double-count as both a paste candidate and an exact lexical cluster. Replace Phase A's `cluster(kept)` call site with:

```ts
import { detectPasteCandidates, extractPasteKey } from "../core/paste.js";

const pastes = detectPasteCandidates(kept);
const clusterInput = kept.filter(t => !extractPasteKey(t.text ?? ""));
const clustered = cluster(clusterInput);   // flood filter from Phase A applies to `clustered` as before
if (pastes.length > 0) log(`${pastes.length} paste pattern(s) detected`);
const parseDialogueFn = deps.parseDialogueFn ?? parseDialogueFile;
const dialogue: DialogueTurn[] = [];
for (const f of files) dialogue.push(...(await parseDialogueFn(f)));
const answers = mineAnswerCandidates(extractAnswerPairs(dialogue));
if (answers.length > 0) log(`${answers.length} repeated-answer pattern(s) detected`);
const allCandidates = [...candidates, ...pastes, ...answers];
```

and pass `allCandidates` to `detect`.

`cli/src/cli.ts` HELP + `README.md`: mention error-paste skills and mined rules in the scan description ("finds repeated prompts, repeated error pastes, and repeated answers").

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/detect.ts cli/src/core/detect.test.ts cli/src/commands/scan.ts cli/src/commands/scan.test.ts cli/src/cli.ts README.md
git commit -m "feat(scan): paste + answer candidates flow into detection; rule payloads land"
```

---

## Execution notes (2026-07-09)

- **C1 head precision:** real-history validation found generic injected prose,
  Markdown headings, and a JSON delimiter satisfying the length/error-marker
  test. Paste keys now require a command-like head or an error marker in the
  head; this left the genuine repeated `make` failure in the 30-day sample and
  removed the false positives.
- **C1 template boundary:** the first implementation pulled pastes out before
  lexical clustering as planned, but that also let the 796-session security
  review injector bypass Phase A's flood filter. Paste groups now share the
  count/session flood gate before entering detection. A regression test covers
  the bypass.
- **C2 real format:** 1,730 recent transcripts contained 514 structured
  question results. `parseDialogueLines` reconstructs only their explicit
  question and user-authored answer fields; generic tool blocks and synthetic
  wrappers remain excluded. The default prompt parser is unchanged.
- **C3 similarity fixture:** the plan's three intended-similar questions score
  only 0.24–0.29 under raw trigram Jaccard, below the pinned 0.40 threshold, so
  the prescribed implementation could not pass its prescribed test. Mining
  compares question stems with the equivalent trigram Dice score while keeping
  the 0.40 floor; the dissimilar-question guard remains separate.
- **C4 write boundary:** project rules have apply/remove coverage; user rules
  have an apply-level assertion that they remain print-only with an empty
  manifest path.
- **C5 privacy hardening:** the no-LLM fallback previously redacted examples but
  not payload bodies, titles, names, or triggers. It now derives every emitted
  field from the redacted signature, so an inline credential in a command head
  cannot enter `suggestions.json`.
- **Validation:** the final suite contains 364 tests; typecheck, build, package
  dry-run, and a local 30-day detector pass are clean.
