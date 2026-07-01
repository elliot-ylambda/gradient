import { describe, it, expect } from "vitest";
import { annotateTemporal, spanDays } from "./temporal.js";
import { cluster } from "./cluster.js";
import type { Turn } from "./types.js";

const u = (text: string, ts: string, sessionId = "s1"): Turn =>
  ({ ts, project: "p", role: "user", text, sessionId });

describe("spanDays", () => {
  it("measures the span between first and last occurrence in days", () => {
    expect(spanDays([{ ts: "2026-06-01T00:00:00Z" }, { ts: "2026-06-15T00:00:00Z" }])).toBe(14);
  });
  it("is 0 for a single or empty occurrence list", () => {
    expect(spanDays([{ ts: "2026-06-01T00:00:00Z" }])).toBe(0);
    expect(spanDays([])).toBe(0);
  });
});

describe("annotateTemporal", () => {
  it("computes run lengths for consecutive same-cluster prompts within a session", () => {
    const turns = [
      u("continue", "2026-06-01T10:00:00Z", "s1"),
      u("continue", "2026-06-01T10:05:00Z", "s1"),
      u("continue", "2026-06-01T10:10:00Z", "s1"),
      u("fix the header", "2026-06-01T10:15:00Z", "s1"),
      u("continue", "2026-06-01T10:20:00Z", "s1"),   // run broken by unrelated prompt
      u("continue", "2026-06-02T09:00:00Z", "s2"),
      u("continue", "2026-06-02T09:01:00Z", "s2"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    const cont = cands.find(c => c.signature === "continue")!;
    expect(cont.temporal!.maxRunLength).toBe(3);
    expect(cont.temporal!.runSessions).toBe(2);   // s1 and s2 both contain a run ≥ 2
    expect(cont.temporal!.distinctDays).toBe(2);
  });
  it("computes the median gap in minutes across occurrences", () => {
    const turns = [
      u("check the deploy", "2026-06-01T09:00:00Z", "s1"),
      u("check the deploy", "2026-06-01T09:10:00Z", "s1"),
      u("check the deploy", "2026-06-01T09:30:00Z", "s1"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    expect(cands[0].temporal!.medianGapMinutes).toBe(15); // gaps 10 and 20 → median 15
  });
  it("annotates every candidate, even single-run ones", () => {
    const turns = [
      u("review the spec", "2026-06-01T09:00:00Z", "s1"),
      u("review the spec", "2026-06-02T09:00:00Z", "s2"),
      u("review the spec", "2026-06-03T09:00:00Z", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    expect(cands[0].temporal).toMatchObject({ maxRunLength: 1, runSessions: 0, distinctDays: 3, spanDays: 2 });
  });
});
