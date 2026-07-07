# gradient — Instruction Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect instructions that don't hold — prompts restating what CLAUDE.md already says, and corrections that follow assistant actions — and route them into the suggestion funnel (rules / command hooks) plus an `insights` "Instruction effectiveness" section. Spec: `docs/superpowers/specs/2026-07-06-gradient-instruction-audit-design.md`.

**Architecture:** New `core/instructions.ts` loads and extracts instruction lines from the four sources (project CLAUDE.md, CLAUDE.local.md, `.claude/rules/*.md`, `~/.claude/CLAUDE.md`), read-only. New `core/audit.ts` runs the restatement detector (similarity vs. instruction lines), the correction detector (lexicon + existing clustering), and the cross-reference (violated vs. missing), producing `Candidate`s (`kind: "instruction"`, routing context in a new optional `Candidate.hint`) and per-instruction tallies persisted to `.gradient/audit.json` for insights. `detect` gains the instruction briefing; suggestions reuse Phase C2's `rule` payload and Spec 6's command-`hook` payload.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Execute after Spec 4 Phase C and Spec 6 merge.** Verify at execution time and adapt names if they drifted: C2's `rule` payload `{ type: "rule"; target: "project" | "user"; ruleName: string; text: string }` and rule emitter; Spec 6's hook payload `command`/`matcher` fields; Phase A's `classifyPrompts`. If Phase D (`insights`) has NOT merged yet, Task U5 records a follow-up in the Phase D plan instead of editing a nonexistent file — see U5 Step 1.
- **Constants (spec §2, pinned here):** `SIM = 0.7` (restatement AND cross-reference; revisit separately only with fixture evidence), `MIN_COUNT = 3`, `MIN_SESSIONS = 2`, `MAX_CORRECTION_LEN = 200`, instruction line length 8–200 chars, insights table cap 15 rows.
- **Never write to any CLAUDE.md / CLAUDE.local.md / rules file.** `instructions.ts` is read-only; suggested artifacts write only gradient-owned files (`.claude/rules/gradient-*.md` via C2's emitter, settings hooks via Spec 6's installer). Findings from `~/.claude/CLAUDE.md` become `target: "user"` rules (print-only).
- Audit candidates share Spec 6's window stance: capped at `Math.ceil(window / 3)`, drops logged.
- Tests: vitest, injected deps, no network, no real home directory (pass `home` explicitly).
- Branch: `spec/instruction-audit`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `Candidate.hint?: string`, `Candidate.kind` += `"instruction"` |
| `cli/src/core/instructions.ts` (create) | `InstructionLine`, `extractInstructionLines`, `loadInstructions` |
| `cli/src/core/audit.ts` (create) | `CORRECTION_RE`, `audit()`, tallies, cross-reference |
| `cli/src/core/detect.ts` (modify) | instruction briefing (rule vs command-hook vs user-target) |
| `cli/src/commands/scan.ts` (modify) | run audit, merge candidates, write `.gradient/audit.json`, summary log |
| `cli/src/commands/insights.ts` (modify, if Phase D merged) | "Instruction effectiveness" section |
| `README.md`, `cli/README.md` (modify) | wording |

---

### Task U1: `core/instructions.ts` — read-only instruction extraction

**Files:**
- Modify: `cli/src/core/types.ts`
- Create: `cli/src/core/instructions.ts`
- Test: `cli/src/core/instructions.test.ts` (create)

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `interface InstructionLine { source: "project" | "project-local" | "rule" | "user"; file: string; text: string; normalized: string }`
  - `extractInstructionLines(md: string): string[]`
  - `loadInstructions(projectDir: string, home: string): Promise<InstructionLine[]>`
  - `Candidate.hint?: string` and `"instruction"` added to `Candidate["kind"]` (types.ts)

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/instructions.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInstructionLines, loadInstructions } from "./instructions.js";

