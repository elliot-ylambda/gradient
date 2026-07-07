# gradient Autopilot (Personalized Auto-Responder) Implementation Plan

> **Amended 2026-07-03:** the playbook artifact was renamed to `gradient.md`
> and gained a per-project layer. See
> [`2026-07-01-gradient-md-design.md`](../specs/2026-07-01-gradient-md-design.md).
> References to `playbook.md` below are preserved as the original record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `gradient autopilot` — an opt-in Stop-hook auto-responder that nudges Claude Code with the user's own mined phrasings when work is unfinished, per `docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md`.

**Architecture:** A `Stop` hook runs `gradient respond`: four free local gates (recursion / mode / budget / progress), then one fast-model LLM judge call over a redacted transcript tail + a scan-generated editable playbook. `gradient autopilot <off|nudge|full>` manages config + hook install. Fail-open everywhere: any error → the stop stands.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

Copied from the spec — every task implicitly includes these:

- **Fail-open (spec §6):** `gradient respond` never exits non-zero, never writes to stderr on any failure path, and prints nothing on stdout unless blocking the stop. Every error → the stop stands.
- **Hook rule (spec §2 #7):** the installed hook command is exactly `gradient respond`, event `Stop`, with `timeout: 60` in the hook entry.
- **Config keys (spec §3.1):** `autopilot?: "off" | "nudge" | "full"`, `autopilotBudget?: number` (default **10**), `autopilotModel?: string` (default **"haiku"**).
- **Recursion guard (spec §3.2):** env var name is exactly `GRADIENT_AUTOPILOT_CHILD`; the claude-cli judge child also runs with `cwd` = OS temp dir.
- **Judge (spec §3.2):** at most ONE LLM call per stop; internal timeout **45000 ms**; response schema `{action: "continue"|"stand_down", response?, why}`; `response` cap **2000** chars, `why` cap **500** chars; oversized/malformed → fail-open.
- **Tail (spec §3.2, resolves spec §11):** last **30** turns, **8000** chars max; redacted with `redact()` from `core/security.ts` before the LLM call.
- **Fingerprint (spec §3.2, resolves spec §11):** tool-activity only — `tools:<count of tool_use blocks>`. (A line-count component would advance on every assistant reply and permanently disable the progress gate.)
- **Playbook markers (spec §3.3):** exactly `<!-- gradient:mined:start -->` and `<!-- gradient:mined:end -->`; regeneration replaces only the region between them; markers missing → file left untouched.
- **State (spec §3.4):** `~/.config/gradient/state/<session_id>.json`; log ring-buffered to last **20**; files older than **7 days** cleaned opportunistically; corrupt state → treated as fresh.
- **Scoping (spec §3.1):** mode is user-global (config), hook is per-project (`.claude/settings.json`).
- **Do NOT add `respond` to `KNOWN_SUBCOMMANDS`** in `core/validate.ts` — the LLM must not be able to emit an autopilot hook suggestion; the dedicated command is the only install path.
- Tests: vitest with injected deps, no network, no real `claude`. Run from `cli/`: `npm test`, `npm run typecheck`.
- Work happens on the existing `spec/auto-responder` branch (already checked out; spec committed).

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `Config` autopilot keys; `SessionState` + `AutopilotLogEntry` |
| `cli/src/core/settings.ts` (modify) | hook `timeout` support; `removeHookFromSettings` / `removeHook` / `hookInstalled` |
| `cli/src/llm/claudeCli.ts` (modify) | `spawnCwd` / `extraEnv` spawn options |
| `cli/src/core/tail.ts` (create) | transcript → compact tail rendering; progress fingerprint; `readTranscriptLines` |
| `cli/src/core/state.ts` (create) | session-state load/save/cleanup/latest |
| `cli/src/core/playbook.ts` (create) | playbook generate/write/load; `isNudge` |
| `cli/src/commands/scan.ts` (modify) | write playbook after caching suggestions |
| `cli/src/core/judge.ts` (create) | judge prompt build, strict response parse, timed LLM call |
| `cli/src/commands/respond.ts` (create) | gates → judge orchestration (the hook target) |
| `cli/src/commands/autopilot.ts` (create) | `setAutopilotMode`, `autopilotStatus` |
| `cli/src/config.ts` (modify) | `DEFAULT_AUTOPILOT_BUDGET`, `DEFAULT_AUTOPILOT_MODEL` |
| `cli/src/cli.ts` (modify) | HELP + `autopilot`/`respond` dispatch; generalize `readStdinJson` |
| `cli/src/commands/review.ts` (modify) | nudge hint line in prompter |
| `cli/src/core/parse.ts` (modify) | stale "phase 2" comment rewrite (spec §9) |
| `README.md` (modify) | autopilot section + trust-copy honesty fix |

---

### Task 1: Config keys, SessionState type, settings hook removal + timeout

**Files:**
- Modify: `cli/src/core/types.ts`
- Modify: `cli/src/core/settings.ts`
- Modify: `cli/src/config.ts`
- Test: `cli/src/core/settings.test.ts` (append), `cli/src/core/types.test.ts` (append)

**Interfaces:**
- Consumes: existing `mergeHookIntoSettings`, `installHook`, `settingsPath`, `assertInside`.
- Produces (later tasks rely on these exact names):
  - `type AutopilotMode = "off" | "nudge" | "full"` (single source of truth in `types.ts`)
  - `Config.autopilot?: AutopilotMode`, `Config.autopilotBudget?: number`, `Config.autopilotModel?: string`
  - `interface AutopilotLogEntry { ts: string; action: "continue" | "stand_down"; why: string; excerpt: string }`
  - `interface SessionState { count: number; lastFingerprint: string; stoodDown: boolean; log: AutopilotLogEntry[] }`
  - `mergeHookIntoSettings(existing, event, command, opts?: { timeout?: number })`
  - `installHook(projectDir, event, command, opts?: { timeout?: number }): Promise<string>`
  - `removeHookFromSettings(existing: Record<string, any>, event: string, command: string): Record<string, any>`
  - `removeHook(projectDir: string, event: string, command: string): Promise<string>` (missing file → no-op; unreadable/corrupt → throw)
  - `hookInstalled(projectDir: string, event: string, command: string): Promise<boolean>`
  - `config.ts`: `export const DEFAULT_AUTOPILOT_BUDGET = 10;` and `export const DEFAULT_AUTOPILOT_MODEL = "haiku";`

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/settings.test.ts`:

```ts
import { removeHookFromSettings, removeHook, hookInstalled } from "./settings.js";
// (merge with the file's existing imports: mergeHookIntoSettings, installHook, etc.)

describe("hook timeout option", () => {
  it("adds timeout to the hook entry when given", () => {
    const out = mergeHookIntoSettings({}, "Stop", "gradient respond", { timeout: 60 });
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "gradient respond", timeout: 60 });
  });

  it("omits timeout when not given (existing behavior unchanged)", () => {
    const out = mergeHookIntoSettings({}, "Stop", "gradient respond");
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "gradient respond" });
  });
});

describe("removeHookFromSettings", () => {
  it("removes the matching hook and drops empty groups and events", () => {
    const withHook = mergeHookIntoSettings({}, "Stop", "gradient respond");
    const out = removeHookFromSettings(withHook, "Stop", "gradient respond");
    expect(out.hooks).toBeUndefined();
  });

  it("preserves unrelated hooks in the same event", () => {
    let s = mergeHookIntoSettings({}, "Stop", "gradient respond");
    s = mergeHookIntoSettings(s, "Stop", "other-tool run");
    const out = removeHookFromSettings(s, "Stop", "gradient respond");
    expect(JSON.stringify(out)).toContain("other-tool run");
    expect(JSON.stringify(out)).not.toContain("gradient respond");
  });

  it("preserves other events and non-hook settings keys", () => {
    const s = mergeHookIntoSettings({ model: "opus" }, "SessionStart", "gradient scan --detach");
    const out = removeHookFromSettings(s, "Stop", "gradient respond");
    expect(out.model).toBe("opus");
    expect(out.hooks.SessionStart).toHaveLength(1);
  });
});

describe("removeHook / hookInstalled (fs round-trip)", () => {
  it("removeHook is a no-op when settings.json does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    await expect(removeHook(dir, "Stop", "gradient respond")).resolves.toContain("settings.json");
  });

  it("removeHook refuses to touch a corrupt settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{ not json");
    await expect(removeHook(dir, "Stop", "gradient respond")).rejects.toThrow(/refusing/);
  });

  it("hookInstalled reflects install → remove round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(false);
    await installHook(dir, "Stop", "gradient respond", { timeout: 60 });
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(true);
    await removeHook(dir, "Stop", "gradient respond");
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(false);
  });
});
```

(Reuse the file's existing imports for `mkdtemp`, `tmpdir`, `join`, `mkdir`, `writeFile` — add any that are missing from `node:fs/promises` / `node:os` / `node:path`.)

Append to `cli/src/core/types.test.ts` (this file exists; follow its pattern of compile-level shape checks):

```ts
import type { SessionState, AutopilotLogEntry, Config } from "./types.js";

