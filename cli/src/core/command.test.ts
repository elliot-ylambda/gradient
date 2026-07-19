import { describe, expect, it } from "vitest";
import { commandKey, normalizeCommandName } from "./command.js";

describe("command normalization", () => {
  it("keeps bounded slash-command tokens and normalizes lookup case", () => {
    expect(normalizeCommandName("  /Plugin:Ship  ")).toBe("/Plugin:Ship");
    expect(commandKey("/Plugin:Ship")).toBe("plugin:ship");
    expect(commandKey("Ship")).toBe("ship");
  });

  it("rejects empty, argument-bearing, multiline, and oversized values", () => {
    expect(normalizeCommandName("")).toBeNull();
    expect(normalizeCommandName("/ship now")).toBeNull();
    expect(normalizeCommandName("/ship\n/publish")).toBeNull();
    expect(normalizeCommandName(`/${"x".repeat(100)}`)).toBeNull();
  });
});