describe("extractInstructionLines", () => {
  it("keeps list items and short imperative paragraphs; strips markers", () => {
    const md = [
      "# Project", "", "- Always use pnpm, never npm.", "* Run `make dev` before testing.",
      "3. Keep PRs under 400 lines.", "", "Prefer small focused files.", "",
    ].join("\n");
    expect(extractInstructionLines(md)).toEqual([
      "Always use pnpm, never npm.", "Run `make dev` before testing.",
      "Keep PRs under 400 lines.", "Prefer small focused files.",
    ]);
  });
  it("skips headings, code blocks, tables, comments, and out-of-range lengths", () => {
    const md = [
      "## Rules", "```", "- not an instruction, it is code", "```",
      "| a | b |", "<!-- note -->", "ok?", "x".repeat(201),
    ].join("\n");
    expect(extractInstructionLines(md)).toEqual([]);
  });
});

describe("loadInstructions", () => {
  it("reads all four sources with correct tags and survives missing files", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-p-"));
    const home = await mkdtemp(join(tmpdir(), "grad-h-"));
    await writeFile(join(proj, "CLAUDE.md"), "- Use pnpm always here.");
    await writeFile(join(proj, "CLAUDE.local.md"), "- Local pref line here.");
    await mkdir(join(proj, ".claude", "rules"), { recursive: true });
    await writeFile(join(proj, ".claude", "rules", "style.md"), "- Two-space indent always.");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "- Reply in English.");
    const lines = await loadInstructions(proj, home);
    expect(lines.map(l => l.source).sort()).toEqual(["project", "project-local", "rule", "user"]);
    const user = lines.find(l => l.source === "user")!;
    expect(user.text).toBe("Reply in English.");
    expect(user.normalized.length).toBeGreaterThan(0);
  });
  it("returns [] when no sources exist", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-p-"));
    const home = await mkdtemp(join(tmpdir(), "grad-h-"));
    expect(await loadInstructions(proj, home)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/instructions.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: types.ts** — add `"instruction"` to the `Candidate.kind` union and add to `Candidate`:

```ts
  /** Routing context for detect (audit findings, etc.). Serialized into the judge prompt. */
  hint?: string;
```

- [ ] **Step 4: Implement** — create `cli/src/core/instructions.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalize } from "./cluster.js";

export interface InstructionLine {
  source: "project" | "project-local" | "rule" | "user";
  file: string;
  text: string;
  normalized: string;
}

const MIN_LEN = 8, MAX_LEN = 200;
const LIST_RE = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;

export function extractInstructionLines(md: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    if (line.startsWith("#") || line.startsWith("|") || line.startsWith("<!--") || line.startsWith(">")) continue;
    const m = LIST_RE.exec(line);
    const text = (m ? m[1] : line).trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    out.push(text);
  }
  return out;
}

async function fileLines(source: InstructionLine["source"], file: string): Promise<InstructionLine[]> {
  try {
    return extractInstructionLines(await readFile(file, "utf8"))
      .map(text => ({ source, file, text, normalized: normalize(text) }));
  } catch {
    return []; // missing/unreadable source → no instructions from it
  }
}

export async function loadInstructions(projectDir: string, home: string): Promise<InstructionLine[]> {
  const out = [
    ...(await fileLines("project", join(projectDir, "CLAUDE.md"))),
    ...(await fileLines("project-local", join(projectDir, "CLAUDE.local.md"))),
    ...(await fileLines("user", join(home, ".claude", "CLAUDE.md"))),
  ];
  try {
    const rulesDir = join(projectDir, ".claude", "rules");
    for (const f of await readdir(rulesDir)) {
      if (f.endsWith(".md")) out.push(...(await fileLines("rule", join(rulesDir, f))));
    }
  } catch { /* no rules dir */ }
  return out;
}
```

(Non-list paragraph lines are kept deliberately — spec §2 #3. A paragraph that isn't an instruction just never matches anything.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/instructions.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/instructions.ts cli/src/core/instructions.test.ts
git commit -m "feat(core): read-only instruction extraction from CLAUDE.md/rules sources"
```

---

### Task U2: `core/audit.ts` — restatements, corrections, cross-reference

**Files:**
- Create: `cli/src/core/audit.ts`
- Test: `cli/src/core/audit.test.ts` (create)

**Interfaces:**
- Consumes: `InstructionLine` (U1), `Turn`/`Candidate` (types), `normalize`/`similarity`/`cluster` from `./cluster.js`.
- Produces:
  - `const CORRECTION_RE: RegExp`
  - `interface InstructionTally { file: string; source: InstructionLine["source"]; text: string; restatements: number; violations: number; lastSeen: string }`
  - `audit(prompts: Turn[], instructions: InstructionLine[]): { candidates: Candidate[]; tallies: InstructionTally[] }`
  - Candidate hints (exact strings U3's briefing keys on): `restated instruction (<source>): "<text>"`, `correction violating instruction (<source>): "<text>"`, `repeated correction with no matching instruction`

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/audit.test.ts`:

```ts
import { audit, CORRECTION_RE } from "./audit.js";
import { normalize } from "./cluster.js";
import type { Turn } from "./types.js";
import type { InstructionLine } from "./instructions.js";

const turn = (text: string, sessionId: string, ts = "2026-07-01T00:00:00Z"): Turn =>
  ({ ts, project: "p", role: "user", sessionId, text });
const inst = (text: string, source: InstructionLine["source"] = "project"): InstructionLine =>
  ({ source, file: "CLAUDE.md", text, normalized: normalize(text) });

describe("CORRECTION_RE", () => {
  it("matches corrections, not ordinary prompts", () => {
    for (const s of ["no, use pnpm", "don't touch the migrations", "stop - wrong file",
                     "actually, revert that", "never push to main"]) {
      expect(CORRECTION_RE.test(s)).toBe(true);
    }
    for (const s of ["add a login page", "now update the docs", "not sure, you pick"]) {
      expect(CORRECTION_RE.test(s)).toBe(false);
    }
  });
});

describe("audit — restatements", () => {
  const instructions = [inst("always use pnpm, never npm")];
  it("flags an instruction restated 3× across 2 sessions", () => {
    const prompts = [
      turn("use pnpm not npm", "s1"), turn("always use pnpm never npm", "s1"),
      turn("use pnpm, not npm please", "s2"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    expect(tallies[0].restatements).toBe(3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("instruction");
    expect(candidates[0].hint).toBe('restated instruction (project): "always use pnpm, never npm"');
    expect(candidates[0].sessions).toBe(2);
  });
  it("stays silent below the floor (2 hits, or 1 session)", () => {
    expect(audit([turn("use pnpm not npm", "s1"), turn("use pnpm not npm", "s2")], instructions).candidates).toEqual([]);
    expect(audit([turn("use pnpm not npm", "s1"), turn("use pnpm not npm", "s1"),
                  turn("use pnpm not npm", "s1")], instructions).candidates).toEqual([]);
  });
});

describe("audit — corrections", () => {
  it("routes a correction cluster matching an instruction to violated", () => {
    const instructions = [inst("never edit generated files")];
    const prompts = [
      turn("no, never edit generated files", "s1"), turn("don't edit generated files!", "s2"),
      turn("stop, never edit generated files", "s3"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    const violated = candidates.find(c => c.hint?.startsWith("correction violating"));
    expect(violated).toBeDefined();
    expect(tallies[0].violations).toBeGreaterThanOrEqual(3);
  });
  it("routes an unmatched correction cluster to missing-instruction", () => {
    const prompts = [
      turn("don't use emojis in commit messages", "s1"),
      turn("don't use emojis in commits", "s2"),
      turn("no emojis in commit messages please", "s3"),
    ];
    const { candidates } = audit(prompts, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hint).toBe("repeated correction with no matching instruction");
  });
  it("ignores long messages even when they start like corrections", () => {
    const long = "don't " + "x".repeat(200);
    expect(audit([turn(long, "s1"), turn(long, "s2"), turn(long, "s3")], []).candidates).toEqual([]);
  });
  it("never double-counts a correction as a restatement", () => {
    const instructions = [inst("never edit generated files")];
    const prompts = [
      turn("no, never edit generated files", "s1"), turn("don't edit generated files!", "s2"),
      turn("stop, never edit generated files", "s3"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    expect(tallies[0].restatements).toBe(0);
    expect(candidates.filter(c => c.hint?.startsWith("restated"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/audit.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `cli/src/core/audit.ts`:

```ts
import type { Candidate, Turn } from "./types.js";
import type { InstructionLine } from "./instructions.js";
import { cluster, normalize, similarity } from "./cluster.js";

export const AUDIT = { SIM: 0.7, MIN_COUNT: 3, MIN_SESSIONS: 2, MAX_CORRECTION_LEN: 200 } as const;

export const CORRECTION_RE =
  /^(no[,.!\s]|don'?t\s|do not\s|stop[\s,.!-]|never\s|actually[,\s]|instead[,\s]|that'?s (wrong|not right)|wrong[,.\s]|undo\s|revert\s)/i;

export interface InstructionTally {
  file: string;
  source: InstructionLine["source"];
  text: string;
  restatements: number;
  violations: number;
  lastSeen: string;
}

function bestMatch(normalized: string, instructions: InstructionLine[]): InstructionLine | undefined {
  let best: InstructionLine | undefined;
  let bestScore = 0;
  for (const i of instructions) {
    const s = similarity(normalized, i.normalized);
    if (s >= AUDIT.SIM && s > bestScore) { best = i; bestScore = s; }
  }
  return best;
}

export function audit(prompts: Turn[], instructions: InstructionLine[]):
  { candidates: Candidate[]; tallies: InstructionTally[] } {
  const tallies = new Map<InstructionLine, InstructionTally>();
  const tally = (i: InstructionLine) => {
    const t = tallies.get(i) ?? { file: i.file, source: i.source, text: i.text,
      restatements: 0, violations: 0, lastSeen: "" };
    tallies.set(i, t);
    return t;
  };

  // Restatements: human prompts ≈ an instruction line.
  const restated = new Map<InstructionLine, Turn[]>();
  const corrections: Turn[] = [];
  for (const p of prompts) {
    const text = p.text ?? "";
    if (CORRECTION_RE.test(text)) {
      // Corrections flow ONLY through the correction path: a correction that
      // matches an instruction must count as a violation, not a restatement —
      // otherwise one behavior produces two candidates and inflated tallies.
      if (text.length < AUDIT.MAX_CORRECTION_LEN) corrections.push(p);
      continue;
    }
    const hit = bestMatch(normalize(text), instructions);
    if (hit) {
      restated.set(hit, [...(restated.get(hit) ?? []), p]);
      const t = tally(hit);
      t.restatements++;
      if (p.ts > t.lastSeen) t.lastSeen = p.ts;
    }
  }

  const candidates: Candidate[] = [];
  for (const [i, hits] of restated) {
    const sessions = new Set(hits.map(h => h.sessionId));
    if (hits.length < AUDIT.MIN_COUNT || sessions.size < AUDIT.MIN_SESSIONS) continue;
    candidates.push({
      kind: "instruction", signature: i.normalized,
      examples: hits.slice(0, 3).map(h => h.text ?? ""),
      count: hits.length, sessions: sessions.size, sessionIds: [...sessions],
      confidence: "inferred",
      hint: `restated instruction (${i.source}): "${i.text}"`,
    });
  }

  // Corrections: cluster the subset, then cross-reference each cluster.
  for (const c of cluster(corrections)) {
    if (c.count < AUDIT.MIN_COUNT || c.sessions < AUDIT.MIN_SESSIONS) continue;
    const hit = bestMatch(c.signature, instructions);
    if (hit) {
      const t = tally(hit);
      t.violations += c.count;
      candidates.push({ ...c, kind: "instruction",
        hint: `correction violating instruction (${hit.source}): "${hit.text}"` });
    } else {
      candidates.push({ ...c, kind: "instruction",
        hint: "repeated correction with no matching instruction" });
    }
  }

  return {
    candidates,
    tallies: [...tallies.values()]
      .filter(t => t.restatements + t.violations > 0)
      .sort((a, b) => (b.restatements + b.violations) - (a.restatements + a.violations)),
  };
}
```

(If `cluster()`'s Candidate output doesn't spread cleanly — e.g. it lacks `sessionIds` in some path — adapt here, not in cluster.ts.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/audit.test.ts && npm run typecheck`
Expected: PASS. If the restatement fixture misses at `SIM = 0.7`, the fixture prompts may legitimately sit below trigram-similarity 0.7 — tune the *fixture wording* first (closer restatements), and only lower SIM with a comment if real-history spot checks agree (spec §10 open question).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/audit.ts cli/src/core/audit.test.ts
git commit -m "feat(core): instruction audit — restatement + correction detectors with cross-reference"
```

---

### Task U3: Detect briefing for instruction candidates

**Files:**
- Modify: `cli/src/core/detect.ts`
- Test: `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: `Candidate.hint` (U1), rule payload (Phase C2), command-hook payload (Spec 6).
- Produces: instruction briefing in the detect prompt; degraded mode skips `instruction` candidates (same guard style as Spec 6's T5).

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/detect.test.ts`:

```ts
it("degraded mode skips instruction candidates", async () => {
  const cand = { kind: "instruction", signature: "always use pnpm never npm",
    examples: ["use pnpm not npm"], count: 3, sessions: 2, sessionIds: ["s1", "s2"],
    confidence: "inferred", hint: 'restated instruction (project): "always use pnpm, never npm"' };
  expect(await detect([cand as any], null, { limit: 10 })).toEqual([]);
});
it("serializes and redacts hint text in the judge prompt", async () => {
  // Reuse the recording-fake-backend pattern already used in this test file.
  let seen = "";
  const backend = recordingBackend(prompt => { seen = prompt; return "[]"; });
  const leaky = { ...cand, hint: 'restated instruction (project): "use key sk-ant-api03-abcdef1234567890"' };
  await detect([leaky as any], backend, { limit: 10 });
  expect(seen).toContain("restated instruction (project)");
  expect(seen).not.toContain("sk-ant-api03-abcdef1234567890"); // hint passes redact()
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/detect.test.ts`
Expected: FAIL (degraded mode currently fabricates a command suggestion; hint is not serialized).

- [ ] **Step 3: Implement** — in `cli/src/core/detect.ts`:
  - Degraded-mode guard: add `"instruction"` to the kinds skipped without a backend.
  - Candidate serialization: when `c.hint` is set, include a `hint: <text>` line in that candidate's block, passed through `redact()` (`./security.js`) exactly like example text — instruction lines are the user's own files, but the pass is cheap and consistent (spec §5).
  - Append to the single authoritative type-decision briefing:

```
Candidates with kind 'instruction' are audit findings about the user's written instructions; their hint says which case:
- "restated instruction …": the user keeps typing what is already written. If the instruction is hook-shaped (contains a runnable command, or reads like "always/never run X"), produce {type:'hook',event:'PostToolUse',matcher:'Edit|Write|NotebookEdit',command,description} with the command it mandates; otherwise produce {type:'rule',target:'project',ruleName,text} restating it in enforceable, mechanical terms.
- "correction violating instruction …": same choice, but the rationale must say the written instruction provably fails.
- "repeated correction with no matching instruction": produce {type:'rule',…} capturing the correction as a standing rule.
If the hint names source (user), the finding comes from ~/.claude/CLAUDE.md: use target:'user' (gradient prints it; it never edits that file).
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/detect.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/detect.ts cli/src/core/detect.test.ts
git commit -m "feat(detect): instruction-audit briefing — rules vs command hooks, user-target print-only"
```

---

### Task U4: Scan wiring + `.gradient/audit.json`

**Files:**
- Modify: `cli/src/commands/scan.ts`
- Test: `cli/src/commands/scan.test.ts` (append)

**Interfaces:**
- Consumes: `loadInstructions` (U1), `audit` (U2), Spec 6's window-share cap pattern.
- Produces: `.gradient/audit.json` — `{ generatedAt: string; tallies: InstructionTally[] }` (U5 and Phase D read this); scan log `instruction audit: N instructions · R restatement findings · C correction findings`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/commands/scan.test.ts` (injected-deps style; write a real CLAUDE.md into the temp project dir):

```ts
import type { Turn } from "../core/types.js";

const turn = (text: string, sessionId: string): Turn =>
  ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId, text });
// dir and fakeHome: fresh mkdtemp dirs per test, matching this file's existing setup.

it("runs the instruction audit and persists tallies", async () => {
  await writeFile(join(dir, "CLAUDE.md"), "- Always use pnpm, never npm.");
  const logs: string[] = [];
  await scan({ scope: "project", projectPath: dir, home: fakeHome }, {
    backend: null, config: {}, log: m => logs.push(m),
    collectFn: async () => ["f1"],
    parseFn: async () => [
      turn("use pnpm never npm", "s1"), turn("always use pnpm never npm", "s1"),
      turn("use pnpm never npm ok", "s2"),
    ],
  });
  const auditJson = JSON.parse(await readFile(join(dir, ".gradient", "audit.json"), "utf8"));
  expect(auditJson.tallies[0].restatements).toBe(3);
  expect(logs.some(l => l.startsWith("instruction audit:"))).toBe(true);
});
it("is a silent no-op with no instruction sources", async () => {
  const logs: string[] = [];
  await scan({ scope: "project", projectPath: dir, home: fakeHome }, {
    backend: null, config: {}, log: m => logs.push(m),
    collectFn: async () => ["f1"], parseFn: async () => [],
  });
  expect(existsSync(join(dir, ".gradient", "audit.json"))).toBe(false);
  expect(logs.some(l => l.startsWith("instruction audit:"))).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/scan.test.ts`
Expected: FAIL — no audit wiring.

- [ ] **Step 3: Implement** — in `cli/src/commands/scan.ts`, after the recency cap (`kept`) and before detect:

```ts
const instructions = await loadInstructions(projectDir, opts.home ?? homedir());
let auditCandidates: Candidate[] = [];
if (instructions.length > 0) {
  const { candidates: found, tallies } = audit(kept, instructions);
  log(`instruction audit: ${instructions.length} instructions · ` +
      `${found.filter(c => c.hint?.startsWith("restated")).length} restatement findings · ` +
      `${found.filter(c => !c.hint?.startsWith("restated")).length} correction findings`);
  auditCandidates = found.sort((a, b) => b.count - a.count);
  const cap = Math.ceil(window / 3);
  if (auditCandidates.length > cap) {
    log(`audit candidates capped to ${cap}; ${auditCandidates.length - cap} dropped`);
    auditCandidates = auditCandidates.slice(0, cap);
  }
  if (tallies.length > 0) {
    await mkdir(gdir, { recursive: true });
    await writeFile(join(gdir, "audit.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), tallies }, null, 2));
  }
}
```

Then include `auditCandidates` in the detect call's candidate array (alongside Spec 6's `toolCandidates`). Note `projectDir`/`gdir` are computed lower in today's file — hoist them above this block.

- [ ] **Step 4: Run all tests + typecheck**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/scan.ts cli/src/commands/scan.test.ts
git commit -m "feat(scan): instruction audit wired into the funnel; tallies persisted for insights"
```

---

### Task U5: `insights` — "Instruction effectiveness" section

**Files:**
- Modify: `cli/src/commands/insights.ts` (only if Phase D has merged)
- Test: `cli/src/commands/insights.test.ts` (append)

**Interfaces:**
- Consumes: `.gradient/audit.json` (U4).

- [ ] **Step 1: Check the dependency.** If `cli/src/commands/insights.ts` does not exist (Phase D unmerged), add this exact follow-up to the Phase D plan's task list and **stop this task here** (the rest of the plan proceeds):

```markdown
- [ ] Instruction effectiveness section (from Spec 7 / plan U5): read
  `.gradient/audit.json`; when present, render per instruction (≤15 rows,
  sorted by restatements+violations): `"<text ≤60 chars>" · restated N× ·
  violated M× · last seen <date>`, plus the recommendation line
  "these instructions aren't holding — run gradient review to convert them".
  Absent file → section omitted entirely.
```

- [ ] **Step 2: Write the failing tests** — append to `cli/src/commands/insights.test.ts`:

```ts
it("renders instruction effectiveness from audit.json, capped at 15 rows", async () => {
  const tallies = Array.from({ length: 20 }, (_, i) => ({
    file: "CLAUDE.md", source: "project", text: `instruction number ${i} with some length`,
    restatements: 20 - i, violations: 0, lastSeen: "2026-07-01T00:00:00Z",
  }));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "audit.json"),
    JSON.stringify({ generatedAt: "2026-07-06T00:00:00Z", tallies }));
  const out = await insights(dir /* match Phase D's actual signature */);
  expect(out).toContain("Instruction effectiveness");
  expect(out).toContain("instruction number 0");
  expect(out).not.toContain("instruction number 16");
});
it("omits the section when audit.json is absent", async () => {
  const out = await insights(dir);
  expect(out).not.toContain("Instruction effectiveness");
});
```

(Adapt call/return shape to Phase D's actual `insights` API — it may log via an injected logger rather than return a string; assert on whichever surface it uses.)

- [ ] **Step 3: Implement** — in the Phase D insights renderer, after the existing metric table: read `.gradient/audit.json` (try/catch → absent = omit section), sort tallies by `restatements + violations` descending, slice 15, render rows `"<text truncated to 60>" · restated N× · violated M× · last seen <lastSeen date part>` under an `Instruction effectiveness` heading, with one recommendation line pointing at `gradient review`.

- [ ] **Step 4: Run tests, commit**

Run: `cd cli && npm test && npm run typecheck`

```bash
git add cli/src/commands/insights.ts cli/src/commands/insights.test.ts
git commit -m "feat(insights): instruction-effectiveness section from audit tallies"
```

---

### Task U6: Docs + dead-text pass

**Files:**
- Modify: `README.md`, `cli/README.md`

**Interfaces:** none (copy only).

- [ ] **Step 1:** `README.md` — in the feature list ("finds the workflows you repeat"), add one line: gradient also audits whether your CLAUDE.md instructions actually hold, and converts the ones that don't into rules and hooks.

- [ ] **Step 2:** `cli/README.md` "How it works" — step 2 gains: "…and audits your CLAUDE.md / rules files (read-only) for instructions you restate or correct."

- [ ] **Step 3:** Confirm `detect.ts`'s briefing is one block (U3 replaced, Spec 6 T5's stance) — no stale duplicate wording from earlier phases. Fix inline if found.

- [ ] **Step 4: Full run + commit**

Run: `cd cli && npm test && npm run typecheck`

```bash
git add README.md cli/README.md
git commit -m "docs: instruction-audit wording"
```