describe("autopilot types", () => {
  it("SessionState and Config autopilot keys compile with expected shapes", () => {
    const entry: AutopilotLogEntry = { ts: "2026-07-01T00:00:00Z", action: "continue", why: "unfinished", excerpt: "keep going" };
    const s: SessionState = { count: 1, lastFingerprint: "tools:3", stoodDown: false, log: [entry] };
    const c: Config = { autopilot: "nudge", autopilotBudget: 10, autopilotModel: "haiku" };
    expect(s.log[0].action).toBe("continue");
    expect(c.autopilot).toBe("nudge");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/ellioteckholm/projects/gradient/cli && npx vitest run src/core/settings.test.ts src/core/types.test.ts`
Expected: FAIL — `removeHookFromSettings` / `removeHook` / `hookInstalled` not exported; type errors on `autopilot` keys.

- [ ] **Step 3: Implement**

In `cli/src/core/types.ts`, extend `Config` (after `scanOnSessionStart`):

```ts
  /** Auto-responder mode. Absent = off. Mode is user-global; the Stop hook is per-project. */
  autopilot?: AutopilotMode;
  /** Max auto-responses per session. Defaults to 10. */
  autopilotBudget?: number;
  /** Judge model (fast by design; the judge sits in the user's stop path). Defaults to "haiku". */
  autopilotModel?: string;
```

And append at the end of `types.ts`:

```ts
/** Autopilot authority ladder (spec §2 #1). */
export type AutopilotMode = "off" | "nudge" | "full";

/** One autopilot decision, kept for `gradient autopilot status`. */
export interface AutopilotLogEntry {
  ts: string;
  action: "continue" | "stand_down";
  why: string;
  excerpt: string;
}

/** Per-session autopilot state (~/.config/gradient/state/<session_id>.json). */
export interface SessionState {
  count: number;           // auto-responses sent this session
  lastFingerprint: string; // tool-activity fingerprint at our last decision
  stoodDown: boolean;      // latched when a nudge produced no progress
  log: AutopilotLogEntry[];
}
```

In `cli/src/config.ts`, append:

```ts
export const DEFAULT_AUTOPILOT_BUDGET = 10;
export const DEFAULT_AUTOPILOT_MODEL = "haiku";
```

In `cli/src/core/settings.ts`, replace `mergeHookIntoSettings` and `installHook`, and add the new functions:

```ts
export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  opts: { timeout?: number } = {},
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
  const already = groups.some(g => g.hooks?.some(h => h.command === command));
  if (!already) {
    const hook: { type: string; command: string; timeout?: number } = { type: "command", command };
    if (opts.timeout !== undefined) hook.timeout = opts.timeout;
    groups.push({ hooks: [hook] });
  }
  out.hooks[event] = groups;
  return out;
}

export function removeHookFromSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
  const kept = groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => h.command !== command) }))
    .filter(g => g.hooks.length > 0);
  if (kept.length > 0) out.hooks[event] = kept;
  else delete out.hooks[event];
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export async function installHook(
  projectDir: string,
  event: string,
  command: string,
  opts: { timeout?: number } = {},
): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
    }
    // ENOENT → no existing settings; start fresh
  }
  const merged = mergeHookIntoSettings(existing, event, command, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}

/** Remove a hook. Missing file → no-op; unreadable/corrupt → throw (never overwrite what we can't read). */
export async function removeHook(projectDir: string, event: string, command: string): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path; // nothing to remove
    throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
  }
  const merged = removeHookFromSettings(existing, event, command);
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}

export async function hookInstalled(projectDir: string, event: string, command: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(projectDir), "utf8"));
    const groups: HookGroup[] = Array.isArray(parsed?.hooks?.[event]) ? parsed.hooks[event] : [];
    return groups.some(g => g.hooks?.some(h => h.command === command));
  } catch {
    return false;
  }
}
```

(Note: `JSON.parse` on corrupt content throws `SyntaxError`, which has no `.code`, so it lands in the refuse branch — same semantics as the existing `installHook`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/settings.test.ts src/core/types.test.ts`
Expected: PASS (all, including pre-existing tests — the `init.test.ts` callers of `installHook` are unaffected by the new optional param; run `npx vitest run src/commands/init.test.ts` too).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/settings.ts cli/src/config.ts cli/src/core/settings.test.ts cli/src/core/types.test.ts
git commit -m "feat(core): autopilot config/state types + hook removal & timeout support"
```

---

### Task 2: ClaudeCliBackend spawn options (recursion guard plumbing)

**Files:**
- Modify: `cli/src/llm/claudeCli.ts`
- Test: `cli/src/llm/claudeCli.test.ts` (append)

**Interfaces:**
- Produces:
  - `type RunFn = (cmd: string, args: string[], input: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<RunResult>`
  - `new ClaudeCliBackend({ model?, runFn?, whichFn?, spawnCwd?: string, extraEnv?: Record<string, string> })`
  - `complete()` passes `{ cwd: spawnCwd, env: { ...process.env, ...extraEnv } }` to the run function (env only when `extraEnv` is set).

- [ ] **Step 1: Write the failing test**

Append to `cli/src/llm/claudeCli.test.ts`:

```ts
describe("spawn options", () => {
  it("threads spawnCwd and extraEnv through to the run function", async () => {
    let captured: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const backend = new ClaudeCliBackend({
      runFn: async (_cmd, _args, _input, opts) => {
        captured = opts;
        return { code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" };
      },
      spawnCwd: "/tmp/neutral",
      extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" },
    });
    await backend.complete({ system: "s", prompt: "p" });
    expect(captured?.cwd).toBe("/tmp/neutral");
    expect(captured?.env?.GRADIENT_AUTOPILOT_CHILD).toBe("1");
    expect(captured?.env?.PATH).toBe(process.env.PATH); // parent env preserved
  });

  it("passes no env override when extraEnv is not set", async () => {
    let captured: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const backend = new ClaudeCliBackend({
      runFn: async (_cmd, _args, _input, opts) => {
        captured = opts;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await backend.complete({ system: "s", prompt: "p" });
    expect(captured?.env).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/claudeCli.test.ts`
Expected: FAIL — constructor rejects `spawnCwd`/`extraEnv`; `opts` param is undefined.

- [ ] **Step 3: Implement**

In `cli/src/llm/claudeCli.ts`:

Change the `RunFn` type and `defaultRun`:

```ts
type RunFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

const defaultRun: RunFn = (cmd, args, input, opts) =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts?.cwd, env: opts?.env });
    // ... (rest of the existing body unchanged)
  });
```

Extend the class:

```ts
export class ClaudeCliBackend implements LLMBackend {
  name = "claude-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;
  private spawnCwd?: string;
  private extraEnv?: Record<string, string>;

  constructor(
    deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string; spawnCwd?: string; extraEnv?: Record<string, string> } = {},
  ) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
    this.spawnCwd = deps.spawnCwd;
    this.extraEnv = deps.extraEnv;
  }
  // available() unchanged

  async complete(req: LLMRequest): Promise<string> {
    const args = ["-p", req.prompt, "--output-format", "json", "--append-system-prompt", req.system];
    if (this.model) args.push("--model", this.model);
    const opts = {
      cwd: this.spawnCwd,
      env: this.extraEnv ? { ...process.env, ...this.extraEnv } : undefined,
    };
    const { code, stdout, stderr } = await this.runFn("claude", args, "", opts);
    // ... (rest unchanged)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/llm/claudeCli.test.ts src/llm/index.test.ts`
Expected: PASS (existing 3-param injected runFns remain assignable — extra params are optional).

- [ ] **Step 5: Commit**

```bash
git add cli/src/llm/claudeCli.ts cli/src/llm/claudeCli.test.ts
git commit -m "feat(llm): claude-cli spawn cwd/env options for autopilot recursion guard"
```

---

### Task 3: `core/tail.ts` — transcript tail rendering + progress fingerprint

**Files:**
- Create: `cli/src/core/tail.ts`
- Test: `cli/src/core/tail.test.ts`

**Interfaces:**
- Produces:
  - `TAIL_MAX_TURNS = 30`, `TAIL_MAX_CHARS = 8000`
  - `renderTail(lines: string[], opts?: { maxTurns?: number; maxChars?: number }): string`
  - `fingerprint(lines: string[]): string` — `` `tools:${toolUseCount}` ``
  - `readTranscriptLines(path: string): Promise<string[]>`
- Transcript JSONL shapes consumed (same raw format `parse.ts` reads): `{type: "user"|"assistant", isSidechain?, message: {content: string | Array<{type: "text", text} | {type: "tool_use", name} | {type: "tool_result", ...}>}}`.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/tail.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTail, fingerprint } from "./tail.js";

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistant = (blocks: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string) => ({ type: "tool_use", name, id: "x", input: {} });

describe("renderTail", () => {
  it("renders user and assistant turns with a tool-activity summary", () => {
    const lines = [
      user("fix the parser"),
      assistant([text("On it."), tool("Edit"), tool("Edit"), tool("Bash")]),
      assistant([text("Done — tests pass.")]),
    ];
    const out = renderTail(lines);
    expect(out).toBe(
      "user: fix the parser\n" +
      "assistant: On it. [3 tool calls: Edit ×2, Bash]\n" +
      "assistant: Done — tests pass.",
    );
  });

  it("skips sidechains, tool_result-only user messages, and unparseable lines", () => {
    const lines = [
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "hidden" } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "raw output" }] } }),
      "not json at all",
      user("real prompt"),
    ];
    const out = renderTail(lines);
    expect(out).toBe("user: real prompt");
  });

  it("keeps only the last maxTurns turns and caps total chars from the end", () => {
    const lines = Array.from({ length: 40 }, (_, i) => user(`prompt ${i}`));
    const out = renderTail(lines, { maxTurns: 5 });
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("prompt 39");
    expect(out).not.toContain("prompt 34\n");
    const capped = renderTail(lines, { maxTurns: 40, maxChars: 50 });
    expect(capped.length).toBeLessThanOrEqual(50);
    expect(capped.endsWith("prompt 39")).toBe(true); // the END of the tail survives
  });
});

