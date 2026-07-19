import { describe, expect, it } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTENTION_MAX_FILE_BYTES,
  ATTENTION_MIN_SESSIONS,
  attentionSuggestion,
  gapsInLines,
  mineAttention,
} from "./attention.js";

const assistant = (ts: string, text: string) => JSON.stringify({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const user = (ts: string, text: string) => JSON.stringify({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
});

describe("gapsInLines", () => {
  it("finds a gap when an assistant question waits at least five minutes", () => {
    expect(gapsInLines([
      assistant("2026-07-09T10:00:00Z", "Should I merge?"),
      user("2026-07-09T10:07:00Z", "yes"),
    ])).toEqual([420_000]);
  });

  it("shares the answer miner's question-tail behavior", () => {
    expect(gapsInLines([
      assistant("2026-07-09T10:00:00Z", "Should I merge? Choose when ready."),
      user("2026-07-09T10:05:00Z", "yes"),
    ])).toEqual([300_000]);
  });

  it("ignores fast answers, non-questions, sidechains, and malformed records", () => {
    expect(gapsInLines([
      assistant("2026-07-09T10:00:00Z", "Should I merge?"),
      user("2026-07-09T10:01:00Z", "yes"),
    ])).toEqual([]);
    expect(gapsInLines([
      assistant("2026-07-09T10:00:00Z", "Done."),
      user("2026-07-09T10:20:00Z", "next"),
    ])).toEqual([]);
    expect(gapsInLines([
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-07-09T10:00:00Z",
        message: { content: "Proceed?" },
      }),
      user("2026-07-09T10:20:00Z", "yes"),
      "not json",
      "{}",
    ])).toEqual([]);
  });
});

describe("mineAttention", () => {
  const gapFile = (minutes: number) => [
    assistant("2026-07-09T10:00:00Z", "Proceed?"),
    user(`2026-07-09T10:${String(minutes).padStart(2, "0")}:00Z`, "yes"),
  ].join("\n");

  it("aggregates gap-bearing files, computes the median, and applies the session floor", async () => {
    const files = Array.from({ length: ATTENTION_MIN_SESSIONS }, (_, index) => `f${index}`);
    const waits = [6, 8, 10, 12, 14];
    const stats = await mineAttention(files, async path => gapFile(waits[Number(path.slice(1))]));
    expect(stats).toEqual({ gaps: 5, sessions: 5, medianMinutes: 10 });
  });

  it("returns null below the floor and skips unreadable files", async () => {
    expect(await mineAttention(["f1"], async () => gapFile(10))).toBeNull();
    expect(await mineAttention(["f1"], async () => { throw new Error("gone"); })).toBeNull();
  });

  it("does not count the same transcript path twice", async () => {
    expect(await mineAttention(["same", "same", "same", "same", "same"], async () => gapFile(10))).toBeNull();
  });

  it("does not follow transcript symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-attention-link-"));
    const target = join(dir, "target.jsonl");
    await writeFile(target, gapFile(10));
    const links = await Promise.all(Array.from({ length: ATTENTION_MIN_SESSIONS }, async (_, index) => {
      const link = join(dir, `link-${index}.jsonl`);
      await symlink(target, link);
      return link;
    }));
    expect(await mineAttention(links)).toBeNull();
  });

  it("rejects oversized injected transcript content and bounds extracted gaps", async () => {
    const files = Array.from({ length: ATTENTION_MIN_SESSIONS }, (_, index) => `f${index}`);
    expect(await mineAttention(files, async () => "x".repeat(ATTENTION_MAX_FILE_BYTES + 1))).toBeNull();
    expect(gapsInLines([
      assistant("2026-07-09T10:00:00Z", "Proceed?"),
      user("2026-07-09T10:10:00Z", "yes"),
      assistant("2026-07-09T11:00:00Z", "Proceed?"),
      user("2026-07-09T11:10:00Z", "yes"),
    ], 1)).toHaveLength(1);
  });
});

describe("attentionSuggestion", () => {
  it("builds a stable, Claude-sourced Notification hook suggestion", () => {
    const suggestion = attentionSuggestion({ gaps: 12, sessions: 8, medianMinutes: 14 });
    expect(suggestion.payload).toMatchObject({
      type: "hook",
      event: "Notification",
      matcher: "permission_prompt|idle_prompt",
      subcommand: "notify",
    });
    expect(suggestion.evidence.assistants).toEqual(["claude-code"]);
    expect(suggestion.rationale).toContain("12");
    expect(suggestion.id).toBe(attentionSuggestion({ gaps: 5, sessions: 5, medianMinutes: 5 }).id);
  });
});
