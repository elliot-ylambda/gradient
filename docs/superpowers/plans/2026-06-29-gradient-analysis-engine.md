# gradient Analysis Engine Implementation Plan

**Status:** Complete and released. Unchecked boxes below preserve the original
test-first execution recipe.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gradient`, a TypeScript CLI that mines a user's Claude Code transcripts and proposes slash-command / loop / hook artifacts through a read-only `scan` → approve `review` → reversible `apply` flow.

**Architecture:** A pure-functional core library (one job per module, plain data in/out, side effects only under `.gradient/` and approved write targets) wrapped by a thin CLI. Detection is two-stage: a cheap local cluster pass (no LLM) produces candidates, and an LLM backend only confirms/names/types the top-N. The LLM backend is pluggable: default shells out to the `claude` CLI (reusing existing auth), falling back to the Anthropic SDK with an API key.

**Tech Stack:** Node 20+, TypeScript (ESM), `node:util.parseArgs` for CLI parsing, `node:child_process` for the claude-CLI backend, `node:readline` for interactive review, `@anthropic-ai/sdk` (only shipped runtime dep), `vitest` + `@types/node` (dev only).

## Global Constraints

- **Runtime:** Node `>=20` (uses stable `node:util.parseArgs`, `node:test`-compatible features). Set in `package.json` `engines`.
- **Module system:** ESM only (`"type": "module"`); all imports use explicit `.js` extensions in source for NodeNext resolution.
- **Runtime dependencies:** exactly one — `@anthropic-ai/sdk`. Everything else is a Node built-in. Do not add other runtime deps.
- **Dev dependencies:** `typescript`, `vitest`, `@types/node` only.
- **Purity rule:** core modules write only under the project's `.gradient/` dir, `.claude/commands/`, and (for `init`) `~/.claude/skills/gradient/`. Tests must not write outside an OS temp dir.
- **Binary name:** `gradient` (package name `gradient`, `bin.gradient` → `dist/cli.js`).
- **Hook rule (spec §2 decision 9):** generated hooks invoke a `gradient` subcommand listed in `KNOWN_SUBCOMMANDS`; never bespoke inline shell.
- **Confidence labels (verbatim):** `"high"` (exact repeats), `"inferred"` (fuzzy clusters), `"flagged"` (weak / review carefully).
- **No silent truncation:** when the candidate set is capped before the LLM, print the cap and dropped count.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project config, build, test |
| `src/core/types.ts` | All shared types (`Turn`, `Candidate`, `Suggestion`, `SuggestionPayload`, `ManifestEntry`, `Config`) |
| `src/core/collect.ts` | Scope → transcript file paths (+ pure `matchesScope`) |
| `src/core/parse.ts` | JSONL → `Turn[]` (+ pure `parseLines`) |
| `src/core/filter.ts` | Strip injected/hook/skill/system text → genuine prompts |
| `src/core/security.ts` | `assertInside`, `sanitizeName`, `redact` |
| `src/core/cluster.ts` | `normalize`, `similarity`, `cluster` → `Candidate[]` (pure, no LLM) |
| `src/core/detect.ts` | `Candidate[]` + backend → `Suggestion[]` (graceful no-LLM path) |
| `src/core/validate.ts` | `validateSuggestion`, `assertHookRunnable`, `KNOWN_SUBCOMMANDS` |
| `src/core/emit/command.ts` `loop.ts` `hook.ts` `index.ts` | `Suggestion` → artifact content + `emit()` dispatcher |
| `src/core/manifest.ts` | `loadManifest`, `addEntry`, `removeEntry` |
| `src/core/apply.ts` | `applySuggestion` (emit → security → write → manifest) |
| `src/llm/backend.ts` | `LLMBackend` interface, `LLMRequest` |
| `src/llm/claudeCli.ts` | `claude -p --output-format json` backend |
| `src/llm/anthropic.ts` | Anthropic SDK backend |
| `src/llm/index.ts` | `selectBackend()` auto-detect |
| `src/config.ts` | `loadConfig`, `saveConfig`, paths |
| `src/commands/scan.ts` | Orchestrate pipeline → cache + print |
| `src/commands/review.ts` | Interactive approve loop |
| `src/commands/apply.ts` | `applyByIds` (non-interactive) |
| `src/commands/list.ts` `remove.ts` | Manifest-backed management |
| `src/commands/checkpoint.ts` | Hook-helper: write progress snapshot |
| `src/commands/init.ts` | Config + self-install `/gradient` skill |
| `src/skill/SKILL.md` | The `/gradient` skill template |
| `src/cli.ts` | `parseArgs` dispatch + `main(argv)` |

---

## Task 1: Project scaffold + shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/types.ts`
- Test: `src/core/types.test.ts`