describe("fingerprint", () => {
  it("counts tool_use blocks only — text growth does not advance it", () => {
    const base = [user("go"), assistant([text("working"), tool("Bash")])];
    const moreTextOnly = [...base, assistant([text("still just talking")])];
    const moreTools = [...base, assistant([tool("Edit")])];
    expect(fingerprint(base)).toBe("tools:1");
    expect(fingerprint(moreTextOnly)).toBe("tools:1"); // no progress
    expect(fingerprint(moreTools)).toBe("tools:2");    // progress
  });

  it("ignores sidechain assistant turns and junk lines", () => {
    const lines = [
      JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [tool("Edit")] } }),
      "garbage",
      assistant([tool("Bash")]),
    ];
    expect(fingerprint(lines)).toBe("tools:1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/tail.test.ts`
Expected: FAIL — module `./tail.js` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/core/tail.ts`:

```ts
import { readFile } from "node:fs/promises";

// The autopilot judge's view of a session: a compact, capped rendering of the
// transcript's last turns, plus a tool-activity fingerprint for the progress
// gate. Deliberately separate from parse.ts, whose user-prompts-only contract
// serves the mining pipeline.

export const TAIL_MAX_TURNS = 30;
export const TAIL_MAX_CHARS = 8000;

interface RawBlock { type?: string; text?: string; name?: string }
interface RawLine {
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | RawBlock[] };
}

function parseLine(line: string): RawLine | null {
  try {
    return JSON.parse(line) as RawLine;
  } catch {
    return null;
  }
}

function summarizeTools(tools: RawBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name ?? "?", (counts.get(t.name ?? "?") ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

export function renderTail(
  lines: string[],
  opts: { maxTurns?: number; maxChars?: number } = {},
): string {
  const maxTurns = opts.maxTurns ?? TAIL_MAX_TURNS;
  const maxChars = opts.maxChars ?? TAIL_MAX_CHARS;
  const turns: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const raw = parseLine(line);
    if (!raw || raw.isSidechain) continue;
    const content = raw.message?.content;
    if (raw.type === "user") {
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ");
      }
      if (text.trim()) turns.push(`user: ${text.trim()}`);
    } else if (raw.type === "assistant" && Array.isArray(content)) {
      const text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ").trim();
      const tools = content.filter(b => b.type === "tool_use");
      const toolNote = tools.length
        ? `${text ? " " : ""}[${tools.length} tool call${tools.length === 1 ? "" : "s"}: ${summarizeTools(tools)}]`
        : "";
      if (text || toolNote) turns.push(`assistant: ${text}${toolNote}`);
    }
  }
  const joined = turns.slice(-maxTurns).join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/**
 * Progress fingerprint: tool activity ONLY. Text always grows between stops
 * (every reply adds lines), so any text/line component would make "no
 * progress" undetectable. No new tool calls since our last nudge = no real
 * work = stand down (spec §3.2).
 */
export function fingerprint(lines: string[]): string {
  let toolUses = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const raw = parseLine(line);
    if (!raw || raw.isSidechain || raw.type !== "assistant") continue;
    const content = raw.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === "tool_use") toolUses++;
  }
  return `tools:${toolUses}`;
}

export async function readTranscriptLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/tail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/tail.ts cli/src/core/tail.test.ts
git commit -m "feat(core): transcript tail rendering + tool-activity fingerprint for autopilot"
```

---

### Task 4: `core/state.ts` — session state

**Files:**
- Create: `cli/src/core/state.ts`
- Test: `cli/src/core/state.test.ts`

**Interfaces:**
- Consumes: `SessionState` from Task 1.
- Produces:
  - `stateDir(home?: string): string` → `<home>/.config/gradient/state`
  - `freshState(): SessionState`
  - `loadState(sessionId: string, home?: string): Promise<SessionState>` (missing/corrupt → fresh)
  - `saveState(sessionId: string, s: SessionState, home?: string): Promise<void>` (log capped to last 20)
  - `cleanupStale(home?: string, now?: number): Promise<void>` (mtime > 7 days → delete; all errors swallowed)
  - `latestState(home?: string): Promise<{ sessionId: string; state: SessionState } | null>` (newest by mtime)

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, cleanupStale, latestState, stateDir, freshState } from "./state.js";
import type { SessionState } from "./types.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "grad-home-"));

describe("session state", () => {
  it("returns fresh state for a missing file", async () => {
    const home = await tmpHome();
    expect(await loadState("s1", home)).toEqual({ count: 0, lastFingerprint: "", stoodDown: false, log: [] });
  });

  it("returns fresh state for a corrupt file (bounded worst case: budget restarts)", async () => {
    const home = await tmpHome();
    await mkdir(stateDir(home), { recursive: true });
    await writeFile(join(stateDir(home), "s1.json"), "{ nope");
    expect(await loadState("s1", home)).toEqual(freshState());
  });

  it("round-trips state and caps the log at 20 entries", async () => {
    const home = await tmpHome();
    const s: SessionState = {
      count: 3,
      lastFingerprint: "tools:7",
      stoodDown: false,
      log: Array.from({ length: 25 }, (_, i) => ({ ts: `t${i}`, action: "continue" as const, why: "w", excerpt: "e" })),
    };
    await saveState("s1", s, home);
    const back = await loadState("s1", home);
    expect(back.count).toBe(3);
    expect(back.log).toHaveLength(20);
    expect(back.log[19].ts).toBe("t24"); // newest kept
  });

  it("sanitizes hostile session ids into safe filenames", async () => {
    const home = await tmpHome();
    await saveState("../../evil", freshState(), home);
    const files = await readdir(stateDir(home));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("cleanupStale removes only files older than 7 days", async () => {
    const home = await tmpHome();
    await saveState("old", freshState(), home);
    await saveState("new", freshState(), home);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await utimes(join(stateDir(home), "old.json"), old, old);
    await cleanupStale(home);
    const files = await readdir(stateDir(home));
    expect(files).toEqual(["new.json"]);
  });

  it("cleanupStale swallows a missing state dir", async () => {
    const home = await tmpHome();
    await expect(cleanupStale(home)).resolves.toBeUndefined();
  });

  it("latestState returns the newest session by mtime, null when none", async () => {
    const home = await tmpHome();
    expect(await latestState(home)).toBeNull();
    await saveState("a", { ...freshState(), count: 1 }, home);
    await saveState("b", { ...freshState(), count: 2 }, home);
    const past = new Date(Date.now() - 3600 * 1000);
    await utimes(join(stateDir(home), "a.json"), past, past);
    const latest = await latestState(home);
    expect(latest?.sessionId).toBe("b");
    expect(latest?.state.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/state.test.ts`
Expected: FAIL — module `./state.js` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/core/state.ts`:

```ts
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionState } from "./types.js";

const LOG_CAP = 20;
const STALE_MS = 7 * 24 * 3600 * 1000;

export function stateDir(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "state");
}

export function freshState(): SessionState {
  return { count: 0, lastFingerprint: "", stoodDown: false, log: [] };
}

function fileFor(sessionId: string, home?: string): string {
  // session ids are UUIDs in practice; sanitize defensively so a hostile id
  // can never escape the state dir.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(home), `${safe}.json`);
}

export async function loadState(sessionId: string, home?: string): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(fileFor(sessionId, home), "utf8")) as SessionState;
    if (typeof raw?.count !== "number" || !Array.isArray(raw.log)) return freshState();
    return { ...freshState(), ...raw };
  } catch {
    return freshState(); // missing or corrupt → fresh; worst case the budget restarts, still bounded
  }
}

export async function saveState(sessionId: string, s: SessionState, home?: string): Promise<void> {
  await mkdir(stateDir(home), { recursive: true });
  const capped: SessionState = { ...s, log: s.log.slice(-LOG_CAP) };
  await writeFile(fileFor(sessionId, home), JSON.stringify(capped, null, 2));
}

/** Delete state files older than 7 days. Best-effort: every error is swallowed. */
export async function cleanupStale(home?: string, now: number = Date.now()): Promise<void> {
  try {
    const dir = stateDir(home);
    for (const f of await readdir(dir)) {
      try {
        const st = await stat(join(dir, f));
        if (now - st.mtimeMs > STALE_MS) await unlink(join(dir, f));
      } catch {
        // ignore per-file races
      }
    }
  } catch {
    // no state dir yet — nothing to clean
  }
}

