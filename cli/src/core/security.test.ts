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
  it("falls back to 'untitled' for empty/all-punctuation input", () => {
    expect(sanitizeName("!!!")).toBe("untitled");
    expect(sanitizeName("")).toBe("untitled");
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
  it("masks github tokens and lowercase env assignments", () => {
    expect(redact("ghp_" + "a".repeat(36))).toContain("[REDACTED]");
    expect(redact("api_key=hunter2value")).toContain("[REDACTED]");
  });
  it("masks common cloud, package, bearer, JWT, database, and private-key credentials", () => {
    const samples = [
      `AWS_ACCESS_KEY_ID=${"AKIA" + "A".repeat(16)}`,
      `npm_${"a".repeat(36)}`,
      `xoxb-${"a".repeat(24)}`,
      `github_pat_${"A1".repeat(20)}`,
      `sk_live_${"a1".repeat(12)}`,
      `Authorization: Bearer ${"a".repeat(32)}`,
      `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
      "postgres://user:password@example.com/db",
      "-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----",
    ];
    for (const sample of samples) {
      expect(redact(sample)).toContain("[REDACTED]");
      expect(redact(sample)).not.toContain("secret material");
    }
  });
  it("masks Unix and Windows home-directory usernames", () => {
    expect(redact("/Users/alice/project C:\\Users\\bob\\project")).not.toContain("alice");
    expect(redact("/Users/alice/project C:\\Users\\bob\\project")).not.toContain("bob");
  });
  it("strips terminal control sequences from untrusted text", () => {
    expect(redact("safe\u001b]52;c;payload\u0007text")).not.toContain("\u001b");
  });
});