**Interfaces:**
- Produces: all shared types used by every later task (exact shapes below).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "gradient",
  "version": "0.1.0",
  "type": "module",
  "bin": { "gradient": "dist/cli.js" },
  "engines": { "node": ">=20" },
  "files": ["dist", "src/skill"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": { "@anthropic-ai/sdk": "^0.40.0" },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.16.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 4: Create `src/core/types.ts`**

```ts
export type Role = "user" | "assistant";
export type Confidence = "high" | "inferred" | "flagged";
export type ArtifactType = "command" | "loop" | "hook";

/** One genuine user prompt after parse + filter. (v1 consumes only user text;
 * assistant turns / tool sequences are intentionally not parsed until phase 2.) */
export interface Turn {
  ts: string;
  project: string;
  branch?: string;
  role: Role;
  text?: string;        // typed prompt (user), injected text removed
  sessionId: string;
}

/** Pre-LLM grouping produced by cluster.ts (no model involved). */
export interface Candidate {
  kind: ArtifactType | "unknown";
  signature: string;     // normalized key the cluster grouped on
  examples: string[];    // representative raw prompts
  count: number;
  sessions: number;
  confidence: Confidence;
}

/** Semantic content of a suggestion; emit/* formats it into an artifact. */
export type SuggestionPayload =
  | { type: "command"; commandName: string; body: string }
  | { type: "loop"; instruction: string; cadence?: string }
  | { type: "hook"; event: string; subcommand: string; description: string };

/** Post-LLM (or post-degradation), ready to present/emit. */
export interface Suggestion {
  id: string;
  name: string;
  title: string;
  rationale: string;
  evidence: { count: number; sessions: number };
  confidence: Confidence;
  payload: SuggestionPayload;
}

export interface ManifestEntry {
  name: string;
  type: ArtifactType;
  path: string;          // written file path; "" for loop (printed only)
  createdAt: string;
  suggestionId: string;
}

export interface Config {
  backend?: "claude-cli" | "anthropic";
  model?: string;
}
```

- [ ] **Step 5: Write the type smoke test** `src/core/types.test.ts`

```ts
import { describe, it, expect } from "vitest";
import type { Suggestion } from "./types.js";

describe("types", () => {
  it("constructs a command suggestion", () => {
    const s: Suggestion = {
      id: "abc",
      name: "ship",
      title: "Push + open PR + review",
      rationale: "seen 13x",
      evidence: { count: 13, sessions: 9 },
      confidence: "high",
      payload: { type: "command", commandName: "ship", body: "Push and open a PR." },
    };
    expect(s.payload.type).toBe("command");
  });
});
```

- [ ] **Step 6: Install + run**

Run: `npm install && npm test`
Expected: vitest runs, 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/core/types.ts src/core/types.test.ts package-lock.json
git commit -m "chore: scaffold gradient CLI project + shared types"
```

---

## Task 2: `collect.ts` — transcript discovery

**Files:**
- Create: `src/core/collect.ts`
- Test: `src/core/collect.test.ts`

**Interfaces:**
- Produces:
  - `encodeProjectDir(cwd: string): string` — `/Users/x/projects/y` → `-Users-x-projects-y`
  - `interface CollectOptions { scope: "project" | "all"; projectPath?: string; sinceDays?: number; now?: number; home?: string }`
  - `collect(opts: CollectOptions): Promise<string[]>` — absolute `.jsonl` paths, excluding `**/subagents/**`
  - `matchesSince(mtimeMs: number, sinceDays: number | undefined, now: number): boolean` (pure)

- [ ] **Step 1: Write the failing test** `src/core/collect.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { encodeProjectDir, matchesSince } from "./collect.js";

describe("collect helpers", () => {
  it("encodes a cwd to a projects dir name", () => {
    expect(encodeProjectDir("/Users/x/projects/y")).toBe("-Users-x-projects-y");
  });
  it("matchesSince keeps recent files and drops old ones", () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(matchesSince(now - 2 * day, 7, now)).toBe(true);
    expect(matchesSince(now - 10 * day, 7, now)).toBe(false);
    expect(matchesSince(now - 999 * day, undefined, now)).toBe(true); // no filter
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/collect.test.ts`
Expected: FAIL — cannot find module `./collect.js`.

- [ ] **Step 3: Implement** `src/core/collect.ts`

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CollectOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  now?: number;
  home?: string;
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function matchesSince(mtimeMs: number, sinceDays: number | undefined, now: number): boolean {
  if (sinceDays === undefined) return true;
  return now - mtimeMs <= sinceDays * 86_400_000;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "subagents") continue; // exclude subagent transcripts
      out.push(...(await walk(full)));
    } else if (e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export async function collect(opts: CollectOptions): Promise<string[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectsRoot = join(home, ".claude", "projects");
  let roots: string[];
  if (opts.scope === "all") {
    roots = [projectsRoot];
  } else {
    const cwd = opts.projectPath ?? process.cwd();
    roots = [join(projectsRoot, encodeProjectDir(cwd))];
  }
  const files: string[] = [];
  for (const root of roots) files.push(...(await walk(root)));
  const kept: string[] = [];
  for (const f of files) {
    const s = await stat(f);
    if (matchesSince(s.mtimeMs, opts.sinceDays, now)) kept.push(f);
  }
  return kept;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/collect.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add an integration test for `collect` against a temp dir**

Append to `src/core/collect.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, encodeProjectDir } from "./collect.js";

describe("collect", () => {
  it("finds project jsonl files and skips subagents", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const proj = join(home, ".claude", "projects", encodeProjectDir("/p/x"));
    await mkdir(join(proj, "subagents"), { recursive: true });
    await writeFile(join(proj, "a.jsonl"), "{}");
    await writeFile(join(proj, "subagents", "b.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.length).toBe(1);
    expect(files[0].endsWith("a.jsonl")).toBe(true);
  });
});
```

Run: `npx vitest run src/core/collect.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/collect.ts src/core/collect.test.ts
git commit -m "feat: transcript file discovery (collect)"
```

---

## Task 3: `parse.ts` — JSONL → Turn[]

**Files:**
- Create: `src/core/parse.ts`
- Test: `src/core/parse.test.ts`

**Interfaces:**
- Consumes: `Turn` from `types.ts`.
- Produces:
  - `parseLines(lines: string[]): Turn[]` (pure)
  - `parseFile(path: string): Promise<Turn[]>`

- [ ] **Step 1: Write the failing test** `src/core/parse.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseLines } from "./parse.js";

const userString = JSON.stringify({
  type: "user", isSidechain: false, sessionId: "s1", cwd: "/p/x",
  timestamp: "2026-06-01T00:00:00Z", gitBranch: "main",
  message: { role: "user", content: "fix the bug" },
});
const userArray = JSON.stringify({
  type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:01:00Z",
  message: { role: "user", content: [
    { type: "text", text: "do the thing" },
    { type: "tool_result", content: "ignored" },
  ] },
});
const toolResultOnly = JSON.stringify({
  type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:02:00Z",
  message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
});
const sidechain = JSON.stringify({
  type: "user", isSidechain: true, sessionId: "s1", cwd: "/p/x",
  timestamp: "2026-06-01T00:03:00Z", message: { role: "user", content: "agent prompt" },
});
const assistant = JSON.stringify({
  type: "assistant", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:04:00Z",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});

describe("parseLines", () => {
  it("extracts user string and text-array prompts", () => {
    const turns = parseLines([userString, userArray]);
    const texts = turns.map(t => t.text);
    expect(texts).toEqual(["fix the bug", "do the thing"]);
  });
  it("drops tool-result-only user turns, sidechains, and assistant turns", () => {
    const turns = parseLines([toolResultOnly, sidechain, assistant]);
    expect(turns.length).toBe(0);
  });
  it("skips malformed lines without throwing", () => {
    const turns = parseLines(["not json", "", userString]);
    expect(turns.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/parse.test.ts`
Expected: FAIL — cannot find module `./parse.js`.

- [ ] **Step 3: Implement** `src/core/parse.ts`

```ts
import { readFile } from "node:fs/promises";
import type { Turn } from "./types.js";

interface RawBlock { type?: string; text?: string }
interface Raw {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | RawBlock[] };
}

function project(cwd: string | undefined): string {
  if (!cwd) return "?";
  return cwd.split("/").filter(Boolean).pop() ?? "?";
}

// v1 parses only genuine user prompts; assistant turns are skipped on purpose.
function parseOne(line: string): Turn | null {
  let raw: Raw;
  try {
    raw = JSON.parse(line) as Raw;
  } catch {
    return null;
  }
  if (raw.isSidechain || raw.type !== "user") return null;
  const content = raw.message?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter(b => b.type === "text").map(b => b.text ?? "");
    text = parts.length ? parts.join(" ") : undefined;
  }
  if (!text) return null;
  return {
    ts: raw.timestamp ?? "",
    project: project(raw.cwd),
    branch: raw.gitBranch,
    sessionId: raw.sessionId ?? "?",
    role: "user",
    text,
  };
}

export function parseLines(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = parseOne(line);
    if (t) out.push(t);
  }
  return out;
}

export async function parseFile(path: string): Promise<Turn[]> {
  const content = await readFile(path, "utf8");
  return parseLines(content.split("\n"));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/parse.ts src/core/parse.test.ts
git commit -m "feat: JSONL transcript parsing (parse)"
```

---

## Task 4: `filter.ts` — strip injected text

**Files:**
- Create: `src/core/filter.ts`
- Test: `src/core/filter.test.ts`

**Interfaces:**
- Consumes: `Turn`.
- Produces: `filterPrompts(turns: Turn[]): Turn[]` — keeps only user turns whose text is genuinely typed (not hook/skill/system injected).

- [ ] **Step 1: Write the failing test** `src/core/filter.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { filterPrompts, isInjected } from "./filter.js";
import type { Turn } from "./types.js";

const u = (text: string): Turn => ({
  ts: "t", project: "p", role: "user", text, sessionId: "s",
});

describe("isInjected", () => {
  it("flags skill-loader and hook scaffolding", () => {
    expect(isInjected("Base directory for this skill: /x")).toBe(true);
    expect(isInjected("<command-name>/compact</command-name>")).toBe(true);
    expect(isInjected("<system-reminder>do x</system-reminder>")).toBe(true);
    expect(isInjected("Caveat: The messages below were generated")).toBe(true);
    expect(isInjected("[Request interrupted by user]")).toBe(true);
    expect(isInjected("local-command-stdout here")).toBe(true);
  });
  it("keeps genuine prompts", () => {
    expect(isInjected("push and create a pull request")).toBe(false);
  });
});

describe("filterPrompts", () => {
  it("drops injected, keeps genuine user prompts", () => {
    const turns = [u("Base directory for this skill: /x"), u("fix the bug"),
                   { ts: "t", project: "p", role: "user", sessionId: "s" } as Turn]; // no text → dropped
    const kept = filterPrompts(turns);
    expect(kept.map(t => t.text)).toEqual(["fix the bug"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/filter.test.ts`
Expected: FAIL — cannot find module `./filter.js`.

- [ ] **Step 3: Implement** `src/core/filter.ts`

```ts
import type { Turn } from "./types.js";

const INJECTED_PATTERNS: RegExp[] = [
  /^<command-(name|message|args)/i,
  /<system-reminder>/i,
  /<local-command-stdout/i,
  /local-command-stdout/i,
  /^Base directory for/i,
  /^Caveat:/i,
  /^\[Request interrupted/i,
  /^<[a-z-]+>/i, // any leading xml-ish tag block
];

export function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return INJECTED_PATTERNS.some(re => re.test(t));
}

export function filterPrompts(turns: Turn[]): Turn[] {
  return turns.filter(t => t.role === "user" && t.text !== undefined && !isInjected(t.text));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/filter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/filter.ts src/core/filter.test.ts
git commit -m "feat: filter injected hook/skill/system text (filter)"
```

---

## Task 5: `security.ts` — path/name/secret guards

**Files:**
- Create: `src/core/security.ts`
- Test: `src/core/security.test.ts`

**Interfaces:**
- Produces:
  - `assertInside(base: string, target: string): void` — throws if `target` resolves outside `base`
  - `sanitizeName(raw: string): string` — kebab, alnum + dashes, max 40 chars
  - `redact(text: string): string` — masks obvious secrets

- [ ] **Step 1: Write the failing test** `src/core/security.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { assertInside, sanitizeName, redact } from "./security.js";

describe("assertInside", () => {
  it("allows a path inside base", () => {
    expect(() => assertInside("/a/b", "/a/b/c.md")).not.toThrow();
  });
  it("rejects traversal outside base", () => {
    expect(() => assertInside("/a/b", "/a/b/../../etc/passwd")).toThrow();
  });
});

describe("sanitizeName", () => {
  it("kebab-cases and strips junk", () => {
    expect(sanitizeName("Ship It!! Now")).toBe("ship-it-now");
    expect(sanitizeName("merge/main")).toBe("merge-main");
  });
});

describe("redact", () => {
  it("masks api-key-like tokens and env assignments", () => {
    expect(redact("ANTHROPIC_API_KEY=sk-ant-abc123")).toContain("[REDACTED]");
    expect(redact("token sk-ant-api03-XXXXXXXXXXXX")).toContain("[REDACTED]");
  });
  it("leaves ordinary text untouched", () => {
    expect(redact("push and create a PR")).toBe("push and create a PR");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/security.test.ts`
Expected: FAIL — cannot find module `./security.js`.

- [ ] **Step 3: Implement** `src/core/security.ts`

```ts
import { resolve, relative, isAbsolute } from "node:path";

export function assertInside(base: string, target: string): void {
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${b}: ${t}`);
  }
}

export function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/g,
  /\bsk-ant-[A-Za-z0-9_-]{6,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/security.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/security.ts src/core/security.test.ts
git commit -m "feat: path containment, name sanitize, secret redaction (security)"
```

---

## Task 6: `cluster.ts` — local detection (pure)

**Files:**
- Create: `src/core/cluster.ts`
- Test: `src/core/cluster.test.ts`

**Interfaces:**
- Consumes: `Turn`, `Candidate`.
- Produces:
  - `normalize(s: string): string`
  - `similarity(a: string, b: string): number` (trigram Jaccard, 0..1)
  - `cluster(turns: Turn[], opts?: { minCount?: number; simThreshold?: number }): Candidate[]`

- [ ] **Step 1: Write the failing test** `src/core/cluster.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalize, similarity, cluster } from "./cluster.js";
import type { Turn } from "./types.js";

const u = (text: string, sessionId = "s"): Turn => ({ ts: "t", project: "p", role: "user", text, sessionId });

describe("normalize", () => {
  it("lowercases, trims, collapses ws, strips trailing punctuation", () => {
    expect(normalize("  Push  the PR!! ")).toBe("push the pr");
  });
});

describe("similarity", () => {
  it("is 1 for identical, <1 for different", () => {
    expect(similarity("push the pr", "push the pr")).toBe(1);
    expect(similarity("push the pr", "delete the file")).toBeLessThan(0.3);
  });
});

describe("cluster", () => {
  it("groups exact repeats as high-confidence candidates", () => {
    const turns = [u("continue", "s1"), u("continue.", "s2"), u("Continue", "s3")];
    const cands = cluster(turns, { minCount: 3 });
    const top = cands[0];
    expect(top.count).toBe(3);
    expect(top.sessions).toBe(3);
    expect(top.confidence).toBe("high");
  });
  it("ignores patterns below minCount", () => {
    const turns = [u("rare prompt one"), u("rare prompt two")];
    expect(cluster(turns, { minCount: 3 }).length).toBe(0);
  });
  it("merges near-duplicates into an inferred candidate", () => {
    const turns = [
      u("push and create a pull request", "s1"),
      u("push and create a pull request then", "s2"),
      u("push and create the pull request", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3, simThreshold: 0.5 });
    expect(cands.some(c => c.count >= 3 && c.confidence === "inferred")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/cluster.test.ts`
Expected: FAIL — cannot find module `./cluster.js`.

- [ ] **Step 3: Implement** `src/core/cluster.ts`

```ts
import type { Turn, Candidate, Confidence } from "./types.js";

export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "").trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Bucket { signature: string; examples: string[]; count: number; sessions: Set<string> }

export function cluster(
  turns: Turn[],
  opts: { minCount?: number; simThreshold?: number } = {},
): Candidate[] {
  const minCount = opts.minCount ?? 3;
  const simThreshold = opts.simThreshold ?? 0.6;

  // Stage 1: exact-normalized buckets.
  const exact = new Map<string, Bucket>();
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    const norm = normalize(t.text);
    if (norm.length < 2) continue;
    let b = exact.get(norm);
    if (!b) { b = { signature: norm, examples: [], count: 0, sessions: new Set() }; exact.set(norm, b); }
    b.count++;
    b.sessions.add(t.sessionId);
    if (b.examples.length < 5) b.examples.push(t.text);
  }

  // Stage 2: merge near-duplicate buckets (fuzzy).
  const buckets = [...exact.values()].sort((a, b) => b.count - a.count);
  const merged: Bucket[] = [];
  const fuzzyMember: boolean[] = [];
  for (const b of buckets) {
    const host = merged.find(m => similarity(m.signature, b.signature) >= simThreshold);
    if (host) {
      host.count += b.count;
      for (const s of b.sessions) host.sessions.add(s);
      for (const ex of b.examples) if (host.examples.length < 5) host.examples.push(ex);
      fuzzyMember[merged.indexOf(host)] = true;
    } else {
      merged.push({ ...b, sessions: new Set(b.sessions) });
      fuzzyMember[merged.length - 1] = false;
    }
  }

  const candidates: Candidate[] = [];
  merged.forEach((b, i) => {
    if (b.count < minCount) return;
    const confidence: Confidence = fuzzyMember[i] ? "inferred" : "high";
    candidates.push({
      kind: "unknown",
      signature: b.signature,
      examples: b.examples,
      count: b.count,
      sessions: b.sessions.size,
      confidence,
    });
  });
  return candidates.sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/cluster.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/cluster.ts src/core/cluster.test.ts
git commit -m "feat: local clustering with trigram similarity (cluster)"
```

---

## Task 7: LLM backends — interface + claude CLI + Anthropic + selector

**Files:**
- Create: `src/llm/backend.ts`, `src/llm/claudeCli.ts`, `src/llm/anthropic.ts`, `src/llm/index.ts`
- Test: `src/llm/claudeCli.test.ts`, `src/llm/index.test.ts`

**Interfaces:**
- Produces:
  - `interface LLMRequest { system: string; prompt: string }`
  - `interface LLMBackend { name: string; available(): Promise<boolean>; complete(req: LLMRequest): Promise<string> }`
  - `class ClaudeCliBackend` with injectable `spawnFn` + `whichFn`
  - `class AnthropicBackend` (uses `ANTHROPIC_API_KEY`)
  - `selectBackend(deps?): Promise<LLMBackend | null>`

- [ ] **Step 1: Write `src/llm/backend.ts`**

```ts
export interface LLMRequest {
  system: string;
  prompt: string;
}

export interface LLMBackend {
  name: string;
  available(): Promise<boolean>;
  complete(req: LLMRequest): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test** `src/llm/claudeCli.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { ClaudeCliBackend } from "./claudeCli.js";

function fakeSpawn(stdout: string, code = 0) {
  return () =>
    ({
      stdoutData: stdout,
      // minimal stub matching the shape claudeCli expects (see impl)
      async run() { return { code, stdout, stderr: "" }; },
    } as any);
}

describe("ClaudeCliBackend", () => {
  it("reports available when `claude` is on PATH", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => "/usr/bin/claude", runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(true);
  });
  it("reports unavailable when `claude` missing", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => null, runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(false);
  });
  it("extracts the .result field from --output-format json", async () => {
    const wrapper = JSON.stringify({ type: "result", result: '{"suggestions":[]}' });
    const b = new ClaudeCliBackend({
      whichFn: async () => "/usr/bin/claude",
      runFn: async () => ({ code: 0, stdout: wrapper, stderr: "" }),
    });
    expect(await b.complete({ system: "sys", prompt: "p" })).toBe('{"suggestions":[]}');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/llm/claudeCli.test.ts`
Expected: FAIL — cannot find module `./claudeCli.js`.

- [ ] **Step 4: Implement** `src/llm/claudeCli.ts`

```ts
import { spawn } from "node:child_process";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface RunResult { code: number; stdout: string; stderr: string }
type RunFn = (cmd: string, args: string[], input: string) => Promise<RunResult>;
type WhichFn = (bin: string) => Promise<string | null>;

const defaultRun: RunFn = (cmd, args, input) =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolveP({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });

const defaultWhich: WhichFn = (bin) =>
  new Promise((resolveP) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [bin]);
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.on("close", code => resolveP(code === 0 && out.trim() ? out.trim().split("\n")[0] : null));
    child.on("error", () => resolveP(null));
  });

export class ClaudeCliBackend implements LLMBackend {
  name = "claude-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;

  constructor(deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string } = {}) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
  }

  async available(): Promise<boolean> {
    return (await this.whichFn("claude")) !== null;
  }

  async complete(req: LLMRequest): Promise<string> {
    const args = ["-p", req.prompt, "--output-format", "json", "--append-system-prompt", req.system];
    if (this.model) args.push("--model", this.model);
    const { code, stdout, stderr } = await this.runFn("claude", args, "");
    if (code !== 0) throw new Error(`claude CLI failed (${code}): ${stderr}`);
    try {
      const wrapper = JSON.parse(stdout) as { result?: string };
      return wrapper.result ?? stdout;
    } catch {
      return stdout; // not wrapped — return raw
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/llm/claudeCli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Implement** `src/llm/anthropic.ts`

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { LLMBackend, LLMRequest } from "./backend.js";

export class AnthropicBackend implements LLMBackend {
  name = "anthropic";
  private model: string;
  private apiKey: string | undefined;

  constructor(deps: { apiKey?: string; model?: string } = {}) {
    this.apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = deps.model ?? "claude-sonnet-4-6";
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async complete(req: LLMRequest): Promise<string> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");
  }
}
```

- [ ] **Step 7: Write the selector test** `src/llm/index.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { selectBackend } from "./index.js";

const avail = (name: string, ok: boolean) =>
  ({ name, available: async () => ok, complete: async () => "" });

describe("selectBackend", () => {
  it("prefers claude-cli when available", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", true), avail("anthropic", true)] });
    expect(b?.name).toBe("claude-cli");
  });
  it("falls back to anthropic when claude-cli unavailable", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", false), avail("anthropic", true)] });
    expect(b?.name).toBe("anthropic");
  });
  it("returns null when none available", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", false), avail("anthropic", false)] });
    expect(b).toBeNull();
  });
});
```

- [ ] **Step 8: Implement** `src/llm/index.ts`

```ts
import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import type { Config } from "../core/types.js";

export async function selectBackend(
  deps: { candidates?: LLMBackend[]; config?: Config } = {},
): Promise<LLMBackend | null> {
  const candidates =
    deps.candidates ??
    [new ClaudeCliBackend({ model: deps.config?.model }), new AnthropicBackend({ model: deps.config?.model })];
  // honor explicit config.backend if set
  if (deps.config?.backend) {
    const chosen = candidates.find(c => c.name === deps.config!.backend);
    if (chosen && (await chosen.available())) return chosen;
  }
  for (const c of candidates) {
    if (await c.available()) return c;
  }
  return null;
}
```

- [ ] **Step 9: Run both LLM tests**

Run: `npx vitest run src/llm/`
Expected: PASS (6 tests across the two files).

- [ ] **Step 10: Commit**

```bash
git add src/llm/
git commit -m "feat: pluggable LLM backends (claude CLI + Anthropic) with selector"
```

---

## Task 8: `detect.ts` — candidates → suggestions

**Files:**
- Create: `src/core/detect.ts`
- Test: `src/core/detect.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Suggestion`, `LLMBackend`, `sanitizeName`, `normalize`.
- Produces:
  - `candidateToCommand(c: Candidate): Suggestion` (pure, no LLM — degradation path)
  - `buildDetectPrompt(cands: Candidate[]): { system: string; prompt: string }`
  - `detect(cands: Candidate[], llm: LLMBackend | null, opts?: { limit?: number; onCap?: (dropped: number) => void }): Promise<Suggestion[]>`

- [ ] **Step 1: Write the failing test** `src/core/detect.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { detect, candidateToCommand } from "./detect.js";
import type { Candidate } from "./types.js";

const cand = (signature: string, count: number, confidence: any = "high"): Candidate =>
  ({ kind: "unknown", signature, examples: [signature], count, sessions: count, confidence });

describe("candidateToCommand", () => {
  it("derives a slash-command suggestion from a high-confidence candidate", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.payload.type).toBe("command");
    if (s.payload.type === "command") expect(s.payload.commandName).toBe("merge-main-into");
    expect(s.confidence).toBe("high");
  });
});

describe("detect", () => {
  it("degrades to command suggestions when llm is null", async () => {
    const out = await detect([cand("merge main into this pr", 9), cand("fuzzy thing", 4, "inferred")], null);
    // only high-confidence becomes a suggestion without an LLM
    expect(out.length).toBe(1);
    expect(out[0].payload.type).toBe("command");
  });

  it("uses the llm result when available and traces evidence by sourceSignature", async () => {
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({
        suggestions: [{
          sourceSignature: "push and create a pr",
          name: "ship", title: "Ship", rationale: "r", confidence: "high",
          payload: { type: "command", commandName: "ship", body: "push and open a PR" },
        }],
      }),
    };
    const out = await detect([cand("push and create a pr", 13)], llm);
    expect(out[0].name).toBe("ship");
    expect(out[0].evidence.count).toBe(13);
  });

  it("redacts secrets in candidate examples before sending to the llm", async () => {
    let seenPrompt = "";
    const llm = {
      name: "fake", available: async () => true,
      complete: async (req: any) => { seenPrompt = req.prompt; return JSON.stringify({ suggestions: [] }); },
    };
    const c: Candidate = { kind: "unknown", signature: "deploy with token sk-ant-abc123def", examples: ["deploy with token sk-ant-abc123def"], count: 5, sessions: 3, confidence: "high" };
    await detect([c], llm);
    expect(seenPrompt).not.toContain("sk-ant-abc123def");
    expect(seenPrompt).toContain("[REDACTED]");
  });

  it("caps candidates and reports the drop", async () => {
    let dropped = -1;
    const many = Array.from({ length: 20 }, (_, i) => cand(`p${i}`, 20 - i));
    const llm = { name: "f", available: async () => true, complete: async () => JSON.stringify({ suggestions: [] }) };
    await detect(many, llm, { limit: 5, onCap: d => (dropped = d) });
    expect(dropped).toBe(15);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/detect.test.ts`
Expected: FAIL — cannot find module `./detect.js`.

- [ ] **Step 3: Implement** `src/core/detect.ts`

```ts
import { createHash } from "node:crypto";
import type { Candidate, Suggestion, Confidence } from "./types.js";
import { sanitizeName, redact } from "./security.js";
import type { LLMBackend } from "../llm/backend.js";

function idFor(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 10);
}

export function candidateToCommand(c: Candidate): Suggestion {
  const words = c.signature.split(" ").slice(0, 3).join(" ");
  const commandName = sanitizeName(words) || "command";
  return {
    id: idFor(c.signature),
    name: commandName,
    title: `Reusable command for "${c.signature}"`,
    rationale: `Repeated ${c.count}× across ${c.sessions} sessions.`,
    evidence: { count: c.count, sessions: c.sessions },
    confidence: c.confidence,
    payload: { type: "command", commandName, body: c.examples[0] ?? c.signature },
  };
}

export function buildDetectPrompt(cands: Candidate[]): { system: string; prompt: string } {
  const system =
    "You convert clusters of a developer's repeated Claude Code prompts into reusable artifacts. " +
    "For each cluster decide a type: 'command' (a repeated instruction → slash command), " +
    "'loop' (a recurring cadence task), or 'hook' (an automation tied to a Claude Code lifecycle event; " +
    "the only supported hook event is PreCompact backed by the gradient subcommand 'checkpoint'). " +
    "Echo back the cluster's exact 'signature' as 'sourceSignature' on each suggestion so it can be traced. " +
    "Respond ONLY with JSON: {\"suggestions\":[{sourceSignature,name,title,rationale,confidence,payload}]} where payload is one of " +
    "{type:'command',commandName,body} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description}.";
  // Redact secrets from examples/signatures before they ever leave the machine (spec §7).
  const prompt = JSON.stringify(
    cands.map(c => ({
      signature: redact(c.signature),
      count: c.count,
      sessions: c.sessions,
      examples: c.examples.map(redact),
      confidence: c.confidence,
    })),
    null, 2,
  );
  return { system, prompt };
}

interface LlmSuggestion {
  sourceSignature?: string;
  name: string; title: string; rationale: string; confidence: Confidence;
  payload: Suggestion["payload"];
}

export async function detect(
  cands: Candidate[],
  llm: LLMBackend | null,
  opts: { limit?: number; onCap?: (dropped: number) => void } = {},
): Promise<Suggestion[]> {
  const limit = opts.limit ?? 12;
  const ranked = [...cands].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, limit);
  if (ranked.length > limit) opts.onCap?.(ranked.length - limit);

  if (!llm) {
    // Degradation: only exact-repeat (high) candidates become command suggestions.
    return top.filter(c => c.confidence === "high").map(candidateToCommand);
  }

  const { system, prompt } = buildDetectPrompt(top);
  const raw = await llm.complete({ system, prompt });
  let parsed: { suggestions?: LlmSuggestion[] };
  try {
    parsed = JSON.parse(raw) as { suggestions?: LlmSuggestion[] };
  } catch {
    // LLM returned unparseable output — degrade rather than crash.
    return top.filter(c => c.confidence === "high").map(candidateToCommand);
  }
  // Match each suggestion back to its source cluster by signature (robust to reordering).
  const bySignature = new Map(top.map(c => [redact(c.signature), c]));
  return (parsed.suggestions ?? []).map(s => {
    const ev = (s.sourceSignature && bySignature.get(s.sourceSignature)) || top[0];
    return {
      id: idFor(s.payload.type === "command" ? s.payload.commandName : s.name),
      name: s.name,
      title: s.title,
      rationale: s.rationale,
      evidence: { count: ev?.count ?? 0, sessions: ev?.sessions ?? 0 },
      confidence: s.confidence,
      payload: s.payload,
    };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/detect.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/detect.ts src/core/detect.test.ts
git commit -m "feat: candidate→suggestion detection with no-LLM degradation (detect)"
```

---

## Task 9: `validate.ts` — schema + hook gate

**Files:**
- Create: `src/core/validate.ts`
- Test: `src/core/validate.test.ts`

**Interfaces:**
- Consumes: `Suggestion`.
- Produces:
  - `const KNOWN_SUBCOMMANDS: ReadonlySet<string>` (`"checkpoint"`)
  - `validateSuggestion(x: unknown): asserts x is Suggestion`
  - `assertHookRunnable(s: Suggestion): void`

- [ ] **Step 1: Write the failing test** `src/core/validate.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { validateSuggestion, assertHookRunnable, KNOWN_SUBCOMMANDS } from "./validate.js";
import type { Suggestion } from "./types.js";

const good: Suggestion = {
  id: "x", name: "ship", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "ship", body: "do it" },
};

describe("validateSuggestion", () => {
  it("accepts a well-formed suggestion", () => {
    expect(() => validateSuggestion(good)).not.toThrow();
  });
  it("rejects a missing payload", () => {
    expect(() => validateSuggestion({ ...good, payload: undefined })).toThrow();
  });
  it("rejects an unknown payload type", () => {
    expect(() => validateSuggestion({ ...good, payload: { type: "nope" } })).toThrow();
  });
});

describe("assertHookRunnable", () => {
  it("passes for a known subcommand", () => {
    const hook: Suggestion = { ...good, payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "d" } };
    expect(() => assertHookRunnable(hook)).not.toThrow();
  });
  it("throws for an unknown subcommand", () => {
    const hook: Suggestion = { ...good, payload: { type: "hook", event: "PreCompact", subcommand: "frobnicate", description: "d" } };
    expect(() => assertHookRunnable(hook)).toThrow();
  });
  it("exposes checkpoint as known", () => {
    expect(KNOWN_SUBCOMMANDS.has("checkpoint")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/validate.test.ts`
Expected: FAIL — cannot find module `./validate.js`.

- [ ] **Step 3: Implement** `src/core/validate.ts`

```ts
import type { Suggestion } from "./types.js";

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint"]);
const TYPES = new Set(["command", "loop", "hook"]);

export function validateSuggestion(x: unknown): asserts x is Suggestion {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("suggestion is not an object");
  for (const k of ["id", "name", "title", "rationale", "confidence"]) {
    if (typeof s[k] !== "string") throw new Error(`suggestion.${k} must be a string`);
  }
  const payload = s.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new Error("suggestion.payload missing");
  if (typeof payload.type !== "string" || !TYPES.has(payload.type)) {
    throw new Error(`invalid payload.type: ${String(payload.type)}`);
  }
  if (payload.type === "command" && typeof payload.commandName !== "string") {
    throw new Error("command payload needs commandName");
  }
  if (payload.type === "hook") {
    if (typeof payload.event !== "string" || typeof payload.subcommand !== "string") {
      throw new Error("hook payload needs event + subcommand");
    }
  }
}

export function assertHookRunnable(s: Suggestion): void {
  if (s.payload.type !== "hook") return;
  if (!KNOWN_SUBCOMMANDS.has(s.payload.subcommand)) {
    throw new Error(`hook references unknown gradient subcommand: ${s.payload.subcommand}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/validate.ts src/core/validate.test.ts
git commit -m "feat: suggestion schema validation + hook subcommand gate (validate)"
```

---

## Task 10: `emit/*` — artifact formatting

**Files:**
- Create: `src/core/emit/command.ts`, `src/core/emit/loop.ts`, `src/core/emit/hook.ts`, `src/core/emit/index.ts`
- Test: `src/core/emit/emit.test.ts`

**Interfaces:**
- Consumes: `Suggestion`, `assertHookRunnable`.
- Produces:
  - `emitCommand(s): { path: string; content: string }`
  - `emitLoop(s): { command: string }`
  - `emitHook(s): { settingsPatch: string }`
  - `type EmitResult = { kind: "command"; path: string; content: string } | { kind: "loop"; command: string } | { kind: "hook"; settingsPatch: string }`
  - `emit(s: Suggestion): EmitResult`

- [ ] **Step 1: Write the failing test** `src/core/emit/emit.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { emit } from "./index.js";
import type { Suggestion } from "../types.js";

const base = { id: "x", title: "t", rationale: "r", evidence: { count: 3, sessions: 2 }, confidence: "high" as const };

describe("emit", () => {
  it("emits a command markdown file under .claude/commands", () => {
    const s: Suggestion = { ...base, name: "ship", payload: { type: "command", commandName: "ship", body: "Push and open a PR." } };
    const r = emit(s);
    if (r.kind !== "command") throw new Error("wrong kind");
    expect(r.path).toBe(".claude/commands/ship.md");
    expect(r.content).toContain("---");
    expect(r.content).toContain("Push and open a PR.");
  });
  it("emits a runnable loop line", () => {
    const s: Suggestion = { ...base, name: "cont", payload: { type: "loop", instruction: "continue until done" } };
    const r = emit(s);
    if (r.kind !== "loop") throw new Error("wrong kind");
    expect(r.command).toContain("/loop");
    expect(r.command).toContain("continue until done");
  });
  it("emits a settings.json patch that calls a gradient subcommand", () => {
    const s: Suggestion = { ...base, name: "ckpt", payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "save first" } };
    const r = emit(s);
    if (r.kind !== "hook") throw new Error("wrong kind");
    expect(r.settingsPatch).toContain("PreCompact");
    expect(r.settingsPatch).toContain("gradient checkpoint");
  });
  it("refuses to emit a hook with an unknown subcommand", () => {
    const s: Suggestion = { ...base, name: "bad", payload: { type: "hook", event: "PreCompact", subcommand: "rm-rf", description: "x" } };
    expect(() => emit(s)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/emit/emit.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Implement** `src/core/emit/command.ts`

```ts
import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

export function emitCommand(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitCommand needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const content = `---\ndescription: ${s.title}\n---\n${s.payload.body}\n`;
  return { path: `.claude/commands/${name}.md`, content };
}
```

- [ ] **Step 4: Implement** `src/core/emit/loop.ts`

```ts
import type { Suggestion } from "../types.js";

export function emitLoop(s: Suggestion): { command: string } {
  if (s.payload.type !== "loop") throw new Error("emitLoop needs a loop payload");
  const verb = s.payload.cadence ? "/schedule" : "/loop";
  const cadence = s.payload.cadence ? `${s.payload.cadence} ` : "";
  return { command: `${verb} ${cadence}"${s.payload.instruction}"` };
}
```

- [ ] **Step 5: Implement** `src/core/emit/hook.ts`

```ts
import type { Suggestion } from "../types.js";
import { assertHookRunnable } from "../validate.js";

export function emitHook(s: Suggestion): { settingsPatch: string } {
  if (s.payload.type !== "hook") throw new Error("emitHook needs a hook payload");
  assertHookRunnable(s);
  const patch = {
    hooks: {
      [s.payload.event]: [
        { hooks: [{ type: "command", command: `gradient ${s.payload.subcommand}` }] },
      ],
    },
  };
  return { settingsPatch: JSON.stringify(patch, null, 2) };
}
```

- [ ] **Step 6: Implement** `src/core/emit/index.ts`

```ts
import type { Suggestion } from "../types.js";
import { emitCommand } from "./command.js";
import { emitLoop } from "./loop.js";
import { emitHook } from "./hook.js";

export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string };

export function emit(s: Suggestion): EmitResult {
  switch (s.payload.type) {
    case "command": return { kind: "command", ...emitCommand(s) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
  }
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/core/emit/emit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/core/emit/
git commit -m "feat: artifact emitters for command/loop/hook (emit)"
```

---

## Task 11: `manifest.ts` + `config.ts`

**Files:**
- Create: `src/core/manifest.ts`, `src/config.ts`
- Test: `src/core/manifest.test.ts`, `src/config.test.ts`

**Interfaces:**
- Produces:
  - `gradientDir(projectDir: string): string` → `<projectDir>/.gradient`
  - `loadManifest(projectDir): Promise<ManifestEntry[]>`
  - `addEntry(projectDir, e: ManifestEntry): Promise<void>` (replaces same-name entry)
  - `removeEntry(projectDir, name): Promise<ManifestEntry | undefined>`
  - `configPath(home?): string`, `loadConfig(home?): Promise<Config>`, `saveConfig(c, home?): Promise<void>`

- [ ] **Step 1: Write the failing test** `src/core/manifest.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, addEntry, removeEntry } from "./manifest.js";
import type { ManifestEntry } from "./types.js";

const entry = (name: string): ManifestEntry =>
  ({ name, type: "command", path: `.claude/commands/${name}.md`, createdAt: "2026-06-29", suggestionId: name });

describe("manifest", () => {
  it("adds, lists, replaces, and removes entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadManifest(dir)).toEqual([]);
    await addEntry(dir, entry("ship"));
    await addEntry(dir, entry("ship")); // replace, not duplicate
    expect((await loadManifest(dir)).length).toBe(1);
    const removed = await removeEntry(dir, "ship");
    expect(removed?.name).toBe("ship");
    expect(await loadManifest(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/manifest.test.ts`
Expected: FAIL — cannot find module `./manifest.js`.

- [ ] **Step 3: Implement** `src/core/manifest.ts`

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry } from "./types.js";

export function gradientDir(projectDir: string): string {
  return join(projectDir, ".gradient");
}

function manifestPath(projectDir: string): string {
  return join(gradientDir(projectDir), "manifest.json");
}

export async function loadManifest(projectDir: string): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await readFile(manifestPath(projectDir), "utf8")) as ManifestEntry[];
  } catch {
    return [];
  }
}

async function save(projectDir: string, entries: ManifestEntry[]): Promise<void> {
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(manifestPath(projectDir), JSON.stringify(entries, null, 2));
}

export async function addEntry(projectDir: string, e: ManifestEntry): Promise<void> {
  const entries = (await loadManifest(projectDir)).filter(x => x.name !== e.name);
  entries.push(e);
  await save(projectDir, entries);
}

export async function removeEntry(projectDir: string, name: string): Promise<ManifestEntry | undefined> {
  const entries = await loadManifest(projectDir);
  const found = entries.find(x => x.name === name);
  if (!found) return undefined;
  await save(projectDir, entries.filter(x => x.name !== name));
  return found;
}
```

- [ ] **Step 4: Write + run the config test** `src/config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";

describe("config", () => {
  it("round-trips config under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadConfig(home)).toEqual({});
    await saveConfig({ backend: "claude-cli", model: "claude-sonnet-4-6" }, home);
    expect(await loadConfig(home)).toEqual({ backend: "claude-cli", model: "claude-sonnet-4-6" });
  });
});
```

- [ ] **Step 5: Implement** `src/config.ts`

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./core/types.js";

export function configPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "config.json");
}

export async function loadConfig(home?: string): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(home), "utf8")) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(c: Config, home?: string): Promise<void> {
  const p = configPath(home);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(c, null, 2));
}
```

- [ ] **Step 6: Run to verify both pass**

Run: `npx vitest run src/core/manifest.test.ts src/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/manifest.ts src/core/manifest.test.ts src/config.ts src/config.test.ts
git commit -m "feat: reversible manifest + config persistence"
```

---

## Task 12: `apply.ts` — write an approved suggestion

**Files:**
- Create: `src/core/apply.ts`
- Test: `src/core/apply.test.ts`

**Interfaces:**
- Consumes: `Suggestion`, `emit`, `assertInside`, `addEntry`.
- Produces:
  - `interface ApplyResult { suggestion: Suggestion; written?: string; printed?: string }`
  - `applySuggestion(s: Suggestion, projectDir: string): Promise<ApplyResult>`

- [ ] **Step 1: Write the failing test** `src/core/apply.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion } from "./apply.js";
import { loadManifest } from "./manifest.js";
import type { Suggestion } from "./types.js";

const base = { id: "x", title: "t", rationale: "r", evidence: { count: 3, sessions: 2 }, confidence: "high" as const };

describe("applySuggestion", () => {
  it("writes a command file and records it in the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, name: "ship", payload: { type: "command", commandName: "ship", body: "do it" } };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBe(join(dir, ".claude/commands/ship.md"));
    expect(await readFile(r.written!, "utf8")).toContain("do it");
    expect((await loadManifest(dir)).map(e => e.name)).toEqual(["ship"]);
  });
  it("prints (does not write) a loop suggestion but still records it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, name: "cont", payload: { type: "loop", instruction: "continue until done" } };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBeUndefined();
    expect(r.printed).toContain("/loop");
    expect((await loadManifest(dir)).map(e => e.name)).toEqual(["cont"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/apply.test.ts`
Expected: FAIL — cannot find module `./apply.js`.

- [ ] **Step 3: Implement** `src/core/apply.ts`

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Suggestion, ManifestEntry, ArtifactType } from "./types.js";
import { emit } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry } from "./manifest.js";

export interface ApplyResult {
  suggestion: Suggestion;
  written?: string;
  printed?: string;
}

export async function applySuggestion(s: Suggestion, projectDir: string): Promise<ApplyResult> {
  const result = emit(s);
  const type = s.payload.type as ArtifactType;
  let written: string | undefined;
  let printed: string | undefined;

  if (result.kind === "command") {
    const abs = join(projectDir, result.path);
    assertInside(join(projectDir, ".claude"), abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, result.content);
    written = abs;
  } else if (result.kind === "loop") {
    printed = result.command;
  } else {
    printed = result.settingsPatch; // hooks are surfaced for the user to approve into settings.json
  }

  const entry: ManifestEntry = {
    name: s.name,
    type,
    path: written ?? "",
    createdAt: new Date().toISOString().slice(0, 10),
    suggestionId: s.id,
  };
  await addEntry(projectDir, entry);
  return { suggestion: s, written, printed };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/apply.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/apply.ts src/core/apply.test.ts
git commit -m "feat: apply an approved suggestion (write + manifest)"
```

---

## Task 13: `commands/scan.ts` — pipeline orchestration

**Files:**
- Create: `src/commands/scan.ts`
- Test: `src/commands/scan.test.ts`

**Interfaces:**
- Consumes: `collect`, `parseFile`, `filterPrompts`, `cluster`, `detect`, `validateSuggestion`, `selectBackend`, `gradientDir`.
- Produces:
  - `interface ScanOptions { scope: "project" | "all"; projectPath?: string; sinceDays?: number; limit?: number; home?: string }`
  - `interface ScanDeps { backend?: LLMBackend | null; collectFn?; parseFn? }`
  - `scan(opts: ScanOptions, deps?: ScanDeps): Promise<Suggestion[]>` — writes `.gradient/suggestions.json`

- [ ] **Step 1: Write the failing test** `src/commands/scan.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./scan.js";

const userLine = (text: string, session: string) => JSON.stringify({
  type: "user", isSidechain: false, sessionId: session, cwd: "/p/x",
  timestamp: "2026-06-01T00:00:00Z", message: { role: "user", content: text },
});

describe("scan", () => {
  it("runs the pipeline with a mock backend and caches suggestions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignature: "push and create a pull request",
        name: "ship", title: "Ship", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "ship", body: "push and open a PR" },
      }] }),
    };
    const out = await scan(
      { scope: "project", projectPath: projectDir },
      {
        backend: fakeBackend,
        collectFn: async () => ["fake.jsonl"],
        parseFn: async () => [
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s1" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s2" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s3" },
        ],
      },
    );
    expect(out[0].name).toBe("ship");
    const cached = JSON.parse(await readFile(join(projectDir, ".gradient", "suggestions.json"), "utf8"));
    expect(cached.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/scan.test.ts`
Expected: FAIL — cannot find module `./scan.js`.

- [ ] **Step 3: Implement** `src/commands/scan.ts`

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, Turn } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { cluster } from "../core/cluster.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { gradientDir } from "../core/manifest.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";

export interface ScanOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  limit?: number;
  home?: string;
}

export interface ScanDeps {
  backend?: LLMBackend | null;
  collectFn?: (o: ScanOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  log?: (msg: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const collectFn = deps.collectFn ?? ((o: ScanOptions) => collect(o));
  const parseFn = deps.parseFn ?? parseFile;

  const files = await collectFn(opts);
  log(`files: ${files.length} transcripts`);
  const turns: Turn[] = [];
  for (const f of files) turns.push(...(await parseFn(f)));

  const prompts = filterPrompts(turns);
  log(`prompts: ${prompts.length} after filtering injected text`);

  const candidates = cluster(prompts);
  log(`clustering → ${candidates.length} candidate patterns`);

  const backend =
    deps.backend !== undefined ? deps.backend : await selectBackend({ config: await loadConfig(opts.home) });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");

  const suggestions = await detect(candidates, backend, {
    limit: opts.limit ?? 12,
    onCap: dropped => log(`capped to top ${opts.limit ?? 12}; ${dropped} lower-frequency candidates dropped`),
  });
  for (const s of suggestions) validateSuggestion(s);

  const projectDir = opts.projectPath ?? process.cwd();
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(join(gradientDir(projectDir), "suggestions.json"), JSON.stringify(suggestions, null, 2));
  log(`found ${suggestions.length} suggestions → cached`);
  return suggestions;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/commands/scan.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/commands/scan.ts src/commands/scan.test.ts
git commit -m "feat: scan command orchestrating the detection pipeline"
```

---

## Task 14: management commands — `apply`, `list`, `remove`

**Files:**
- Create: `src/commands/apply.ts`, `src/commands/list.ts`, `src/commands/remove.ts`
- Test: `src/commands/manage.test.ts`

**Interfaces:**
- Consumes: `applySuggestion`, `loadManifest`, `removeEntry`, `Suggestion`.
- Produces:
  - `loadSuggestions(projectDir): Promise<Suggestion[]>` (reads `.gradient/suggestions.json`)
  - `applyByIds(ids: string[], projectDir): Promise<ApplyResult[]>`
  - `list(projectDir): Promise<ManifestEntry[]>`
  - `remove(projectDir, name): Promise<boolean>` (also unlinks the file if present)

- [ ] **Step 1: Write the failing test** `src/commands/manage.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyByIds } from "./apply.js";
import { list } from "./list.js";
import { remove } from "./remove.js";
import type { Suggestion } from "../core/types.js";

const ship: Suggestion = {
  id: "id-ship", name: "ship", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "ship", body: "do it" },
};

async function seed(dir: string) {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([ship]));
}

describe("manage commands", () => {
  it("applies by id, lists, then removes (unlinking the file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await seed(dir);
    const applied = await applyByIds(["id-ship"], dir);
    expect(applied.length).toBe(1);
    expect((await list(dir)).map(e => e.name)).toEqual(["ship"]);
    const ok = await remove(dir, "ship");
    expect(ok).toBe(true);
    await expect(access(join(dir, ".claude/commands/ship.md"))).rejects.toThrow();
    expect(await list(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/manage.test.ts`
Expected: FAIL — cannot find module `./apply.js`.

- [ ] **Step 3: Implement** `src/commands/apply.ts`

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion } from "../core/types.js";
import { gradientDir } from "../core/manifest.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";

export async function loadSuggestions(projectDir: string): Promise<Suggestion[]> {
  try {
    return JSON.parse(await readFile(join(gradientDir(projectDir), "suggestions.json"), "utf8")) as Suggestion[];
  } catch {
    return [];
  }
}

export async function applyByIds(ids: string[], projectDir: string): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir);
  const wanted = all.filter(s => ids.includes(s.id) || ids.includes(s.name));
  const out: ApplyResult[] = [];
  for (const s of wanted) out.push(await applySuggestion(s, projectDir));
  return out;
}
```

- [ ] **Step 4: Implement** `src/commands/list.ts`

```ts
import type { ManifestEntry } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";

export async function list(projectDir: string): Promise<ManifestEntry[]> {
  return loadManifest(projectDir);
}
```

- [ ] **Step 5: Implement** `src/commands/remove.ts`

```ts
import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { removeEntry } from "../core/manifest.js";

export async function remove(projectDir: string, name: string): Promise<boolean> {
  const entry = await removeEntry(projectDir, name);
  if (!entry) return false;
  if (entry.path) {
    const abs = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    try { await unlink(abs); } catch { /* already gone */ }
  }
  return true;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/commands/manage.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/commands/apply.ts src/commands/list.ts src/commands/remove.ts src/commands/manage.test.ts
