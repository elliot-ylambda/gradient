import { describe, expect, it } from "vitest";
import { audit, CORRECTION_RE } from "./audit.js";
import { normalize } from "./cluster.js";
import type { InstructionLine } from "./instructions.js";
import type { Turn } from "./types.js";

const turn = (text: string, sessionId: string, ts = "2026-07-01T00:00:00Z"): Turn => ({
  ts,
  project: "p",
  role: "user",
  sessionId,
  text,
  assistant: "claude-code",
});
const instruction = (
  text: string,
  source: InstructionLine["source"] = "project",
): InstructionLine => ({ source, file: "CLAUDE.md", text, normalized: normalize(text) });

describe("CORRECTION_RE", () => {
  it("matches correction openers without matching ordinary prompts", () => {
    for (const text of [
      "no, use pnpm",
      "don't touch the migrations",
      "stop - wrong file",
      "actually, revert that",
      "never push to main",
    ]) expect(CORRECTION_RE.test(text)).toBe(true);
    for (const text of [
      "add a login page",
      "now update the docs",
      "not sure, you pick",
    ]) expect(CORRECTION_RE.test(text)).toBe(false);
  });
});

describe("audit restatements", () => {
  const instructions = [instruction("always use pnpm, never npm")];

  it("finds semantically normalized restatements across sessions", () => {
    const prompts = [
      turn("use pnpm not npm", "s1"),
      turn("always use pnpm never npm", "s1"),
      turn("use pnpm, not npm please", "s2", "2026-07-02T00:00:00Z"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    expect(tallies[0]).toMatchObject({ restatements: 3, violations: 0, lastSeen: "2026-07-02T00:00:00Z" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "instruction",
      sessions: 2,
      hint: 'restated instruction (project): "always use pnpm, never npm"',
    });
  });

  it("stays silent below either the occurrence or session floor", () => {
    expect(audit([
      turn("use pnpm not npm", "s1"),
      turn("use pnpm not npm", "s2"),
    ], instructions).candidates).toEqual([]);
    expect(audit([
      turn("use pnpm not npm", "s1"),
      turn("use pnpm not npm", "s1"),
      turn("use pnpm not npm", "s1"),
    ], instructions).candidates).toEqual([]);
  });
});

describe("audit corrections", () => {
  it("routes a correction cluster matching an instruction to violated", () => {
    const instructions = [instruction("never edit generated files")];
    const prompts = [
      turn("no, never edit generated files", "s1"),
      turn("don't edit generated files!", "s2"),
      turn("stop, never edit generated files", "s3", "2026-07-03T00:00:00Z"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    expect(candidates).toEqual([expect.objectContaining({
      kind: "instruction",
      hint: 'correction violating instruction (project): "never edit generated files"',
    })]);
    expect(tallies[0]).toMatchObject({ violations: 3, restatements: 0, lastSeen: "2026-07-03T00:00:00Z" });
  });

  it("routes an unmatched correction cluster to a missing instruction", () => {
    const prompts = [
      turn("don't use emojis in commit messages", "s1"),
      turn("don't use emojis in commits", "s2"),
      turn("no emojis in commit messages please", "s3"),
    ];
    const { candidates } = audit(prompts, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hint).toBe("repeated correction with no matching instruction");
  });

  it("ignores long corrections and never double-counts corrections as restatements", () => {
    const long = `don't ${"x".repeat(200)}`;
    expect(audit([turn(long, "s1"), turn(long, "s2"), turn(long, "s3")], []).candidates).toEqual([]);

    const instructions = [instruction("never edit generated files")];
    const prompts = [
      turn("no, never edit generated files", "s1"),
      turn("don't edit generated files!", "s2"),
      turn("stop, never edit generated files", "s3"),
    ];
    const { candidates, tallies } = audit(prompts, instructions);
    expect(tallies[0].restatements).toBe(0);
    expect(candidates.filter(candidate => candidate.hint?.startsWith("restated"))).toEqual([]);
  });

  it("uses only caller-confirmed corrections when context is supplied", () => {
    const prompts = [
      turn("don't add comments", "s1"),
      turn("don't add comments", "s2"),
      turn("don't add comments", "s3"),
    ];
    expect(audit(prompts, [], { confirmedCorrections: prompts.slice(0, 2) }).candidates).toEqual([]);
  });
});
