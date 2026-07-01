import { describe, it, expect } from "vitest";
import { spawnDetached } from "./spawn.js";

describe("spawnDetached", () => {
  it("spawns the cli detached with the given args and unrefs", () => {
    const calls: any[] = [];
    let unreffed = false;
    const fakeChild = { unref: () => { unreffed = true; } };
    const spawn = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return fakeChild;
    }) as any;
    spawnDetached(["scan", "--all"], "/tmp/proj", { spawn, openLog: () => 7 });
    expect(calls.length).toBe(1);
    expect(calls[0].args).toContain("scan");
    expect(calls[0].args).toContain("--all");
    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].opts.stdio).toEqual(["ignore", 7, 7]);
    expect(unreffed).toBe(true);
  });
});
