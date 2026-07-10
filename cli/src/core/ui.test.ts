import { describe, it, expect } from "vitest";
import { gradientText, c, confidenceChip, kindLabel, banner } from "./ui.js";

// Under vitest, stdout is not a TTY, so COLOR is disabled and every helper must
// be a pass-through. This is the accessibility contract (NO_COLOR / pipes /
// dumb terminals get clean, escape-free text).
const ESC = "\x1b";

describe("ui — plain-mode (no-TTY) contract", () => {
  it("gradientText returns the input unchanged and escape-free", () => {
    expect(gradientText("gradient")).toBe("gradient");
    expect(gradientText("hello world")).not.toContain(ESC);
  });

  it("color helpers are pass-through", () => {
    expect(c.violet("x")).toBe("x");
    expect(c.bold("x")).toBe("x");
    expect(c.muted("x")).toBe("x");
  });

  it("confidenceChip renders uniform-width plain labels for every confidence", () => {
    expect(confidenceChip("high")).toBe("[high]");
    expect(confidenceChip("inferred")).toBe("[infr]");
    expect(confidenceChip("flagged")).toBe("[flag]");
  });

  it("kindLabel returns the plain kind name for every artifact type", () => {
    expect(kindLabel("command")).toBe("command");
    expect(kindLabel("skill")).toBe("skill");
    expect(kindLabel("loop")).toBe("loop");
    expect(kindLabel("hook")).toBe("hook");
    expect(kindLabel("rule")).toBe("rule");
  });

  it("banner carries the brand and version without escape codes", () => {
    const b = banner("9.9.9");
    expect(b).toContain("gradient");
    expect(b).toContain("v9.9.9");
    expect(b).not.toContain(ESC);
  });
});
