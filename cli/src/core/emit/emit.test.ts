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
