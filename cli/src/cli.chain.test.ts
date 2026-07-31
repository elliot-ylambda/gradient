import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { scan } from "./commands/scan.js";
import { review } from "./commands/review.js";
import { init } from "./commands/init.js";
import type { Suggestion } from "./core/types.js";
import type { ApplyResult } from "./commands/apply.js";

vi.mock("./commands/scan.js", () => ({ scan: vi.fn(async () => []) }));
vi.mock("./commands/review.js", () => ({
  review: vi.fn(async () => []),
  readlinePrompter: vi.fn(() => async () => "skip"),
  readlineClarifier: vi.fn(() => async () => null),
}));
vi.mock("./commands/init.js", () => ({
  init: vi.fn(async () => ({
    backend: "claude",
    configPath: "/h/.config/gradient/config.json",
    skillInstalled: true,
    skillPaths: [],
    sessionScanInstalled: false,
  })),
}));

const SUGGESTION = {
  id: "s1",
  name: "merge-branch",
  title: "Reusable workflow for “okay merge this pull request into main”",
  confidence: "high",
  evidence: { count: 3, sessions: 2, examples: [] },
  payload: { type: "command", commandName: "merge-branch", body: "", triggers: ["merge it"] },
} as unknown as Suggestion;

const APPLIED = {
  writes: [{ path: "/repo/.claude/skills/merge-branch/SKILL.md", target: "claude-code" }],
  failures: [],
  skippedTargets: [],
} as unknown as ApplyResult;

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grad-chain-"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(scan).mockResolvedValue([SUGGESTION]);
  vi.mocked(review).mockResolvedValue([]);
});

describe("scan → review continuation", () => {
  it("chains straight into review when the offer is accepted", async () => {
    const logs: string[] = [];
    const confirm = vi.fn(async () => true);
    const code = await main(["scan"], { log: m => logs.push(m), home: await tmpHome(), confirm });
    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Review these 1"), true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain("Next:");
  });

  it("prints the review hint when the offer is declined", async () => {
    const logs: string[] = [];
    const code = await main(["scan"], { log: m => logs.push(m), home: await tmpHome(), confirm: async () => false });
    expect(code).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("gradient review");
  });

  it("--no-review never asks", async () => {
    const confirm = vi.fn(async () => true);
    await main(["scan", "--no-review"], { log: () => {}, home: await tmpHome(), confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("suggests a wider scan instead of review when nothing was found", async () => {
    vi.mocked(scan).mockResolvedValue([]);
    const logs: string[] = [];
    const confirm = vi.fn(async () => true);
    await main(["scan"], { log: m => logs.push(m), home: await tmpHome(), confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("gradient scan --user");
  });
});

describe("init → first scan continuation", () => {
  it("offers a first scan and flows through to review", async () => {
    const confirm = vi.fn(async () => true);
    const code = await main(["init"], { log: () => {}, home: await tmpHome(), confirm });
    expect(code).toBe(0);
    expect(init).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("--no-scan stays configure-only", async () => {
    const confirm = vi.fn(async () => true);
    await main(["init", "--no-scan"], { log: () => {}, home: await tmpHome(), confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });
});