git commit -m "feat: apply/list/remove management commands"
```

---

## Task 15: `commands/checkpoint.ts` — hook helper

**Files:**
- Create: `src/commands/checkpoint.ts`
- Test: `src/commands/checkpoint.test.ts`

**Interfaces:**
- Consumes: `parseFile`, `filterPrompts`.
- Produces:
  - `interface CheckpointInput { transcript_path?: string }`
  - `checkpoint(input: CheckpointInput, projectDir: string, parseFn?): Promise<string>` — writes `progress.md`, returns its path. Reads PreCompact hook stdin shape.

- [ ] **Step 1: Write the failing test** `src/commands/checkpoint.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.js";

describe("checkpoint", () => {
  it("writes a progress.md from recent user prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const path = await checkpoint(
      { transcript_path: "ignored.jsonl" },
      dir,
      async () => [
        { ts: "t1", project: "x", role: "user", text: "implement the parser", sessionId: "s" },
        { ts: "t2", project: "x", role: "user", text: "now add tests", sessionId: "s" },
      ],
    );
    expect(path).toBe(join(dir, "progress.md"));
    const md = await readFile(path, "utf8");
    expect(md).toContain("now add tests");
    expect(md).toContain("# Progress checkpoint");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/checkpoint.test.ts`
Expected: FAIL — cannot find module `./checkpoint.js`.

- [ ] **Step 3: Implement** `src/commands/checkpoint.ts`

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Turn } from "../core/types.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";

export interface CheckpointInput { transcript_path?: string }

export async function checkpoint(
  input: CheckpointInput,
  projectDir: string,
  parseFn: (path: string) => Promise<Turn[]> = parseFile,
): Promise<string> {
  const turns = input.transcript_path ? await parseFn(input.transcript_path) : [];
  const prompts = filterPrompts(turns).slice(-10);
  const lines = prompts.map(p => `- ${p.text}`).join("\n");
  const md = `# Progress checkpoint\n\nRecent intents before compaction:\n\n${lines}\n`;
  const path = join(projectDir, "progress.md");
  await writeFile(path, md);
  return path;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/commands/checkpoint.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/commands/checkpoint.ts src/commands/checkpoint.test.ts
git commit -m "feat: checkpoint hook-helper writes progress.md"
```

---

## Task 16: `commands/init.ts` + `skill/SKILL.md`

**Files:**
- Create: `src/commands/init.ts`, `src/skill/SKILL.md`
- Test: `src/commands/init.test.ts`

**Interfaces:**
- Consumes: `saveConfig`, `selectBackend`.
- Produces:
  - `interface InitResult { backend: string; configPath: string; skillInstalled: boolean }`
  - `init(opts: { installSkill: boolean; home?: string }, deps?: { backend?: LLMBackend | null; skillSource?: string }): Promise<InitResult>`

- [ ] **Step 1: Create `src/skill/SKILL.md`**

```markdown
---
name: gradient
description: Use when the user wants to find repeated Claude Code workflows and turn them into slash commands, loops, or hooks. Runs the gradient CLI to scan transcripts and propose artifacts.
---

# /gradient

Mine your Claude Code history for things you repeat, and generate reusable
artifacts you approve.

## Usage

Run the CLI and show the user the results:

- `gradient scan` — analyze recent history, print + cache suggestions (read-only).
- `gradient review` — walk through cached suggestions and approve them.
- `gradient apply <id>` — generate a specific suggestion non-interactively.
- `gradient list` / `gradient remove <name>` — manage what was generated.

Always run `gradient scan` first, summarize the suggestions for the user, and
let them choose which to apply. Never apply without explicit approval.
```

- [ ] **Step 2: Write the failing test** `src/commands/init.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";

describe("init", () => {
  it("writes config and installs the skill under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const r = await init(
      { installSkill: true, home },
      { backend: { name: "claude-cli", available: async () => true, complete: async () => "" }, skillSource: "# fake skill\n" },
    );
    expect(r.backend).toBe("claude-cli");
    expect(r.skillInstalled).toBe(true);
    const cfg = JSON.parse(await readFile(join(home, ".config/gradient/config.json"), "utf8"));
    expect(cfg.backend).toBe("claude-cli");
    const skill = await readFile(join(home, ".claude/skills/gradient/SKILL.md"), "utf8");
    expect(skill).toContain("fake skill");
  });
  it("reports no backend without throwing", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const r = await init({ installSkill: false, home }, { backend: null, skillSource: "x" });
    expect(r.backend).toBe("none");
    expect(r.skillInstalled).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/commands/init.test.ts`
Expected: FAIL — cannot find module `./init.js`.

- [ ] **Step 4: Implement** `src/commands/init.ts`

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../config.js";
import { selectBackend } from "../llm/index.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";

export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
}

async function defaultSkillSource(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsc does not copy .md into dist/. The published package ships both `dist` and
  // `src/skill` (package.json "files"), so resolve to the source markdown:
  // <pkg>/dist/commands/init.js → <pkg>/src/skill/SKILL.md
  return readFile(join(here, "..", "..", "src", "skill", "SKILL.md"), "utf8");
}

export async function init(
  opts: { installSkill: boolean; home?: string },
  deps: { backend?: LLMBackend | null; skillSource?: string } = {},
): Promise<InitResult> {
  const home = opts.home ?? homedir();
  const backend = deps.backend !== undefined ? deps.backend : await selectBackend();
  const backendName = backend?.name ?? "none";

  const config: Config = backend ? { backend: backend.name as Config["backend"] } : {};
  await saveConfig(config, home);

  let skillInstalled = false;
  if (opts.installSkill) {
    const source = deps.skillSource ?? (await defaultSkillSource());
    const dest = join(home, ".claude", "skills", "gradient", "SKILL.md");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, source);
    skillInstalled = true;
  }

  return { backend: backendName, configPath: join(home, ".config/gradient/config.json"), skillInstalled };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/commands/init.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/skill/SKILL.md src/commands/init.test.ts
git commit -m "feat: init command + /gradient skill template"
```

---

## Task 17: `commands/review.ts` — interactive approval

**Files:**
- Create: `src/commands/review.ts`
- Test: `src/commands/review.test.ts`

**Interfaces:**
- Consumes: `loadSuggestions`, `applySuggestion`, `Suggestion`.
- Produces:
  - `type Prompter = (s: Suggestion, index: number, total: number) => Promise<"approve" | "skip" | "quit">`
  - `review(projectDir: string, prompt: Prompter): Promise<ApplyResult[]>`
  - `readlinePrompter(): Prompter` (thin `node:readline` wrapper, not unit-tested)

- [ ] **Step 1: Write the failing test** `src/commands/review.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "./review.js";
import type { Suggestion } from "../core/types.js";

const mk = (name: string): Suggestion => ({
  id: `id-${name}`, name, title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: name, body: "do it" },
});

async function seed(dir: string, names: string[]) {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(names.map(mk)));
}

describe("review", () => {
  it("approves selectively and stops on quit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await seed(dir, ["ship", "plan", "next"]);
    const answers: Record<string, "approve" | "skip" | "quit"> = { ship: "approve", plan: "skip", next: "quit" };
    const applied = await review(dir, async (s) => answers[s.name]);
    expect(applied.map(a => a.suggestion.name)).toEqual(["ship"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/review.test.ts`
Expected: FAIL — cannot find module `./review.js`.

- [ ] **Step 3: Implement** `src/commands/review.ts`

```ts
import { createInterface } from "node:readline/promises";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadSuggestions } from "./apply.js";

export type Prompter = (s: Suggestion, index: number, total: number) => Promise<"approve" | "skip" | "quit">;

export async function review(projectDir: string, prompt: Prompter): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir);
  const out: ApplyResult[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const decision = await prompt(suggestions[i], i, suggestions.length);
    if (decision === "quit") break;
    if (decision === "approve") out.push(await applySuggestion(suggestions[i], projectDir));
  }
  return out;
}

export function readlinePrompter(): Prompter {
  return async (s, index, total) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const label = s.payload.type;
    process.stdout.write(
      `\n(${index + 1}/${total})  ${s.name} · ${label} · seen ${s.evidence.count}× · ${s.confidence}\n  ${s.title}\n`,
    );
    const ans = (await rl.question("  [a]pprove [s]kip [q]uit › ")).trim().toLowerCase();
    rl.close();
    if (ans === "a") return "approve";
    if (ans === "q") return "quit";
    return "skip";
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/commands/review.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/commands/review.ts src/commands/review.test.ts
git commit -m "feat: interactive review with injectable prompter"
```

---

## Task 18: `cli.ts` — arg parsing + dispatch, and end-to-end wiring

**Files:**
- Create: `src/cli.ts`, `README.md`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: every command module.
- Produces:
  - `parseCliArgs(argv: string[]): { command: string; positionals: string[]; flags: Record<string, string | boolean> }`
  - `main(argv: string[], io?: { log?: (s: string) => void }): Promise<number>` (exit code)

- [ ] **Step 1: Write the failing test** `src/cli.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseCliArgs, main } from "./cli.js";

describe("parseCliArgs", () => {
  it("parses command, flags, and positionals", () => {
    const r = parseCliArgs(["scan", "--all", "--since", "7d"]);
    expect(r.command).toBe("scan");
    expect(r.flags.all).toBe(true);
    expect(r.flags.since).toBe("7d");
  });
});

describe("main", () => {
  it("returns 0 and prints help for no command", async () => {
    const logs: string[] = [];
    const code = await main([], { log: m => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("gradient");
  });
  it("returns 2 for an unknown command", async () => {
    const logs: string[] = [];
    const code = await main(["wat"], { log: m => logs.push(m) });
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cli.test.ts`
Expected: FAIL — cannot find module `./cli.js`.

- [ ] **Step 3: Implement** `src/cli.ts`

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { scan } from "./commands/scan.js";
import { review, readlinePrompter } from "./commands/review.js";
import { applyByIds } from "./commands/apply.js";
import { list } from "./commands/list.js";
import { remove } from "./commands/remove.js";
import { init } from "./commands/init.js";
import { checkpoint } from "./commands/checkpoint.js";

const HELP = `gradient — turn repeated Claude Code workflows into artifacts

Usage:
  gradient init                 configure + install the /gradient skill
  gradient scan [--all] [--since 7d] [--limit N]
  gradient review               approve cached suggestions
  gradient apply <id|name>...   generate specific suggestions
  gradient list                 show generated artifacts
  gradient remove <name>        delete a generated artifact
`;

export function parseCliArgs(argv: string[]) {
  const command = argv[0] ?? "";
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      since: { type: "string" },
      limit: { type: "string" },
      "no-skill": { type: "boolean" },
    },
  });
  return { command, positionals, flags: values as Record<string, string | boolean> };
}

