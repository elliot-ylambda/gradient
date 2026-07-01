import { describe, it, expect } from "vitest";
import { renderTail, fingerprint } from "./tail.js";

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistant = (blocks: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string) => ({ type: "tool_use", name, id: "x", input: {} });

describe("renderTail", () => {
  it("renders user and assistant turns with a tool-activity summary", () => {
    const lines = [
      user("fix the parser"),
      assistant([text("On it."), tool("Edit"), tool("Edit"), tool("Bash")]),
      assistant([text("Done — tests pass.")]),
    ];
    const out = renderTail(lines);
    expect(out).toBe(
      "user: fix the parser\n" +
      "assistant: On it. [3 tool calls: Edit ×2, Bash]\n" +
      "assistant: Done — tests pass.",
    );
  });

  it("skips sidechains, tool_result-only user messages, and unparseable lines", () => {
    const lines = [
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "hidden" } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "raw output" }] } }),
      "not json at all",
      user("real prompt"),
    ];
    const out = renderTail(lines);
    expect(out).toBe("user: real prompt");
  });

  it("keeps only the last maxTurns turns and caps total chars from the end", () => {
    const lines = Array.from({ length: 40 }, (_, i) => user(`prompt ${i}`));
    const out = renderTail(lines, { maxTurns: 5 });
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("prompt 39");
    expect(out).not.toContain("prompt 34\n");
    const capped = renderTail(lines, { maxTurns: 40, maxChars: 50 });
    expect(capped.length).toBeLessThanOrEqual(50);
    expect(capped.endsWith("prompt 39")).toBe(true); // the END of the tail survives
  });
});

describe("fingerprint", () => {
  it("counts tool_use blocks only — text growth does not advance it", () => {
    const base = [user("go"), assistant([text("working"), tool("Bash")])];
    const moreTextOnly = [...base, assistant([text("still just talking")])];
    const moreTools = [...base, assistant([tool("Edit")])];
    expect(fingerprint(base)).toBe("tools:1");
    expect(fingerprint(moreTextOnly)).toBe("tools:1"); // no progress
    expect(fingerprint(moreTools)).toBe("tools:2");    // progress
  });

  it("ignores sidechain assistant turns and junk lines", () => {
    const lines = [
      JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [tool("Edit")] } }),
      "garbage",
      assistant([tool("Bash")]),
    ];
    expect(fingerprint(lines)).toBe("tools:1");
  });
});