/** Newest session state by mtime, for `gradient autopilot status`. */
export async function latestState(home?: string): Promise<{ sessionId: string; state: SessionState } | null> {
  try {
    const dir = stateDir(home);
    let best: { sessionId: string; mtime: number } | null = null;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const st = await stat(join(dir, f));
      if (!best || st.mtimeMs > best.mtime) best = { sessionId: f.slice(0, -5), mtime: st.mtimeMs };
    }
    if (!best) return null;
    return { sessionId: best.sessionId, state: await loadState(best.sessionId, home) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/state.ts cli/src/core/state.test.ts
git commit -m "feat(core): autopilot session state (budget, fingerprint, decision log)"
```

---

### Task 5: `core/playbook.ts` + scan integration

**Files:**
- Create: `cli/src/core/playbook.ts`
- Modify: `cli/src/commands/scan.ts` (playbook write after suggestions cache)
- Test: `cli/src/core/playbook.test.ts`, `cli/src/commands/scan.test.ts` (append)

**Interfaces:**
- Consumes: `Suggestion` from `core/types.ts`.
- Produces:
  - `MINED_START = "<!-- gradient:mined:start -->"`, `MINED_END = "<!-- gradient:mined:end -->"`
  - `DEFAULT_PLAYBOOK: string`
  - `playbookPath(home?: string): string` → `<home>/.config/gradient/playbook.md`
  - `isNudge(s: Suggestion): boolean` — loop payload without `cadence` (exactly what "How I nudge" mines; also drives the Task 9 display hint)
  - `renderMinedSection(suggestions: Suggestion[]): string`
  - `generatePlaybook(suggestions: Suggestion[], existing?: string): string | null` — `null` when markers are missing from `existing` (user's file, user's rules — leave untouched)
  - `writePlaybook(suggestions: Suggestion[], home?: string): Promise<string | null>`
  - `loadPlaybook(home?: string): Promise<string>` — `DEFAULT_PLAYBOOK` when missing/unreadable

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/playbook.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  generatePlaybook, writePlaybook, loadPlaybook, playbookPath,
  isNudge, DEFAULT_PLAYBOOK, MINED_START, MINED_END,
} from "./playbook.js";
import type { Suggestion } from "./types.js";

const sugg = (over: Partial<Suggestion> & { payload: Suggestion["payload"] }): Suggestion => ({
  id: "id1", name: "continue-loop", title: "Keep going until done",
  rationale: "r", evidence: { count: 150, sessions: 44 }, confidence: "high",
  ...over,
});

const nudge = sugg({ payload: { type: "loop", instruction: "continue until actually done" } });
const scheduled = sugg({ name: "daily-triage", payload: { type: "loop", instruction: "triage issues", cadence: "0 9 * * *" } });
const command = sugg({ id: "id2", name: "ship", title: "Push, open a PR, review it", payload: { type: "command", commandName: "ship", body: "b" } });

describe("isNudge", () => {
  it("is true only for cadence-less loop suggestions", () => {
    expect(isNudge(nudge)).toBe(true);
    expect(isNudge(scheduled)).toBe(false);
    expect(isNudge(command)).toBe(false);
  });
});

describe("generatePlaybook", () => {
  it("fills the mined region of the default template", () => {
    const out = generatePlaybook([nudge, scheduled, command]);
    expect(out).toContain('- "continue until actually done" (seen 150× · 44 sessions)');
    expect(out).toContain("- /ship — Push, open a PR, review it");
    expect(out).not.toContain("triage issues"); // scheduled loops are not nudges
    expect(out).toContain("## Rules"); // default rules preserved
  });

  it("replaces ONLY the mined region, preserving user edits outside it", () => {
    const existing = DEFAULT_PLAYBOOK.replace(
      "- Prefer standing down over guessing.",
      "- Prefer standing down over guessing.\n- MY CUSTOM RULE: never touch prod.",
    );
    const out = generatePlaybook([nudge], existing);
    expect(out).toContain("MY CUSTOM RULE: never touch prod.");
    expect(out).toContain('"continue until actually done"');
  });

  it("returns null when the user removed the markers", () => {
    expect(generatePlaybook([nudge], "# my own playbook, no markers")).toBeNull();
  });

  it("regeneration is idempotent (second run replaces the first mined region)", () => {
    const once = generatePlaybook([nudge])!;
    const twice = generatePlaybook([command], once)!;
    expect(twice).not.toContain("continue until actually done");
    expect(twice).toContain("- /ship — Push, open a PR, review it");
    expect(twice.match(new RegExp(MINED_START, "g"))).toHaveLength(1);
  });
});

describe("writePlaybook / loadPlaybook", () => {
  it("writes to ~/.config/gradient/playbook.md and loads it back", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = await writePlaybook([nudge], home);
    expect(path).toBe(playbookPath(home));
    expect(await loadPlaybook(home)).toContain("continue until actually done");
  });

  it("leaves a marker-less user file untouched and returns null", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await mkdir(dirname(playbookPath(home)), { recursive: true });
    await writeFile(playbookPath(home), "all mine now");
    expect(await writePlaybook([nudge], home)).toBeNull();
    expect(await readFile(playbookPath(home), "utf8")).toBe("all mine now");
  });

  it("falls back to DEFAULT_PLAYBOOK when no file exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    expect(await loadPlaybook(home)).toBe(DEFAULT_PLAYBOOK);
  });
});
```

Changes to `cli/src/commands/scan.test.ts`:

**(a) IMPORTANT — stop the suite writing the real `~/.config/gradient/playbook.md`:** the three existing tests call `scan()` without `home`, so once scan writes the playbook they would mutate the developer's real home directory. In EACH of the three existing tests, create a tmp home and pass it through `ScanOptions`:

```ts
const home = await mkdtemp(join(tmpdir(), "grad-home-"));
// ...and add `home` to the scan options object, e.g.:
await scan({ scope: "all", projectPath: process.cwd(), home }, { ...deps });
```

**(b) Append the new test** (add `import { playbookPath, MINED_START } from "../core/playbook.js";` to the imports):

```ts
it("writes the playbook after caching suggestions", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
  const home = await mkdtemp(join(tmpdir(), "grad-home-"));
  const fakeBackend = {
    name: "fake", available: async () => true,
    complete: async () => JSON.stringify({ suggestions: [{
      sourceSignatures: ["continue until actually done"],
      name: "keep-going", title: "Keep going", rationale: "r", confidence: "high",
      payload: { type: "loop", instruction: "continue until actually done" },
    }] }),
  };
  await scan(
    { scope: "project", projectPath: projectDir, home },
    {
      backend: fakeBackend,
      collectFn: async () => ["fake.jsonl"],
      parseFn: async () =>
        Array.from({ length: 3 }, (_, i) => ({
          ts: "t", project: "x", role: "user" as const,
          text: "continue until actually done", sessionId: `s${i}`,
        })),
    },
  );
  const pb = await readFile(playbookPath(home), "utf8");
  expect(pb).toContain(MINED_START);
  expect(pb).toContain('"continue until actually done" (seen 3× · 3 sessions)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/playbook.test.ts src/commands/scan.test.ts`
Expected: FAIL — module `./playbook.js` does not exist.

- [ ] **Step 3: Implement `core/playbook.ts`**

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Suggestion } from "./types.js";

export const MINED_START = "<!-- gradient:mined:start -->";
export const MINED_END = "<!-- gradient:mined:end -->";

export const DEFAULT_PLAYBOOK = `# gradient autopilot playbook

The Rules section is yours — edit freely. \`gradient scan\` refreshes only the
region between the mined markers.

${MINED_START}
_(run \`gradient scan\` to mine your habits into this section)_
${MINED_END}

## Rules

- Never green-light irreversible or destructive actions (pushes, deploys, deletions, spending).
- Stand down when a decision needs my judgment.
- Prefer standing down over guessing.
`;

export function playbookPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "playbook.md");
}

/** A nudge is a cadence-less loop suggestion — "continue"-style, not scheduled. */
export function isNudge(s: Suggestion): boolean {
  return s.payload.type === "loop" && !s.payload.cadence;
}

export function renderMinedSection(suggestions: Suggestion[]): string {
  const nudgeLines = suggestions
    .filter(isNudge)
    .map(s => (s.payload.type === "loop"
      ? `- "${s.payload.instruction}" (seen ${s.evidence.count}× · ${s.evidence.sessions} sessions)`
      : ""))
    .filter(Boolean);
  const cmdLines = suggestions
    .filter(s => s.payload.type === "command")
    .map(s => `- /${s.name} — ${s.title}`);
  return [
    "## How I nudge (mined)",
    "",
    ...(nudgeLines.length ? nudgeLines : ["_no nudge patterns mined yet_"]),
    "",
    "## My workflows (mined)",
    "",
    ...(cmdLines.length ? cmdLines : ["_no workflow commands mined yet_"]),
  ].join("\n");
}

