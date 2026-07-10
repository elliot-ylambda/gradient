import { describe, it, expect } from "vitest";
import { extractPasteKey, detectPasteCandidates } from "./paste.js";
import type { Turn } from "./types.js";

const t = (sessionId: string, text: string): Turn => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  role: "user",
  sessionId,
  text,
});

const errBody = (head: string) => `${head}\n${"error: something failed\n".repeat(30)}`;

describe("extractPasteKey", () => {
  it("keys a long error paste by its first line", () => {
    expect(extractPasteKey(errBody("make dev"))).toBe("make dev");
  });

  it("truncates keys to 80 chars", () => {
    expect(extractPasteKey(errBody("x".repeat(120)))!.length).toBe(80);
  });

  it("returns null for short texts and non-error long texts", () => {
    expect(extractPasteKey("error: short")).toBeNull();
    expect(extractPasteKey("just a very long design discussion ".repeat(20))).toBeNull();
  });
});

describe("detectPasteCandidates", () => {
  it("groups same-command pastes across differing bodies", () => {
    const prompts = [
      t("s1", `${errBody("make dev")}AAA`),
      t("s2", `${errBody("make dev")}BBB`),
      t("s3", `${errBody("make dev")}CCC`),
      t("s1", errBody("xcodebuild -scheme App")),
    ];
    const out = detectPasteCandidates(prompts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "paste", signature: "make dev", count: 3, sessions: 3 });
  });

  it("never leaks paste bodies into examples", () => {
    const prompts = [t("s1", errBody("make dev")), t("s2", errBody("make dev")), t("s3", errBody("make dev"))];
    const [candidate] = detectPasteCandidates(prompts);
    expect(candidate.examples).toEqual(["pasted output of: make dev"]);
  });
});