function sinceDays(flag: string | boolean | undefined): number | undefined {
  if (typeof flag !== "string") return undefined;
  const m = /^(\d+)d?$/.exec(flag.trim());
  return m ? Number(m[1]) : undefined;
}

export async function main(argv: string[], io: { log?: (s: string) => void } = {}): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));
  if (argv.length === 0) { log(HELP); return 0; }
  const { command, positionals, flags } = parseCliArgs(argv);
  const projectDir = process.cwd();

  switch (command) {
    case "init": {
      const r = await init({ installSkill: !flags["no-skill"] });
      log(`backend: ${r.backend}\nconfig: ${r.configPath}\nskill installed: ${r.skillInstalled}`);
      return 0;
    }
    case "scan": {
      const out = await scan(
        { scope: flags.all ? "all" : "project", projectPath: projectDir, sinceDays: sinceDays(flags.since), limit: flags.limit ? Number(flags.limit) : undefined },
        { log },
      );
      for (const s of out) log(`  ${s.confidence === "high" ? "●" : "○"} ${s.name}  ${s.title}  (seen ${s.evidence.count}×)`);
      log(`\nNext: gradient review`);
      return 0;
    }
    case "review": {
      const applied = await review(projectDir, readlinePrompter());
      log(`\napplied ${applied.length} suggestion(s).`);
      for (const a of applied) if (a.printed) log(`  run: ${a.printed}`);
      return 0;
    }
    case "apply": {
      const applied = await applyByIds(positionals, projectDir);
      for (const a of applied) log(a.written ? `wrote ${a.written}` : `run: ${a.printed}`);
      return 0;
    }
    case "list": {
      for (const e of await list(projectDir)) log(`  ${e.name}\t${e.type}\t${e.path || "(printed)"}\t${e.createdAt}`);
      return 0;
    }
    case "remove": {
      const ok = await remove(projectDir, positionals[0]);
      log(ok ? `removed ${positionals[0]}` : `no such artifact: ${positionals[0]}`);
      return ok ? 0 : 1;
    }
    case "checkpoint": {
      // invoked by the PreCompact hook; reads hook JSON from stdin
      const input = await readStdinJson();
      const path = await checkpoint(input, projectDir);
      log(`checkpoint written: ${path}`);
      return 0;
    }
    default:
      log(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function readStdinJson(): Promise<{ transcript_path?: string }> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
}

// Entry point when run as a binary.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full build + test + typecheck gate**

Run: `npm run build && npm run typecheck && npm test`
Expected: build emits `dist/`, typecheck clean, all tests pass.

- [ ] **Step 6: Smoke-test the built binary against your real history (read-only)**

Run: `node dist/cli.js scan --since 7d`
Expected: prints file/prompt counts and a suggestion list (or the no-backend degradation notice). No files written outside `.gradient/`.

- [ ] **Step 7: Write `README.md`**

```markdown
# gradient

Turn the things you repeat in Claude Code into slash commands, loops, and hooks.

```bash
npx gradient init      # configure (reuses your `claude` auth — no API key needed)
npx gradient scan      # read-only: find repeated workflows in your history
npx gradient review    # approve the ones you want; gradient writes the artifacts
npx gradient list      # see what it generated   ·   npx gradient remove <name> to undo
```

Everything `scan` finds is cached in `.gradient/`. Nothing is written until you
approve it in `review`, and everything written is tracked in `.gradient/manifest.json`
so `remove` cleanly undoes it.

## How it works
1. Reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
2. Clusters repeated prompts locally (no LLM) → candidate patterns.
3. Sends only the top candidates to an LLM (the `claude` CLI by default) to name
   and type them into suggestions.
4. You approve; it writes `.claude/commands/*.md`, prints `/loop` lines, or proposes
   `settings.json` hooks that call `gradient` subcommands.
```

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/cli.test.ts README.md
git commit -m "feat: CLI dispatch, end-to-end wiring, and README"
```

---

## Self-Review

(Completed by the plan author against the spec — see the chat summary for the principal-engineer critique and revisions applied.)

- **Spec coverage:** scan/review/apply/list/remove/init/checkpoint all mapped to tasks; three artifact types (command/loop/hook) in Task 10; claude-CLI + Anthropic backends in Task 7; local-cluster-then-LLM in Tasks 6+8; manifest reversibility in Tasks 11/12/14; redaction + path containment in Task 5; hook-calls-subcommand gate in Tasks 9/10.
- **Out of scope honored:** no MCP, no autopilot loop, no stats/explain, no embeddings, Claude Code only.
- **Type consistency:** `Suggestion.payload` (not `artifact`) is the single source of artifact content across detect → validate → emit → apply; `ManifestEntry.path` is `""` for loops; `LLMBackend` shape identical across Tasks 7/8/13/16.
