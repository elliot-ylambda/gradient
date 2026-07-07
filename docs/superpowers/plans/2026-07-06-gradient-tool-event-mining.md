# gradient — Tool-Event Mining — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine the assistant's half of the transcript — recurring in-session command failures ("failure loops") and commands repeatedly run after file edits ("post-edit rituals") — and route them through the existing suggestion funnel, including installable `PostToolUse` command hooks. Spec: `docs/superpowers/specs/2026-07-06-gradient-tool-event-mining-design.md`.

**Architecture:** `parse.ts` gains an opt-in `parseToolEventsFile` pass (tool_use/tool_result pairing, per-session caps). New `core/toolmine.ts` turns events into `Candidate`s (`kind: "toolfail" | "ritual"`) that bypass trigram clustering and join the detect window (capped at ⌈window/3⌉, drops logged). The `hook` payload generalizes to carry either the existing gradient `subcommand` or a mined verbatim `command` + `matcher`; command hooks install via a matcher-aware `installHook` on apply and uninstall via `remove` (manifest-tracked) — subcommand hooks keep their print-only behavior.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Execute after Spec 4 Phase A merges** (`spec/v2-phase-a`): this plan touches `types.ts`, `detect.ts`, `scan.ts` seams Phase A reshapes. If Phase C1 (`core/paste.ts`) has also merged, extract its head-truncation into `toolmine.ts`'s `commandHead` and re-point paste.ts to it (Spec 6 Decision 7); otherwise `commandHead` lives in `toolmine.ts` alone.
- **Constants (spec §4–§5, pinned here; adjust only with fixture evidence):** `FAIL_MIN_COUNT = 3`, `FAIL_MIN_SESSIONS = 2`, `RITUAL_WINDOW = 3`, `RITUAL_MIN_OBS = 15`, `RITUAL_MIN_SESSIONS = 3`, `RITUAL_ATTACH_RATIO = 0.4`, `HEAD_MAX = 80`, `ERROR_HEAD_MAX = 120`, `PER_SESSION_EVENT_CAP = 400`, tool-candidate share of detect window = `Math.ceil(window / 3)`.
- **Command-hook safety (spec §2 #3, §6):** hook payloads carry exactly one of `subcommand` | `command`; `command` is single-line, ≤ 200 chars; `matcher` must compile as a RegExp. `review` prints the verbatim command with an install warning. Nothing is auto-installed — `apply` is the approval.
- Config key: `mineToolEvents?: boolean` (absent = on).
- Only the `Bash` tool and `Edit`/`Write`/`NotebookEdit` are extracted; tool outputs never leave the machine beyond a redacted ≤120-char first error line (`redact` from `core/security.js`).
- No silent caps: every drop (per-session event cap, window share) is logged.
- Tests: vitest, injected deps, no network. From `cli/`: `npm test`, `npm run typecheck`.
- Branch: `spec/tool-mining`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `ToolEvent`, `Config.mineToolEvents`, widened hook payload, `ManifestEntry.hook`, `Candidate.kind` += `"toolfail" \| "ritual"`, header comment rewrite |
| `cli/src/core/validate.ts` (modify) | exactly-one-of hook validation, command/matcher rules |
| `cli/src/core/parse.ts` (modify) | `parseToolEventLines`, `parseToolEventsFile` |
| `cli/src/core/toolmine.ts` (create) | `commandHead`, `failureLoops`, `rituals`, `TOOLMINE` constants |
| `cli/src/core/settings.ts` (modify) | matcher-aware merge/remove/install |
| `cli/src/core/emit/hook.ts` + `emit/index.ts` (modify) | command form → `install` descriptor |
| `cli/src/core/apply.ts` (modify) | install command hooks; manifest `hook` field |
| `cli/src/commands/remove.ts` (modify) | uninstall command hooks via `removeHook` |
| `cli/src/commands/review.ts` (modify) | verbatim-command warning line |
| `cli/src/commands/scan.ts` (modify) | tool-event pass + candidate merge + logs |
| `cli/src/core/detect.ts` (modify) | toolfail/ritual briefing; degraded-mode guard |
| `README.md`, `cli/README.md` (modify) | wording |

---

### Task T1: Types + hook-payload validation

**Files:**
- Modify: `cli/src/core/types.ts`
- Modify: `cli/src/core/validate.ts`
- Test: `cli/src/core/validate.test.ts` (append)

**Interfaces:**
- Produces (all later tasks rely on these exact names):
  - `interface ToolEvent { ts: string; sessionId: string; kind: "bash" | "edit"; command?: string; isError?: boolean; errorHead?: string; file?: string }`
  - hook payload: `{ type: "hook"; event: string; description: string; matcher?: string; subcommand?: string; command?: string }`
  - `ManifestEntry.hook?: { event: string; matcher?: string; command: string }`
  - `Candidate["kind"]` includes `"toolfail" | "ritual"`
  - `Config.mineToolEvents?: boolean`

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/validate.test.ts`:

```ts
const base = {
  id: "a1b2c3d4e5", name: "n", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "inferred",
};
const hook = (payload: Record<string, unknown>) => ({ ...base, payload: { type: "hook", event: "PostToolUse", description: "d", ...payload } });

describe("hook payload: subcommand xor command", () => {
  it("accepts the existing subcommand form", () => {
    expect(() => validateSuggestion(hook({ subcommand: "checkpoint" }))).not.toThrow();
  });
  it("accepts a command form with matcher", () => {
    expect(() => validateSuggestion(hook({ command: "npm run lint", matcher: "Edit|Write|NotebookEdit" }))).not.toThrow();
  });
  it("rejects both, neither, multi-line, oversized, and bad matcher", () => {
    expect(() => validateSuggestion(hook({ subcommand: "scan", command: "npm t" }))).toThrow(/exactly one/);
    expect(() => validateSuggestion(hook({}))).toThrow(/exactly one/);
    expect(() => validateSuggestion(hook({ command: "a\nb" }))).toThrow(/single line/);
    expect(() => validateSuggestion(hook({ command: "x".repeat(201) }))).toThrow(/single line/);
    expect(() => validateSuggestion(hook({ command: "npm t", matcher: "[unclosed" }))).toThrow(/matcher/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/validate.test.ts`
Expected: FAIL — current validator demands `subcommand` unconditionally.

- [ ] **Step 3: Implement types** — in `cli/src/core/types.ts`:
  - Rewrite the `Turn` header comment (it claims prompt-only mining — now false):

```ts
/** One genuine user prompt after parse + filter. Tool activity is mined
 * separately via parseToolEvents (ToolEvent below); assistant text is
 * rendered by core/tail.ts for autopilot. */
```

  - Add after `Turn`:

```ts
/** One tool invocation, mined by parse.ts#parseToolEvents. Only Bash and the
 * file-edit tools are extracted; outputs never exceed a redacted errorHead. */
export interface ToolEvent {
  ts: string;
  sessionId: string;
  kind: "bash" | "edit";
  command?: string;    // bash: first line, whitespace-collapsed
  isError?: boolean;   // bash: from the paired tool_result
  errorHead?: string;  // bash: redacted first output line, ≤120 chars
  file?: string;       // edit: file_path input
}
```

  - Widen `Candidate.kind` to `ArtifactType | "unknown" | "toolfail" | "ritual"` (append to whatever union Phase A/C left there).
  - Replace the hook payload variant with:

```ts
  | { type: "hook"; event: string; description: string; matcher?: string; subcommand?: string; command?: string }
```

  - `ManifestEntry` gains `hook?: { event: string; matcher?: string; command: string };`
  - `Config` gains `/** Mine tool events (failure loops, post-edit rituals). Absent = on. */ mineToolEvents?: boolean;`

- [ ] **Step 4: Implement validation** — in `cli/src/core/validate.ts`, replace the `payload.type === "hook"` block:

```ts
if (payload.type === "hook") {
  if (typeof payload.event !== "string") throw new Error("hook payload needs event");
  const hasSub = typeof payload.subcommand === "string";
  const hasCmd = typeof payload.command === "string";
  if (hasSub === hasCmd) throw new Error("hook payload needs exactly one of subcommand | command");
  if (hasCmd) {
    const cmd = (payload.command as string).trim();
    if (!cmd || cmd.length > 200 || /[\r\n]/.test(payload.command as string)) {
      throw new Error("hook command must be a non-empty single line of ≤ 200 chars");
    }
  }
  if (payload.matcher !== undefined) {
    if (typeof payload.matcher !== "string") throw new Error("hook matcher must be a string");
    try { new RegExp(payload.matcher); } catch { throw new Error(`invalid hook matcher: ${String(payload.matcher)}`); }
  }
}
```

  And in `assertHookRunnable`, only check `KNOWN_SUBCOMMANDS` when `s.payload.subcommand !== undefined`.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/validate.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/validate.ts cli/src/core/validate.test.ts
git commit -m "feat(core): ToolEvent type + hook payload carries mined commands (subcommand xor command)"
```

---

### Task T2: `parseToolEvents` — pairing + caps

**Files:**
- Modify: `cli/src/core/parse.ts`
- Test: `cli/src/core/parse.test.ts` (append)

**Interfaces:**
- Consumes: `ToolEvent` (T1), `redact` from `./security.js`.
- Produces: `parseToolEventLines(lines: string[]): { events: ToolEvent[]; dropped: number }` and `parseToolEventsFile(path: string): Promise<{ events: ToolEvent[]; dropped: number }>` — T5 injects the latter into scan.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/parse.test.ts`:

```ts
import { parseToolEventLines } from "./parse.js";

const use = (id: string, name: string, input: Record<string, unknown>, session = "s1") =>
  JSON.stringify({ type: "assistant", sessionId: session, timestamp: "2026-07-01T00:00:00Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, isError: boolean, text: string, session = "s1") =>
  JSON.stringify({ type: "user", sessionId: session,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });

describe("parseToolEventLines", () => {
  it("pairs bash tool_use with its result and keeps a redacted error head", () => {
    const { events } = parseToolEventLines([
      use("t1", "Bash", { command: "npm test" }),
      result("t1", true, "FAIL src/x.test.ts\n  expected 1 to be 2"),
    ]);
    expect(events).toEqual([{
      ts: "2026-07-01T00:00:00Z", sessionId: "s1", kind: "bash",
      command: "npm test", isError: true, errorHead: "FAIL src/x.test.ts",
    }]);
  });
  it("emits edit events from Edit/Write/NotebookEdit and ignores other tools", () => {
    const { events } = parseToolEventLines([
      use("t1", "Edit", { file_path: "/p/src/a.ts" }),
      use("t2", "Read", { file_path: "/p/src/a.ts" }),
      use("t3", "Write", { file_path: "/p/src/b.ts" }),
    ]);
    expect(events.map(e => e.kind)).toEqual(["edit", "edit"]);
    expect(events[0].file).toBe("/p/src/a.ts");
  });
  it("skips unpaired bash uses (interrupted turns) and sidechains", () => {
    const side = JSON.stringify({ type: "assistant", isSidechain: true, sessionId: "s1",
      message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] } });
    const { events } = parseToolEventLines([use("t1", "Bash", { command: "npm test" }), side]);
    expect(events).toEqual([]);
  });
  it("collapses multi-line commands to their first line", () => {
    const { events } = parseToolEventLines([
      use("t1", "Bash", { command: "make dev \\\n  EXTRA=1" }), result("t1", false, "ok"),
    ]);
    expect(events[0].command).toBe("make dev \\");
  });
  it("caps per session at 400 and reports drops", () => {
    const lines: string[] = [];
    for (let i = 0; i < 405; i++) {
      lines.push(use(`t${i}`, "Bash", { command: `echo ${i}` }), result(`t${i}`, false, "ok"));
    }
    const { events, dropped } = parseToolEventLines(lines);
    expect(events).toHaveLength(400);
    expect(dropped).toBe(5);
    expect(events[0].command).toBe("echo 5"); // oldest dropped first
  });
  it("redacts secrets in the error head", () => {
    const { events } = parseToolEventLines([
      use("t1", "Bash", { command: "deploy" }), result("t1", true, "auth failed: sk-ant-api03-abcdef1234567890"),
    ]);
    expect(events[0].errorHead).not.toContain("sk-ant-");
  });
});
```

(If the exact `redact` pattern differs, assert on whatever `redact("…sk-ant-…")` actually produces — the point is that `errorHead` passes through `redact`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/parse.test.ts`
Expected: FAIL — `parseToolEventLines` is not exported.

- [ ] **Step 3: Implement** — in `cli/src/core/parse.ts` (extend the `Raw` interfaces; keep `parseLines`/`parseFile` untouched):

```ts
import { redact } from "./security.js";
import type { ToolEvent } from "./types.js";

interface RawToolBlock extends RawBlock {
  id?: string; name?: string; input?: Record<string, unknown>;
  tool_use_id?: string; is_error?: boolean; content?: unknown;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PER_SESSION_EVENT_CAP = 400;
const ERROR_HEAD_MAX = 120;

function firstLine(v: unknown): string {
  const text = typeof v === "string"
    ? v
    : Array.isArray(v) ? v.map(b => (b as RawBlock)?.text ?? "").join("\n") : "";
  return text.split(/\r?\n/).find(l => l.trim()) ?? "";
}

export function parseToolEventLines(lines: string[]): { events: ToolEvent[]; dropped: number } {
  const pending = new Map<string, ToolEvent>(); // tool_use id → bash event awaiting its result
  const perSession = new Map<string, ToolEvent[]>();
  let dropped = 0;
  const push = (e: ToolEvent) => {
    const arr = perSession.get(e.sessionId) ?? [];
    if (arr.length >= PER_SESSION_EVENT_CAP) { arr.shift(); dropped++; }
    arr.push(e);
    perSession.set(e.sessionId, arr);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Raw & { message?: { content?: string | RawToolBlock[] } };
    try { raw = JSON.parse(line); } catch { continue; }
    if (raw.isSidechain) continue;
    const content = raw.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as RawToolBlock[]) {
      if (raw.type === "assistant" && b.type === "tool_use" && b.id) {
        if (b.name === "Bash") {
          const command = String(b.input?.command ?? "").split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
          if (command) pending.set(b.id, {
            ts: raw.timestamp ?? "", sessionId: raw.sessionId ?? "?", kind: "bash", command,
          });
        } else if (EDIT_TOOLS.has(b.name ?? "")) {
          push({ ts: raw.timestamp ?? "", sessionId: raw.sessionId ?? "?", kind: "edit",
                 file: String(b.input?.file_path ?? "") });
        }
      } else if (raw.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        const p = pending.get(b.tool_use_id);
        if (p) {
          pending.delete(b.tool_use_id);
          push({ ...p, isError: b.is_error === true,
                 errorHead: redact(firstLine(b.content)).slice(0, ERROR_HEAD_MAX) });
        }
      }
    }
  }
  // unpaired pending (interrupted turns) are skipped by design
  return { events: [...perSession.values()].flat(), dropped };
}

export async function parseToolEventsFile(path: string): Promise<{ events: ToolEvent[]; dropped: number }> {
  const content = await readFile(path, "utf8");
  return parseToolEventLines(content.split(/\r?\n/));
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/parse.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/parse.ts cli/src/core/parse.test.ts
git commit -m "feat(core): parseToolEvents — bash/edit extraction with pairing, caps, redacted error heads"
```

---

### Task T3: `core/toolmine.ts` — failure loops + rituals

**Files:**
- Create: `cli/src/core/toolmine.ts`
- Test: `cli/src/core/toolmine.test.ts` (create)

**Interfaces:**
- Consumes: `ToolEvent`, `Candidate` (T1).
- Produces: `commandHead(command: string): string`; `failureLoops(events: ToolEvent[]): Candidate[]`; `rituals(events: ToolEvent[]): Candidate[]`; `const TOOLMINE` with the Global Constraints values. T5 calls both detectors.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/toolmine.test.ts`:

```ts
import { commandHead, failureLoops, rituals, TOOLMINE } from "./toolmine.js";
import type { ToolEvent } from "./types.js";

let n = 0;
const bash = (command: string, isError: boolean, sessionId: string, errorHead = "err"): ToolEvent =>
  ({ ts: `2026-07-01T00:00:${String(n++ % 60).padStart(2, "0")}Z`, sessionId, kind: "bash", command, isError, errorHead });
const edit = (sessionId: string, file = "/p/a.ts"): ToolEvent =>
  ({ ts: "t", sessionId, kind: "edit", file });

describe("commandHead", () => {
  it("collapses whitespace and truncates to 80", () => {
    expect(commandHead("npm   test  --run")).toBe("npm test --run");
    expect(commandHead("x".repeat(100))).toHaveLength(80);
  });
});

describe("failureLoops", () => {
  it("groups same-head failures across sessions into one toolfail candidate", () => {
    const events = [
      bash("npm test", true, "s1", "FAIL a"), bash("npm test", true, "s1", "FAIL b"),
      bash("npm test", true, "s2", "FAIL c"), bash("npm test", false, "s2"),
      bash("npm run build", true, "s1"), // below floor
    ];
    const [c, ...rest] = failureLoops(events);
    expect(rest).toEqual([]);
    expect(c.kind).toBe("toolfail");
    expect(c.signature).toBe("npm test");
    expect(c.count).toBe(3);
    expect(c.sessions).toBe(2);
    expect(c.examples).toEqual(["FAIL a", "FAIL b", "FAIL c"]);
  });
  it("needs ≥2 sessions", () => {
    const events = [bash("npm test", true, "s1"), bash("npm test", true, "s1"), bash("npm test", true, "s1")];
    expect(failureLoops(events)).toEqual([]);
  });
});

describe("rituals", () => {
  const attached = (sessions = 3, obsPerSession = 6, fillerPerSession = 2) => {
    const events: ToolEvent[] = [];
    for (let s = 1; s <= sessions; s++) {
      for (let i = 0; i < obsPerSession; i++) {
        events.push(edit(`s${s}`), bash("npm run lint", false, `s${s}`));
      }
      for (let i = 0; i < fillerPerSession; i++) {
        events.push(edit(`s${s}`), bash(`echo ${s}-${i}`, false, `s${s}`)); // dilutes ratio, stays ≥0.4
      }
    }
    return events;
  };
  it("detects a command attached to edit windows", () => {
    const [c, ...rest] = rituals(attached());
    expect(rest).toEqual([]);
    expect(c.kind).toBe("ritual");
    expect(c.signature).toBe("npm run lint");
    expect(c.count).toBe(18);
    expect(c.sessions).toBe(3);
  });
  it("ignores frequent commands that do not follow edits", () => {
    const events: ToolEvent[] = [];
    for (let s = 1; s <= 3; s++) for (let i = 0; i < 6; i++) events.push(bash("npm run lint", false, `s${s}`));
    expect(rituals(events)).toEqual([]);
  });
  it("does not look past the window", () => {
    const events: ToolEvent[] = [];
    for (let s = 1; s <= 3; s++) for (let i = 0; i < 6; i++) {
      events.push(edit(`s${s}`),
        bash("a", false, `s${s}`), bash("b", false, `s${s}`), bash("c", false, `s${s}`),
        bash("npm run lint", false, `s${s}`)); // 4th event after the edit — outside RITUAL_WINDOW
    }
    expect(rituals(events).map(c => c.signature)).not.toContain("npm run lint");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/toolmine.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `cli/src/core/toolmine.ts`:

```ts
import type { Candidate, ToolEvent } from "./types.js";

export const TOOLMINE = {
  FAIL_MIN_COUNT: 3, FAIL_MIN_SESSIONS: 2,
  RITUAL_WINDOW: 3, RITUAL_MIN_OBS: 15, RITUAL_MIN_SESSIONS: 3, RITUAL_ATTACH_RATIO: 0.4,
  HEAD_MAX: 80,
} as const;

/** Same failing invocation shares its head even when error bodies differ. */
export function commandHead(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, TOOLMINE.HEAD_MAX);
}

interface Group { count: number; sessionIds: Set<string>; examples: string[] }
const grow = (m: Map<string, Group>, key: string, sessionId: string, example?: string) => {
  const g = m.get(key) ?? { count: 0, sessionIds: new Set<string>(), examples: [] };
  g.count++; g.sessionIds.add(sessionId);
  if (example && g.examples.length < 3 && !g.examples.includes(example)) g.examples.push(example);
  m.set(key, g);
};
const toCandidate = (kind: Candidate["kind"], key: string, g: Group): Candidate => ({
  kind, signature: key, examples: g.examples.length ? g.examples : [key],
  count: g.count, sessions: g.sessionIds.size, sessionIds: [...g.sessionIds],
  confidence: "inferred",
});

export function failureLoops(events: ToolEvent[]): Candidate[] {
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.kind !== "bash" || !e.isError || !e.command) continue;
    grow(groups, commandHead(e.command), e.sessionId, e.errorHead);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.count >= TOOLMINE.FAIL_MIN_COUNT && g.sessionIds.size >= TOOLMINE.FAIL_MIN_SESSIONS)
    .map(([k, g]) => toCandidate("toolfail", k, g))
    .sort((a, b) => b.count - a.count);
}

export function rituals(events: ToolEvent[]): Candidate[] {
  const bySession = new Map<string, ToolEvent[]>();
  for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  const groups = new Map<string, Group>();
  let editWindows = 0;
  for (const [sessionId, seq] of bySession) {
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].kind !== "edit") continue;
      editWindows++;
      const seen = new Set<string>(); // a command counts once per window
      for (let j = i + 1; j <= i + TOOLMINE.RITUAL_WINDOW && j < seq.length; j++) {
        const e = seq[j];
        if (e.kind !== "bash" || !e.command) continue;
        const key = commandHead(e.command);
        if (!seen.has(key)) { seen.add(key); grow(groups, key, sessionId, key); }
      }
    }
  }
  return [...groups.entries()]
    .filter(([, g]) =>
      g.count >= TOOLMINE.RITUAL_MIN_OBS &&
      g.sessionIds.size >= TOOLMINE.RITUAL_MIN_SESSIONS &&
      editWindows > 0 && g.count / editWindows >= TOOLMINE.RITUAL_ATTACH_RATIO)
    .map(([k, g]) => toCandidate("ritual", k, g))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/toolmine.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/toolmine.ts cli/src/core/toolmine.test.ts
git commit -m "feat(core): toolmine — failure-loop and post-edit-ritual detectors"
```

---

### Task T4: Command hooks — matcher-aware settings, emit, apply, remove, review warning

**Files:**
- Modify: `cli/src/core/settings.ts`
- Modify: `cli/src/core/emit/hook.ts`, `cli/src/core/emit/index.ts`
- Modify: `cli/src/core/apply.ts`
- Modify: `cli/src/commands/remove.ts`
- Modify: `cli/src/commands/review.ts` (`readlinePrompter`)
- Test: `cli/src/core/settings.test.ts`, `cli/src/core/emit/emit.test.ts`, `cli/src/core/apply.test.ts` (append to each)

**Interfaces:**
- Consumes: widened hook payload + `ManifestEntry.hook` (T1).
- Produces:
  - `mergeHookIntoSettings(existing, event, command, opts: { timeout?: number; matcher?: string })` — matcher lands on the group: `{ matcher, hooks: [...] }`
  - `removeHookFromSettings(existing, event, command, matcher?: string)` — `matcher === undefined` keeps today's remove-from-all-groups behavior (autopilot callers unchanged)
  - `installHook(projectDir, event, command, opts)` / `removeHook(projectDir, event, command, matcher?)` pass-throughs
  - `EmitResult` hook variant: `{ kind: "hook"; settingsPatch?: string; install?: { event: string; matcher?: string; command: string } }`
  - `applySuggestion` installs `install` hooks (manifest `hook` field, `path` = settings path); subcommand hooks still print.

- [ ] **Step 1: Write the failing tests.**

Append to `cli/src/core/settings.test.ts`:

```ts
describe("matcher-aware hooks", () => {
  it("merge places matcher on the group and stays idempotent per (event, matcher, command)", () => {
    let s = mergeHookIntoSettings({}, "PostToolUse", "npm run lint", { matcher: "Edit|Write|NotebookEdit" });
    s = mergeHookIntoSettings(s, "PostToolUse", "npm run lint", { matcher: "Edit|Write|NotebookEdit" });
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
    expect(s.hooks.PostToolUse[0].hooks).toEqual([{ type: "command", command: "npm run lint" }]);
  });
  it("same command under a different matcher is a separate group", () => {
    let s = mergeHookIntoSettings({}, "PostToolUse", "npm run lint", { matcher: "Edit" });
    s = mergeHookIntoSettings(s, "PostToolUse", "npm run lint", { matcher: "Write" });
    expect(s.hooks.PostToolUse).toHaveLength(2);
  });
  it("remove with matcher only touches that group; without matcher removes everywhere (legacy)", () => {
    let s = mergeHookIntoSettings({}, "PostToolUse", "npm run lint", { matcher: "Edit" });
    s = mergeHookIntoSettings(s, "PostToolUse", "npm run lint", { matcher: "Write" });
    const afterOne = removeHookFromSettings(s, "PostToolUse", "npm run lint", "Edit");
    expect(afterOne.hooks.PostToolUse).toHaveLength(1);
    const afterAll = removeHookFromSettings(s, "PostToolUse", "npm run lint");
    expect(afterAll.hooks).toBeUndefined();
  });
});
```

Append to `cli/src/core/emit/emit.test.ts`:

```ts
const cmdHook = {
  id: "a1b2c3d4e5", name: "post-edit-lint", title: "t", rationale: "r",
  evidence: { count: 16, sessions: 3 }, confidence: "inferred",
  payload: { type: "hook", event: "PostToolUse", matcher: "Edit|Write|NotebookEdit",
             command: "npm run lint", description: "lint after edits" },
} as const;

it("emits an install descriptor for command hooks (no settingsPatch)", () => {
  const r = emit(cmdHook as any);
  expect(r).toEqual({ kind: "hook",
    install: { event: "PostToolUse", matcher: "Edit|Write|NotebookEdit", command: "npm run lint" } });
});
```

Append to `cli/src/core/apply.test.ts` (tmp-dir style used by the existing tests):

```ts
it("apply installs a command hook into settings and remove uninstalls it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grad-"));
  const applied = await applySuggestion(cmdHook as any, dir);
  expect(applied.written).toBe(join(dir, ".claude", "settings.json"));
  const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
  expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("npm run lint");
  const manifest = JSON.parse(await readFile(join(dir, ".gradient", "manifest.json"), "utf8"));
  expect(manifest.entries?.[0]?.hook ?? manifest[0]?.hook).toEqual(
    { event: "PostToolUse", matcher: "Edit|Write|NotebookEdit", command: "npm run lint" });

  const { remove } = await import("../commands/remove.js");
  expect(await remove(dir, "post-edit-lint")).toBe(true);
  const after = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
  expect(after.hooks).toBeUndefined();
  expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true); // settings.json itself is never deleted
});
```

(Match the manifest's actual shape when writing the assertion — check `core/manifest.ts` first.)

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/settings.test.ts src/core/emit/emit.test.ts src/core/apply.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement settings** — in `cli/src/core/settings.ts`:
  - `interface HookGroup { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }`
  - `mergeHookIntoSettings(existing, event, command, opts: { timeout?: number; matcher?: string } = {})`: idempotence check becomes `groups.some(g => g.matcher === opts.matcher && g.hooks?.some(h => h.command === command))`; the pushed group is `{ ...(opts.matcher !== undefined ? { matcher: opts.matcher } : {}), hooks: [hook] }`.
  - `removeHookFromSettings(existing, event, command, matcher?: string)`: when `matcher !== undefined`, only edit groups with `g.matcher === matcher`; otherwise current behavior.
  - `installHook` opts gains `matcher?: string` (pass through); `removeHook` gains trailing `matcher?: string`.

- [ ] **Step 4: Implement emit** — `cli/src/core/emit/hook.ts`: when `s.payload.command` is set, return `{ install: { event: s.payload.event, ...(s.payload.matcher !== undefined ? { matcher: s.payload.matcher } : {}), command: s.payload.command } }` (keep the `KNOWN_HOOK_EVENTS` check; `assertHookRunnable` already ignores command hooks after T1). Subcommand path unchanged. `emit/index.ts`: hook variant of `EmitResult` becomes `{ kind: "hook"; settingsPatch?: string; install?: { event: string; matcher?: string; command: string } }`.

- [ ] **Step 5: Implement apply + remove.**

`cli/src/core/apply.ts` — replace the final `else` branch:

```ts
} else {
  if (result.install) {
    written = await installHook(projectDir, result.install.event, result.install.command,
      { matcher: result.install.matcher });
    hook = result.install;
  } else {
    printed = result.settingsPatch; // gradient-subcommand hooks stay print-only
  }
}
```

with `let hook: ManifestEntry["hook"];` declared up top, `import { installHook } from "./settings.js";`, and the manifest entry gaining `...(hook ? { hook } : {})`.

`cli/src/commands/remove.ts` — before the file-deletion path: if the manifest entry has `hook`, call `removeHook(projectDir, entry.hook.event, entry.hook.command, entry.hook.matcher)` and drop the manifest entry; **never** unlink `entry.path` for hook entries (it points at settings.json).

- [ ] **Step 6: Review warning** — in `readlinePrompter` (`cli/src/commands/review.ts`), after the title line:

```ts
if (s.payload.type === "hook" && s.payload.command) {
  process.stdout.write(
    `  installs a ${s.payload.event} hook (matcher: ${s.payload.matcher ?? "all tools"})\n` +
    `  that runs automatically: ${s.payload.command}\n`,
  );
}
```

- [ ] **Step 7: Run all tests + typecheck**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS (existing autopilot/session-scan hook tests must be untouched — no-matcher behavior is unchanged).

- [ ] **Step 8: Commit**

```bash
git add cli/src/core/settings.ts cli/src/core/emit/ cli/src/core/apply.ts cli/src/commands/remove.ts cli/src/commands/review.ts cli/src/core/settings.test.ts cli/src/core/apply.test.ts
git commit -m "feat(core): command hooks install on apply and uninstall on remove (matcher-aware)"
```

---

### Task T5: Scan wiring + detect briefing

**Files:**
- Modify: `cli/src/commands/scan.ts`
- Modify: `cli/src/core/detect.ts`
- Test: `cli/src/commands/scan.test.ts`, `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: `parseToolEventsFile` (T2), `failureLoops`/`rituals` (T3), `Config.mineToolEvents` (T1).
- Produces: scan log lines `tool events: N (M dropped) → F failure loops, R rituals` and `tool-event candidates capped to K; D dropped`; detect briefing for `toolfail`/`ritual`.

- [ ] **Step 1: Write the failing tests.**

Append to `cli/src/commands/scan.test.ts` (reuse its existing injected-deps style):

```ts
import type { ToolEvent } from "../core/types.js";

it("mines tool events into candidates and logs the summary", async () => {
  const logs: string[] = [];
  const fail = (sessionId: string): ToolEvent =>
    ({ ts: "2026-07-01T00:00:00Z", sessionId, kind: "bash", command: "npm test", isError: true, errorHead: "FAIL" });
  const events = [fail("s1"), fail("s1"), fail("s2"), fail("s2")];
  await scan({ scope: "project", projectPath: dir }, {
    backend: null, config: {}, log: m => logs.push(m),
    collectFn: async () => ["f1"], parseFn: async () => [],
    parseToolEventsFn: async () => ({ events, dropped: 2 }),
  });
  expect(logs.some(l => l.includes("tool events: 4 (2 dropped) → 1 failure loops, 0 rituals"))).toBe(true);
});
it("skips the pass when mineToolEvents is false", async () => {
  const logs: string[] = [];
  let called = false;
  await scan({ scope: "project", projectPath: dir }, {
    backend: null, config: { mineToolEvents: false }, log: m => logs.push(m),
    collectFn: async () => ["f1"], parseFn: async () => [],
    parseToolEventsFn: async () => { called = true; return { events: [], dropped: 0 }; },
  });
  expect(called).toBe(false);
});
```

Append to `cli/src/core/detect.test.ts`:

```ts
it("degraded mode (no backend) skips toolfail/ritual candidates instead of faking commands", async () => {
  const cand = { kind: "toolfail", signature: "npm test", examples: ["FAIL a"],
    count: 4, sessions: 2, sessionIds: ["s1", "s2"], confidence: "inferred" } as const;
  const out = await detect([cand as any], null, { limit: 10 });
  expect(out).toEqual([]);
});
it("prompt briefing covers toolfail and ritual kinds and serializes kind", async () => {
  // Reuse the recording-fake-backend pattern already used in this test file:
  // a backend whose completion fn captures the prompt it receives and returns "[]".
  let seen = "";
  const backend = recordingBackend(prompt => { seen = prompt; return "[]"; });
  await detect([cand as any], backend, { limit: 10 });
  expect(seen).toContain("toolfail");           // candidate kind serialized
  expect(seen).toContain("kind 'ritual'");      // briefing text present
  expect(seen).toContain("PostToolUse");        // hook guidance present
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/scan.test.ts src/core/detect.test.ts`
Expected: FAIL — `parseToolEventsFn` is not a known dep; degraded mode currently emits a command suggestion for any candidate.

- [ ] **Step 3: Implement scan** — in `cli/src/commands/scan.ts`:
  - `ScanDeps` gains `parseToolEventsFn?: (path: string) => Promise<{ events: ToolEvent[]; dropped: number }>`.
  - Config is loaded *after* the file loop today — hoist `const config = deps.config ?? (await loadConfig(opts.home));` above the loop, then extend the loop:

```ts
const parseToolEventsFn = deps.parseToolEventsFn ?? parseToolEventsFile;
const events: ToolEvent[] = [];
let eventsDropped = 0;
for (const f of files) {
  turns.push(...(await parseFn(f)));
  if (config.mineToolEvents !== false) {
    const r = await parseToolEventsFn(f);
    events.push(...r.events);
    eventsDropped += r.dropped;
  }
}
```

  - After `const candidates = cluster(kept);` and the window line:

```ts
let toolCandidates: Candidate[] = [];
if (config.mineToolEvents !== false) {
  const fails = failureLoops(events);
  const rits = rituals(events);
  log(`tool events: ${events.length} (${eventsDropped} dropped) → ${fails.length} failure loops, ${rits.length} rituals`);
  toolCandidates = [...fails, ...rits].sort((a, b) => b.count - a.count);
  const cap = Math.ceil(window / 3);
  if (toolCandidates.length > cap) {
    log(`tool-event candidates capped to ${cap}; ${toolCandidates.length - cap} dropped`);
    toolCandidates = toolCandidates.slice(0, cap);
  }
}
const suggestions = await detect([...candidates, ...toolCandidates], backend, { …unchanged… });
```

- [ ] **Step 4: Implement detect** — in `cli/src/core/detect.ts`:
  - Degraded path (no backend): only fabricate exact-repeat command suggestions for candidates whose `kind` is `"command" | "unknown"`; skip `toolfail`/`ritual` (and any other kind) silently.
  - The prompt's candidate serialization must include each candidate's `kind`.
  - Append to the type-decision briefing (one authoritative block — replace, don't stack, per spec §10):

```
Candidates with kind 'toolfail' are commands that repeatedly failed inside sessions.
Produce {type:'command',…} describing a fix-it workflow ("run <cmd>; when it fails like the examples, do the fix") or a rule-like instruction — NEVER a hook for these.
Candidates with kind 'ritual' are commands repeatedly run right after file edits.
Default to {type:'hook',event:'PostToolUse',matcher:'Edit|Write|NotebookEdit',command:<the command>,description}; use {type:'command',…} instead when the command is plainly long-running (test suites, builds).
```

  (If Phase C landed first, `rule` is available — extend the toolfail line with `{type:'rule',…}` as the preferred form; Global Constraints note applies.)

- [ ] **Step 5: Run all tests + typecheck**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/scan.ts cli/src/core/detect.ts cli/src/commands/scan.test.ts cli/src/core/detect.test.ts
git commit -m "feat(scan): tool-event mining wired into the funnel; detect briefs toolfail/ritual"
```

---

### Task T6: End-to-end fixture + docs

**Files:**
- Test: `cli/src/commands/scan.test.ts` (append)
- Modify: `README.md`, `cli/README.md`

**Interfaces:** none new.

- [ ] **Step 1: End-to-end fixture test** — synthetic transcript lines (reuse T2's `use`/`result` helpers via a small local copy) with `npm test` failing 4× across 2 sessions and `npm run lint` following 16 of 20 edits across 3 sessions, fed through the real `parseToolEventsFile` via `parseFn`/`parseToolEventsFn` writing the lines to a temp file. Assert: exactly one `toolfail` and one `ritual` candidate reach `detect` (inject a recording fake backend to capture its input).

- [ ] **Step 2: Run to verify, then make it pass** (wiring bugs surface here).

Run: `cd cli && npx vitest run src/commands/scan.test.ts`
Expected: PASS (after fixing whatever it finds).

- [ ] **Step 3: Docs.**
  - `README.md`: "Clustering is local and LLM-free" paragraph — extend: prompts *and tool activity* are mined locally; only command heads and redacted first error lines can reach a model.
  - `cli/README.md` "How it works" step 1–2: mention tool events (failures, post-edit rituals) alongside repeated prompts; document `mineToolEvents: false` as the off switch.

- [ ] **Step 4: Full run + commit**

Run: `cd cli && npm test && npm run typecheck`

```bash
git add cli/src/commands/scan.test.ts README.md cli/README.md
git commit -m "test(scan): tool-mining end-to-end fixture; docs: tool-activity wording"
```
