import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTargets, parseTargetFlag, targetsFor } from "./targets.js";
import { loadConfig, saveConfig } from "../config.js";

const home = () => mkdtemp(join(tmpdir(), "grad-targets-"));

describe("parseTargetFlag", () => {
  it("maps each accepted spelling", () => {
    expect(parseTargetFlag("claude-code")).toEqual(["claude-code"]);
    expect(parseTargetFlag("codex")).toEqual(["codex"]);
    expect(parseTargetFlag("both")).toEqual(["claude-code", "codex"]);
    expect(parseTargetFlag(undefined)).toBeUndefined();
  });

  it("refuses anything else rather than optimizing the wrong assistant", () => {
    expect(() => parseTargetFlag("cursor")).toThrow(/unknown target/);
    expect(() => parseTargetFlag(true)).toThrow(/unknown target/);
  });
});

describe("targetsFor", () => {
  it("expands both", () => {
    expect(targetsFor("both")).toEqual(["claude-code", "codex"]);
  });
});

describe("ensureTargets", () => {
  it("asks once, stores the answer, and never asks again", async () => {
    const h = await home();
    let asks = 0;
    const ask = async () => { asks++; return "both" as const; };

    const first = await ensureTargets({ home: h }, { ask });
    expect(first).toEqual({ targets: ["claude-code", "codex"], firstRun: true });
    expect((await loadConfig(h)).targets).toEqual(["claude-code", "codex"]);

    const second = await ensureTargets({ home: h }, { ask });
    expect(second).toEqual({ targets: ["claude-code", "codex"], firstRun: false });
    expect(asks).toBe(1);
  });

  // A first run that passes --target is still a first run: gating setup on the
  // prompt meant `gradient optimize --target both` on a fresh machine
  // configured itself and installed nothing.
  it("takes the flag over asking, remembers it, and still reports a first run", async () => {
    const h = await home();
    const ask = async () => { throw new Error("should not ask"); };
    const result = await ensureTargets({ flag: "codex", home: h }, { ask });
    expect(result).toEqual({ targets: ["codex"], firstRun: true });
    expect((await loadConfig(h)).targets).toEqual(["codex"]);
  });

  it("lets an explicit flag override what is already configured, without rewriting it", async () => {
    const h = await home();
    await saveConfig({ targets: ["claude-code"] }, h);
    const result = await ensureTargets({ flag: "both", home: h }, { ask: async () => null });
    expect(result).toEqual({ targets: ["claude-code", "codex"], firstRun: false });
    // A one-off override is not a new default.
    expect((await loadConfig(h)).targets).toEqual(["claude-code"]);
  });

  // A cron job or a hook must never decide on its own to start writing into a
  // second assistant's configuration.
  it("refuses to guess when nobody is there to answer", async () => {
    const h = await home();
    await expect(ensureTargets({ home: h }, { ask: async () => null }))
      .rejects.toThrow(/--target claude-code, --target codex, or --target both/);
    expect((await loadConfig(h)).targets).toBeUndefined();
  });
});