/** Splice the mined section into `existing` (or the default template). Returns
 * null when the markers are gone — the user owns the file, leave it alone. */
export function generatePlaybook(suggestions: Suggestion[], existing?: string): string | null {
  const base = existing ?? DEFAULT_PLAYBOOK;
  const start = base.indexOf(MINED_START);
  const end = base.indexOf(MINED_END);
  if (start === -1 || end === -1 || end < start) return null;
  return (
    base.slice(0, start + MINED_START.length) +
    "\n" + renderMinedSection(suggestions) + "\n" +
    base.slice(end)
  );
}

export async function writePlaybook(suggestions: Suggestion[], home?: string): Promise<string | null> {
  const path = playbookPath(home);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined; // first run
  }
  const next = generatePlaybook(suggestions, existing);
  if (next === null) return null;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return path;
}

/** The judge's playbook. Built-in defaults when no file exists — autopilot works before the first scan. */
export async function loadPlaybook(home?: string): Promise<string> {
  try {
    return await readFile(playbookPath(home), "utf8");
  } catch {
    return DEFAULT_PLAYBOOK;
  }
}
```

In `cli/src/commands/scan.ts`: add import `import { writePlaybook } from "../core/playbook.js";` and, immediately after the `suggestions.json` write + its log line, add:

```ts
  try {
    const pb = await writePlaybook(valid, opts.home);
    log(pb ? `playbook updated → ${pb}` : "playbook markers missing — left untouched");
  } catch (e) {
    log(`playbook update failed: ${(e as Error).message}`); // never fails the scan
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/playbook.test.ts src/commands/scan.test.ts`
Expected: PASS (including all pre-existing scan tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/playbook.ts cli/src/core/playbook.test.ts cli/src/commands/scan.ts cli/src/commands/scan.test.ts
git commit -m "feat(core): mined autopilot playbook, generated by scan, user Rules preserved"
```

---

### Task 6: `core/judge.ts` — prompt build, strict parse, timed call

**Files:**
- Create: `cli/src/core/judge.ts`
- Test: `cli/src/core/judge.test.ts`

**Interfaces:**
- Consumes: `LLMBackend`, `LLMRequest` from `llm/backend.js`.
- Produces:
  - `JUDGE_TIMEOUT_MS = 45_000`, `MAX_RESPONSE_CHARS = 2000`, `MAX_WHY_CHARS = 500`
  - `interface JudgeDecision { action: "continue" | "stand_down"; response?: string; why: string }`
  - `buildJudgePrompt(mode: "nudge" | "full", playbook: string, tail: string): LLMRequest`
  - `parseJudgeResponse(raw: string): JudgeDecision` (throws on malformed/oversized)
  - `judge(backend: LLMBackend, req: LLMRequest, opts?: { timeoutMs?: number }): Promise<JudgeDecision>` (throws on timeout/backend error/malformed — caller fails open)

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/judge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseJudgeResponse, judge, MAX_RESPONSE_CHARS } from "./judge.js";
import type { LLMBackend } from "../llm/backend.js";

const fake = (fn: () => Promise<string>): LLMBackend => ({
  name: "fake", available: async () => true, complete: fn,
});

describe("buildJudgePrompt", () => {
  it("embeds playbook and tail; nudge mode has no next-step authority", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "TAIL-CONTENT");
    expect(req.prompt).toContain("PB-CONTENT");
    expect(req.prompt).toContain("TAIL-CONTENT");
    expect(req.system).toContain("stand down");
    expect(req.system).not.toContain("typical next step");
  });

  it("full mode adds next-step authority and the irreversible-actions rule", () => {
    const req = buildJudgePrompt("full", "pb", "tail");
    expect(req.system).toContain("typical next step");
    expect(req.system).toContain("irreversible");
  });
});

describe("parseJudgeResponse", () => {
  it("accepts a valid continue", () => {
    expect(parseJudgeResponse('{"action":"continue","response":"keep going","why":"todos open"}'))
      .toEqual({ action: "continue", response: "keep going", why: "todos open" });
  });

  it("accepts a valid stand_down without response", () => {
    expect(parseJudgeResponse('{"action":"stand_down","why":"asked the user"}'))
      .toEqual({ action: "stand_down", why: "asked the user" });
  });

  it.each([
    ["not json", "plain text"],
    ["bad action", '{"action":"restart","why":"w"}'],
    ["continue without response", '{"action":"continue","why":"w"}'],
    ["continue with blank response", '{"action":"continue","response":"  ","why":"w"}'],
    ["oversized response", JSON.stringify({ action: "continue", response: "x".repeat(MAX_RESPONSE_CHARS + 1), why: "w" })],
    ["oversized why", JSON.stringify({ action: "stand_down", why: "y".repeat(501) })],
  ])("throws on %s", (_name, raw) => {
    expect(() => parseJudgeResponse(raw)).toThrow();
  });
});

