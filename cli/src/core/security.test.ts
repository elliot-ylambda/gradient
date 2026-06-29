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
