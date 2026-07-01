import { describe, it, expect, vi } from "vitest";
import { parseCliArgs, main } from "./cli.js";
import { spawnDetached } from "./core/spawn.js";

vi.mock("./core/spawn.js", () => ({ spawnDetached: vi.fn() }));

describe("parseCliArgs", () => {
  it("parses command, flags, and positionals", () => {
    const r = parseCliArgs(["scan", "--all", "--since", "7d"]);
    expect(r.command).toBe("scan");
    expect(r.flags.all).toBe(true);
    expect(r.flags.since).toBe("7d");
  });

  it("parses positionals after command", () => {
    const r = parseCliArgs(["apply", "my-suggestion", "other"]);
    expect(r.command).toBe("apply");
    expect(r.positionals).toEqual(["my-suggestion", "other"]);
  });

  it("parses --limit flag", () => {
    const r = parseCliArgs(["scan", "--limit", "10"]);
    expect(r.flags.limit).toBe("10");
  });

  it("returns empty command for empty argv", () => {
    const r = parseCliArgs([]);
    expect(r.command).toBe("");
    expect(r.positionals).toEqual([]);
  });
});

describe("main", () => {
  it("returns 0 and prints help for no command", async () => {
    const logs: string[] = [];
    const code = await main([], { log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("gradient");
  });

  it("returns 2 for an unknown command", async () => {
    const logs: string[] = [];
    const code = await main(["wat"], { log: (m) => logs.push(m) });
    expect(code).toBe(2);
  });

  it("includes help text in unknown command output", async () => {
    const logs: string[] = [];
    await main(["unknowncmd"], { log: (m) => logs.push(m) });
    const output = logs.join("\n");
    expect(output).toContain("gradient");
    expect(output).toContain("unknowncmd");
  });

  it("scan --detach does not forward --detach to child (fork-bomb guard)", async () => {
    vi.mocked(spawnDetached).mockClear();
    const code = await main(["scan", "--detach", "--all"], { log: () => {} });
    expect(code).toBe(0);
    expect(vi.mocked(spawnDetached)).toHaveBeenCalledTimes(1);
    const forwardedArgs = vi.mocked(spawnDetached).mock.calls[0][0] as string[];
    expect(forwardedArgs).not.toContain("--detach");
    expect(forwardedArgs).toContain("scan");
    expect(forwardedArgs).toContain("--all");
  });
});