describe("judge", () => {
  it("returns the parsed decision from the backend", async () => {
    const d = await judge(fake(async () => '{"action":"stand_down","why":"done"}'), { system: "s", prompt: "p" });
    expect(d.action).toBe("stand_down");
  });

  it("throws when the backend exceeds the timeout", async () => {
    const never = fake(() => new Promise<string>(() => {}));
    await expect(judge(never, { system: "s", prompt: "p" }, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  it("propagates backend errors (caller fails open)", async () => {
    const boom = fake(async () => { throw new Error("cli exploded"); });
    await expect(judge(boom, { system: "s", prompt: "p" })).rejects.toThrow("cli exploded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/judge.test.ts`
Expected: FAIL — module `./judge.js` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/core/judge.ts`:

```ts
import type { LLMBackend, LLMRequest } from "../llm/backend.js";

export const JUDGE_TIMEOUT_MS = 45_000; // hook entry timeout is 60s; leave headroom
export const MAX_RESPONSE_CHARS = 2000;
export const MAX_WHY_CHARS = 500;

export interface JudgeDecision {
  action: "continue" | "stand_down";
  response?: string;
  why: string;
}

export function buildJudgePrompt(mode: "nudge" | "full", playbook: string, tail: string): LLMRequest {
  const system =
    "You are the user's auto-responder for a Claude Code session that just stopped. " +
    "Decide whether the work is actually done or Claude stopped early. " +
    "If work is unfinished and Claude is not waiting on the user, reply with the nudge this user " +
    "would send, in their own phrasing (see PLAYBOOK). " +
    "If Claude asked the user a genuine question, or the work is done, stand down." +
    (mode === "full"
      ? " You may also answer routine questions and, when a task is complete, start this user's " +
        "typical next step per the playbook. Stand down on anything irreversible or destructive " +
        "(pushes, deploys, deletions, spending) unless the playbook's Rules explicitly allow it."
      : "") +
    ' Respond ONLY with JSON: {"action":"continue"|"stand_down","response":"<what to send>","why":"<one line>"}. ' +
    'action "continue" requires a non-empty response; omit response when standing down.';
  return { system, prompt: `PLAYBOOK:\n${playbook}\n\nTRANSCRIPT TAIL:\n${tail}` };
}

/** Strict parse of the judge's reply. Anything off-contract throws (caller fails open). */
export function parseJudgeResponse(raw: string): JudgeDecision {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const action = parsed.action;
  if (action !== "continue" && action !== "stand_down") {
    throw new Error(`invalid judge action: ${String(action)}`);
  }
  const why = typeof parsed.why === "string" ? parsed.why : "";
  if (why.length > MAX_WHY_CHARS) throw new Error("judge why exceeds cap");
  if (action === "continue") {
    const response = parsed.response;
    if (typeof response !== "string" || !response.trim()) {
      throw new Error("judge continue requires a non-empty response");
    }
    if (response.length > MAX_RESPONSE_CHARS) throw new Error("judge response exceeds cap");
    return { action, response, why };
  }
  return { action, why };
}

/** One timed LLM call. Throws on timeout, backend error, or malformed output. */
export async function judge(
  backend: LLMBackend,
  req: LLMRequest,
  opts: { timeoutMs?: number } = {},
): Promise<JudgeDecision> {
  const ms = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`judge timed out after ${ms}ms`)), ms);
  });
  try {
    const raw = await Promise.race([backend.complete(req), timeout]);
    return parseJudgeResponse(raw);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/judge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/judge.ts cli/src/core/judge.test.ts
git commit -m "feat(core): autopilot judge — mode prompts, strict schema, 45s timeout"
```

---

### Task 7: `commands/respond.ts` — the gated pipeline

**Files:**
- Create: `cli/src/commands/respond.ts`
- Test: `cli/src/commands/respond.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 exports — `loadConfig`/`DEFAULT_AUTOPILOT_BUDGET`/`DEFAULT_AUTOPILOT_MODEL` (`../config.js`), `loadState`/`saveState`/`cleanupStale` (`../core/state.js`), `renderTail`/`fingerprint`/`readTranscriptLines` (`../core/tail.js`), `loadPlaybook` (`../core/playbook.js`), `buildJudgePrompt`/`judge` (`../core/judge.js`), `redact` (`../core/security.js`), `selectBackend` (`../llm/index.js`), `ClaudeCliBackend`, `AnthropicBackend`.
- Produces (Task 9 relies on):
  - `interface StopHookInput { session_id?: string; transcript_path?: string; cwd?: string; hook_event_name?: string; stop_hook_active?: boolean }`
  - `interface RespondResult { decision: "allow" | "block"; reason?: string }`
  - `respond(input: StopHookInput, deps?: RespondDeps): Promise<RespondResult>` — **never throws**
  - `ANTHROPIC_MODEL_ALIASES: Record<string, string>` mapping `haiku → claude-haiku-4-5-20251001` (the claude CLI accepts the `haiku` alias; the Anthropic API needs a real model ID)

- [ ] **Step 1: Write the failing tests**

Create `cli/src/commands/respond.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond, type RespondDeps, type StopHookInput } from "./respond.js";
import { loadState, saveState, freshState } from "../core/state.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "grad-home-"));

const fakeBackend = (reply: string): LLMBackend => ({
  name: "fake", available: async () => true, complete: async () => reply,
});

const CONTINUE = '{"action":"continue","response":"continue until actually done","why":"open todos"}';
const STAND_DOWN = '{"action":"stand_down","why":"claude asked the user a question"}';

// Transcript with N tool_use blocks (fingerprint = tools:N)
const transcript = (tools: number): string[] => [
  JSON.stringify({ type: "user", message: { content: "do the thing" } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "working" }, ...Array.from({ length: tools }, () => ({ type: "tool_use", name: "Edit" }))] },
  }),
];

const input: StopHookInput = { session_id: "sess1", transcript_path: "t.jsonl" };

async function run(over: Partial<RespondDeps> & { home: string; tools?: number }) {
  const deps: RespondDeps = {
    config: { autopilot: "nudge" } as Config,
    backend: fakeBackend(CONTINUE),
    readLines: async () => transcript(over.tools ?? 3),
    env: {},
    now: () => "2026-07-01T00:00:00Z",
    ...over,
  };
  return respond(input, deps);
}

describe("respond gates (all fail-open)", () => {
  it("gate 1: recursion guard env → allow, no state touched", async () => {
    const home = await tmpHome();
    const r = await run({ home, env: { GRADIENT_AUTOPILOT_CHILD: "1" } });
    expect(r.decision).toBe("allow");
    expect((await loadState("sess1", home)).count).toBe(0);
  });

  it("gate 2: mode off or absent → allow", async () => {
    const home = await tmpHome();
    expect((await run({ home, config: {} as Config })).decision).toBe("allow");
    expect((await run({ home, config: { autopilot: "off" } as Config })).decision).toBe("allow");
  });

  it("missing session_id or transcript_path → allow", async () => {
    const home = await tmpHome();
    const r = await respond({}, { home, config: { autopilot: "nudge" } as Config, env: {} });
    expect(r.decision).toBe("allow");
  });

  it("gate 3: budget exhausted → allow without calling the judge", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 10 }, home);
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await run({ home, backend });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("gate 4: unchanged fingerprint after a response → stands down and latches", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 1, lastFingerprint: "tools:3" }, home);
    const r = await run({ home, tools: 3 }); // no new tool activity
    expect(r.decision).toBe("allow");
    expect((await loadState("sess1", home)).stoodDown).toBe(true);
  });

  it("stood-down latch clears when tool activity advances", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 1, lastFingerprint: "tools:3", stoodDown: true }, home);
    const r = await run({ home, tools: 5 }); // progress since latch
    expect(r.decision).toBe("block");
    expect((await loadState("sess1", home)).stoodDown).toBe(false);
  });
});

describe("respond judge outcomes", () => {
  it("continue → block with the judge's response, state updated & logged", async () => {
    const home = await tmpHome();
    const r = await run({ home });
    expect(r).toEqual({ decision: "block", reason: "continue until actually done" });
    const s = await loadState("sess1", home);
    expect(s.count).toBe(1);
    expect(s.lastFingerprint).toBe("tools:3");
    expect(s.log[0]).toMatchObject({ action: "continue", why: "open todos", ts: "2026-07-01T00:00:00Z" });
  });

  it("stand_down → allow, logged, count unchanged", async () => {
    const home = await tmpHome();
    const r = await run({ home, backend: fakeBackend(STAND_DOWN) });
    expect(r.decision).toBe("allow");
    const s = await loadState("sess1", home);
    expect(s.count).toBe(0);
    expect(s.log[0].action).toBe("stand_down");
  });

  it.each([
    ["malformed judge output", fakeBackend("not json")],
    ["backend throws", { name: "f", available: async () => true, complete: async () => { throw new Error("boom"); } } as LLMBackend],
  ])("%s → allow (fail-open)", async (_n, backend) => {
    const home = await tmpHome();
    expect((await run({ home, backend })).decision).toBe("allow");
  });

  it("no backend available → allow", async () => {
    const home = await tmpHome();
    expect((await run({ home, backend: null })).decision).toBe("allow");
  });

  it("unreadable transcript → allow", async () => {
    const home = await tmpHome();
    const r = await run({ home, readLines: async () => { throw new Error("ENOENT"); } });
    expect(r.decision).toBe("allow");
  });

  it("redacts secrets from the tail before the judge sees it", async () => {
    const home = await tmpHome();
    let seen = "";
    const backend: LLMBackend = {
      name: "f", available: async () => true,
      complete: async req => { seen = req.prompt; return STAND_DOWN; },
    };
    const lines = [JSON.stringify({ type: "user", message: { content: "use API_KEY=supersecret123 now" } })];
    await run({ home, backend, readLines: async () => lines });
    expect(seen).toContain("[REDACTED]");
    expect(seen).not.toContain("supersecret123");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/respond.test.ts`
Expected: FAIL — module `./respond.js` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/commands/respond.ts`:

```ts
import { tmpdir } from "node:os";
import type { Config } from "../core/types.js";
import { loadConfig, DEFAULT_AUTOPILOT_BUDGET, DEFAULT_AUTOPILOT_MODEL } from "../config.js";
import { loadState, saveState, cleanupStale } from "../core/state.js";
import { renderTail, fingerprint, readTranscriptLines } from "../core/tail.js";
import { loadPlaybook } from "../core/playbook.js";
import { buildJudgePrompt, judge } from "../core/judge.js";
import { redact } from "../core/security.js";
import { selectBackend } from "../llm/index.js";
import { ClaudeCliBackend } from "../llm/claudeCli.js";
import { AnthropicBackend } from "../llm/anthropic.js";
import type { LLMBackend } from "../llm/backend.js";

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean; // intentionally unused as a gate (spec §1): budget + progress are the loop protection
}

export interface RespondResult {
  decision: "allow" | "block";
  reason?: string;
}

export interface RespondDeps {
  config?: Config;
  backend?: LLMBackend | null;
  readLines?: (path: string) => Promise<string[]>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => string;
}

/** The claude CLI accepts the "haiku" alias; the Anthropic API needs a real model ID. */
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
};

async function autopilotBackend(config: Config): Promise<LLMBackend | null> {
  const model = config.autopilotModel ?? DEFAULT_AUTOPILOT_MODEL;
  return selectBackend({
    config,
    candidates: [
      // Neutral cwd + guard env: the headless child must never re-enter this hook.
      new ClaudeCliBackend({ model, spawnCwd: tmpdir(), extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" } }),
      new AnthropicBackend({ model: ANTHROPIC_MODEL_ALIASES[model] ?? model }),
    ],
  });
}

/**
 * The Stop-hook pipeline: free local gates, then one judge call.
 * NEVER throws — every failure path resolves to {decision:"allow"} so the
 * stop stands (spec §6). The caller must still exit 0 unconditionally.
 */
export async function respond(input: StopHookInput, deps: RespondDeps = {}): Promise<RespondResult> {
  const allow: RespondResult = { decision: "allow" };
  try {
    // Gate 1: recursion guard.
    const env = deps.env ?? process.env;
    if (env.GRADIENT_AUTOPILOT_CHILD) return allow;

    // Gate 2: mode.
    const config = deps.config ?? (await loadConfig(deps.home));
    const mode = config.autopilot;
    if (mode !== "nudge" && mode !== "full") return allow;
    if (!input.session_id || !input.transcript_path) return allow;

    void cleanupStale(deps.home).catch(() => {}); // opportunistic, never awaited on the hot path

    // Gate 3: budget.
    const state = await loadState(input.session_id, deps.home);
    const budget = config.autopilotBudget ?? DEFAULT_AUTOPILOT_BUDGET;
    if (state.count >= budget) return allow;

    // Gate 4: progress. Fingerprint is tool-activity only (see tail.ts).
    const lines = await (deps.readLines ?? readTranscriptLines)(input.transcript_path);
    const fp = fingerprint(lines);
    if (state.stoodDown) {
      if (fp === state.lastFingerprint) return allow; // still latched
      state.stoodDown = false; // real work happened since — latch clears
    }
    if (state.lastFingerprint !== "" && fp === state.lastFingerprint) {
      state.stoodDown = true; // stopped again with zero new tool activity: don't nudge into a wall
      await saveState(input.session_id, state, deps.home);
      return allow;
    }

    const backend = deps.backend !== undefined ? deps.backend : await autopilotBackend(config);
    if (!backend) return allow;

    const tail = redact(renderTail(lines));
    const playbook = await loadPlaybook(deps.home);
    const decision = await judge(backend, buildJudgePrompt(mode, playbook, tail), { timeoutMs: deps.timeoutMs });

    const ts = (deps.now ?? (() => new Date().toISOString()))();
    state.lastFingerprint = fp; // recorded on every decision: identical transcripts are never re-judged
    if (decision.action === "continue" && decision.response) {
      state.count += 1;
      state.log.push({ ts, action: "continue", why: decision.why, excerpt: decision.response.slice(0, 120) });
      await saveState(input.session_id, state, deps.home);
      return { decision: "block", reason: decision.response };
    }
    state.log.push({ ts, action: "stand_down", why: decision.why, excerpt: "" });
    await saveState(input.session_id, state, deps.home);
    return allow;
  } catch {
    return allow; // fail-open: autopilot's failure mode is "off"
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/respond.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/respond.ts cli/src/commands/respond.test.ts
git commit -m "feat(commands): gradient respond — gated fail-open Stop-hook pipeline"
```

---

### Task 8: `commands/autopilot.ts` — mode switch + status

**Files:**
- Create: `cli/src/commands/autopilot.ts`
- Test: `cli/src/commands/autopilot.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig`/`DEFAULT_AUTOPILOT_BUDGET` (`../config.js`), `installHook`/`removeHook`/`hookInstalled` (`../core/settings.js`), `latestState` (`../core/state.js`), `playbookPath` (`../core/playbook.js`), `AutopilotLogEntry` (`../core/types.js`).
- Produces (Task 9 relies on):
  - `AutopilotMode` re-exported from `core/types.ts` (defined in Task 1)
  - `RESPOND_HOOK_COMMAND = "gradient respond"`
  - `setAutopilotMode(mode: AutopilotMode, projectDir: string, opts?: { home?: string }): Promise<{ mode: AutopilotMode; hookInstalled: boolean; settingsPath: string }>`
  - `autopilotStatus(projectDir: string, opts?: { home?: string }): Promise<AutopilotStatus>` where `AutopilotStatus = { mode: AutopilotMode; budget: number; playbookPath: string; playbookExists: boolean; hookInstalled: boolean; recent: AutopilotLogEntry[] }`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/commands/autopilot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setAutopilotMode, autopilotStatus, RESPOND_HOOK_COMMAND } from "./autopilot.js";
import { loadConfig } from "../config.js";
import { hookInstalled } from "../core/settings.js";
import { saveState, freshState } from "../core/state.js";
import { playbookPath } from "../core/playbook.js";

const tmp = () => mkdtemp(join(tmpdir(), "grad-ap-"));

describe("setAutopilotMode", () => {
  it("nudge: writes config and installs the Stop hook with a 60s timeout", async () => {
    const home = await tmp(), project = await tmp();
    const r = await setAutopilotMode("nudge", project, { home });
    expect(r).toMatchObject({ mode: "nudge", hookInstalled: true });
    expect((await loadConfig(home)).autopilot).toBe("nudge");
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(true);
    const settings = JSON.parse(await (await import("node:fs/promises")).readFile(join(project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(60);
  });

  it("off: removes the hook and sets mode off", async () => {
    const home = await tmp(), project = await tmp();
    await setAutopilotMode("full", project, { home });
    const r = await setAutopilotMode("off", project, { home });
    expect(r.hookInstalled).toBe(false);
    expect((await loadConfig(home)).autopilot).toBe("off");
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(false);
  });

  it("preserves existing config keys when switching modes", async () => {
    const home = await tmp(), project = await tmp();
    await mkdir(dirname(join(home, ".config", "gradient", "config.json")), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), JSON.stringify({ backend: "claude-cli", model: "opus" }));
    await setAutopilotMode("nudge", project, { home });
    const cfg = await loadConfig(home);
    expect(cfg.backend).toBe("claude-cli");
    expect(cfg.model).toBe("opus");
    expect(cfg.autopilot).toBe("nudge");
  });
});

describe("autopilotStatus", () => {
  it("reports mode, budget default, playbook absence, hook state, empty recent", async () => {
    const home = await tmp(), project = await tmp();
    const s = await autopilotStatus(project, { home });
    expect(s).toMatchObject({ mode: "off", budget: 10, playbookExists: false, hookInstalled: false, recent: [] });
    expect(s.playbookPath).toBe(playbookPath(home));
  });

  it("reports installed hook, existing playbook, and recent log entries", async () => {
    const home = await tmp(), project = await tmp();
    await setAutopilotMode("nudge", project, { home });
    await mkdir(dirname(playbookPath(home)), { recursive: true });
    await writeFile(playbookPath(home), "pb");
    await saveState("sess1", {
      ...freshState(), count: 2,
      log: [{ ts: "t1", action: "continue", why: "open todos", excerpt: "keep going" }],
    }, home);
    const s = await autopilotStatus(project, { home });
    expect(s.mode).toBe("nudge");
    expect(s.playbookExists).toBe(true);
    expect(s.hookInstalled).toBe(true);
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0].why).toBe("open todos");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/autopilot.test.ts`
Expected: FAIL — module `./autopilot.js` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/commands/autopilot.ts`:

```ts
import { access } from "node:fs/promises";
import { loadConfig, saveConfig, DEFAULT_AUTOPILOT_BUDGET } from "../config.js";
import { installHook, removeHook, hookInstalled } from "../core/settings.js";
import { latestState } from "../core/state.js";
import { playbookPath } from "../core/playbook.js";
import type { AutopilotLogEntry, AutopilotMode } from "../core/types.js";

export type { AutopilotMode }; // single source of truth: core/types.ts

export const RESPOND_HOOK_COMMAND = "gradient respond";
const HOOK_TIMEOUT_S = 60;
const STATUS_RECENT = 5;

export interface SetModeResult {
  mode: AutopilotMode;
  hookInstalled: boolean;
  settingsPath: string;
}

/** Mode is user-global (config); the Stop hook is per-project (settings.json). Spec §3.1. */
export async function setAutopilotMode(
  mode: AutopilotMode,
  projectDir: string,
  opts: { home?: string } = {},
): Promise<SetModeResult> {
  const config = await loadConfig(opts.home);
  config.autopilot = mode;
  await saveConfig(config, opts.home);
  if (mode === "off") {
    const settingsPath = await removeHook(projectDir, "Stop", RESPOND_HOOK_COMMAND);
    return { mode, hookInstalled: false, settingsPath };
  }
  const settingsPath = await installHook(projectDir, "Stop", RESPOND_HOOK_COMMAND, { timeout: HOOK_TIMEOUT_S });
  return { mode, hookInstalled: true, settingsPath };
}

export interface AutopilotStatus {
  mode: AutopilotMode;
  budget: number;
  playbookPath: string;
  playbookExists: boolean;
  hookInstalled: boolean;
  recent: AutopilotLogEntry[];
}

export async function autopilotStatus(
  projectDir: string,
  opts: { home?: string } = {},
): Promise<AutopilotStatus> {
  const config = await loadConfig(opts.home);
  const pbPath = playbookPath(opts.home);
  let playbookExists = true;
  try {
    await access(pbPath);
  } catch {
    playbookExists = false;
  }
  const latest = await latestState(opts.home);
  return {
    mode: (config.autopilot ?? "off") as AutopilotMode,
    budget: config.autopilotBudget ?? DEFAULT_AUTOPILOT_BUDGET,
    playbookPath: pbPath,
    playbookExists,
    hookInstalled: await hookInstalled(projectDir, "Stop", RESPOND_HOOK_COMMAND),
    recent: latest?.state.log.slice(-STATUS_RECENT) ?? [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/autopilot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/autopilot.ts cli/src/commands/autopilot.test.ts
git commit -m "feat(commands): gradient autopilot — mode switch, hook install/remove, status"
```

---

### Task 9: CLI wiring (`autopilot` + `respond` dispatch, HELP, nudge hint)

**Files:**
- Modify: `cli/src/cli.ts`
- Modify: `cli/src/commands/review.ts` (nudge hint in prompter)
- Test: `cli/src/cli.test.ts` (append), `cli/src/commands/review.test.ts` (append)

**Interfaces:**
- Consumes: `respond`/`StopHookInput` (Task 7), `setAutopilotMode`/`autopilotStatus` (Task 8), `isNudge` (Task 5), `AutopilotMode` (Task 1, via `core/types.js`).
- Produces: user-visible command surface. `readStdinJson` generalizes to `Promise<Record<string, unknown>>`, and `main`'s `io` param gains an optional `readStdin` so hook-target dispatch is testable without touching real stdin (vitest's stdin is not a TTY — an uninjected read would hang the test awaiting EOF).
- Spec §3.6 note: the spec names `review`/`list` as hint surfaces, but `list` displays applied *artifacts* (manifest entries), not suggestions — the suggestion-display surfaces are `scan`'s result listing and `review`'s prompter, so the hint goes there. Document-level deviation, same intent: the hint appears wherever a nudge-style loop *suggestion* is shown.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/cli.test.ts` (follow its existing idiom: call `main([...], { log })` with a captured log array; it runs against `process.cwd()`-independent commands or tmp dirs as the neighboring tests do — mirror how existing dispatch tests there isolate `projectDir` via `process.chdir` or accept-cwd behavior):

```ts
describe("autopilot dispatch", () => {
  it("help text lists autopilot", async () => {
    const lines: string[] = [];
    await main([], { log: s => lines.push(s) });
    expect(lines.join("\n")).toContain("gradient autopilot <off|nudge|full>");
  });

  it("rejects an unknown autopilot mode", async () => {
    const lines: string[] = [];
    const code = await main(["autopilot", "sideways"], { log: s => lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown autopilot mode");
  });
});

describe("respond dispatch", () => {
  it("prints nothing and exits 0 when the stop stands", async () => {
    // Injected stdin: empty hook input → respond lacks session_id → allow.
    // The contract under test: exit 0, completely silent stdout.
    const lines: string[] = [];
    const code = await main(["respond"], { log: s => lines.push(s), readStdin: async () => ({}) });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });
});
```

Append to `cli/src/commands/review.test.ts` (it already tests `review()` with fake prompters; add a prompter-display test only if the file already asserts on prompter output — otherwise cover the hint at the unit level):

```ts
import { isNudge } from "../core/playbook.js";

describe("nudge hint", () => {
  it("cadence-less loop suggestions are flagged for the autopilot hint", () => {
    const s = {
      id: "i", name: "continue", title: "t", rationale: "r",
      evidence: { count: 150, sessions: 44 }, confidence: "high" as const,
      payload: { type: "loop" as const, instruction: "continue until done" },
    };
    expect(isNudge(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli.test.ts src/commands/review.test.ts`
Expected: FAIL — HELP lacks autopilot; `autopilot` hits the `unknown command` branch (exit 2 but with "unknown command" text, so the substring assertion fails).

- [ ] **Step 3: Implement**

In `cli/src/cli.ts`:

1. Add imports:

```ts
import { respond, type StopHookInput } from "./commands/respond.js";
import { setAutopilotMode, autopilotStatus } from "./commands/autopilot.js";
import { isNudge } from "./core/playbook.js";
```

2. Extend `main`'s signature so hook dispatch is testable:

```ts
export async function main(
  argv: string[],
  io: { log?: (s: string) => void; readStdin?: () => Promise<Record<string, unknown>> } = {},
): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const readStdin = io.readStdin ?? readStdinJson;
  // ...
```

and use `readStdin()` in both the existing `checkpoint` case and the new `respond` case.

3. Extend `HELP` — after the `gradient stats` line add:

```
  gradient autopilot <off|nudge|full>
                                auto-respond when Claude stops (opt-in)
  gradient autopilot status     mode, budget, and recent auto-responses
```

4. Generalize `readStdinJson`:

```ts
async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
```

and cast at the existing checkpoint call site: `const path = await checkpoint(input as { transcript_path?: string }, projectDir);`

5. Add the two cases before `default:`:

```ts
      case "autopilot": {
        const arg = positionals[0] ?? "status";
        if (arg === "off" || arg === "nudge" || arg === "full") {
          const r = await setAutopilotMode(arg, projectDir); // narrowed to AutopilotMode by the condition
          log(banner(VERSION));
          log(`${c.muted("autopilot:")} ${c.bold(r.mode)}`);
          log(
            r.hookInstalled
              ? `${c.ok("Stop hook installed")} ${c.muted(r.settingsPath)}`
              : `${c.muted("Stop hook removed:")} ${r.settingsPath}`,
          );
          return 0;
        }
        if (arg !== "status") {
          log(c.coral(`unknown autopilot mode: ${arg} (use off|nudge|full|status)`));
          return 2;
        }
        const s = await autopilotStatus(projectDir);
        log(banner(VERSION));
        log(`${c.muted("mode:")} ${c.bold(s.mode)}`);
        log(`${c.muted("budget:")} ${s.budget} auto-responses/session`);
        log(`${c.muted("playbook:")} ${s.playbookPath}${s.playbookExists ? "" : c.dim(" (not yet generated — run gradient scan)")}`);
        log(`${c.muted("stop hook here:")} ${s.hookInstalled ? c.ok("installed") : "not installed"}`);
        for (const e of s.recent) {
          log(`  ${c.dim(e.ts)} ${e.action === "continue" ? c.ok("continued") : c.muted("stood down")}  ${c.dim(e.why)}`);
        }
        return 0;
      }
      case "respond": {
        // Stop-hook target. Contract: exit 0 ALWAYS; stdout carries ONLY the
        // block JSON (exit code 2 / stderr would be injected into Claude).
        try {
          const input = await readStdin();
          const r = await respond(input as StopHookInput);
          if (r.decision === "block") log(JSON.stringify({ decision: "block", reason: r.reason }));
        } catch {
          // fail-open: the stop stands
        }
        return 0;
      }
```

6. Nudge hint in the `scan` case's suggestion listing — inside the existing `for (const s of out)` loop, after the existing `log(...)`:

```ts
          if (isNudge(s)) {
            log(`      ${c.dim("tip: this is what autopilot automates →")} ${c.violet("gradient autopilot nudge")}`);
          }
```

In `cli/src/commands/review.ts`: add `import { isNudge } from "../core/playbook.js";` and in `readlinePrompter`, after the `process.stdout.write(...)` block that prints the suggestion header, add:

```ts
    if (isNudge(s)) {
      process.stdout.write("  tip: this is what autopilot automates → gradient autopilot nudge\n");
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli.test.ts src/commands/review.test.ts`
Expected: PASS (all pre-existing cli tests too).

- [ ] **Step 5: Commit**

```bash
git add cli/src/cli.ts cli/src/commands/review.ts cli/src/cli.test.ts cli/src/commands/review.test.ts
git commit -m "feat(cli): wire autopilot + respond commands, HELP, nudge hint"
```

---

### Task 10: Stale-comment cleanup, README, full verification

**Files:**
- Modify: `cli/src/core/parse.ts` (comment only), `cli/src/core/types.ts` (comment only)
- Modify: `README.md`
- No new tests (comment/doc changes); final full-suite verification.

**Interfaces:** none — documentation and verification.

- [ ] **Step 1: Rewrite the stale "phase 2" comments (spec §9)**

In `cli/src/core/parse.ts`, replace the line

```ts
// v1 parses only genuine user prompts; assistant turns are skipped on purpose.
```

with

```ts
// Mining pipeline: genuine user prompts only. Assistant turns + tool activity
// are consumed separately by core/tail.ts for the autopilot judge.
```

In `cli/src/core/types.ts`, replace the `Turn` doc comment

```ts
/** One genuine user prompt after parse + filter. (v1 consumes only user text;
 * assistant turns / tool sequences are intentionally not parsed until phase 2.) */
```

with

```ts
/** One genuine user prompt after parse + filter. (The mining pipeline consumes
 * only user text; assistant turns are rendered by core/tail.ts for autopilot.) */
```

- [ ] **Step 2: README — autopilot section + trust-copy honesty fix**

In `/Users/ellioteckholm/projects/gradient/README.md`:

1. Replace the tagline sentence

> It only ever suggests: nothing runs without you.

with

> It only ever suggests: nothing runs without you turning it on.

2. After the **Quickstart (CLI)** section (after the "The default backend reuses your existing `claude` CLI auth…" paragraph), add:

```markdown
## Autopilot (opt-in)

The most-mined pattern in every history is the nudge — `continue`, `what's
next?` — typed hundreds of times. `gradient autopilot` automates exactly that:
a `Stop` hook that answers the way *you* would, using the phrasings mined into
your playbook (`~/.config/gradient/playbook.md`, yours to edit — `scan`
refreshes only its marked region).

```bash
npx gradient autopilot nudge   # opt in (this project): push unfinished work forward
npx gradient autopilot full    # also answer routine questions / start your usual next step
npx gradient autopilot status  # what did it do while I was away?
npx gradient autopilot off     # remove the hook
```

Bounded by design: a per-session budget (default 10), a progress gate that
stands down when Claude stops twice with no new tool activity, and fail-open
errors — anything unexpected means Claude just stops normally. Your permission
prompts still gate dangerous tools; autopilot cannot answer those.
```

- [ ] **Step 3: Full verification**

Run: `cd /Users/ellioteckholm/projects/gradient/cli && npm test && npm run typecheck && npm run build`
Expected: all tests PASS, no type errors, clean build.

- [ ] **Step 4: Commit**

```bash
git add cli/src/core/parse.ts cli/src/core/types.ts README.md
git commit -m "docs: autopilot README section, trust-copy fix, retire stale phase-2 comments"
```

---

## Post-plan follow-ups (explicitly out of this plan)

- Landing page (`gradient-web`): Coverage/trust copy update for autopilot — separate repo, done post-ship like Spec 1.
- Merge flow: after final review, merge `spec/auto-responder` → `main` (superpowers:finishing-a-development-branch).
