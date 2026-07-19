import { describe, it, expect } from "vitest";
import {
  PROJECT_PLAYBOOK_TEMPLATE, entryTag, spliceLine, removeTaggedLine, proseDiff,
} from "./playbook-splice.js";

const LINE = `- After tests pass, run make build. ${entryTag("abc123")}`;

describe("spliceLine", () => {
  it("creates the template when the file is missing", () => {
    const out = spliceLine(null, "workflows", LINE, "abc123");
    expect(out).toContain("# gradient.md");
    expect(out).toContain(`## Workflows\n\n${LINE}`);
  });

  it("appends at the end of an existing section, before the next heading", () => {
    const existing = "---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- hand-written rule\n\n## Workflows\n- old entry\n";
    const out = spliceLine(existing, "rules", LINE, "abc123");
    const rulesBlock = out.slice(out.indexOf("## Rules"), out.indexOf("## Workflows"));
    expect(rulesBlock).toContain("- hand-written rule");
    expect(rulesBlock).toContain(LINE);
    expect(out.indexOf(LINE)).toBeLessThan(out.indexOf("## Workflows"));
  });

  it("never touches untagged lines or frontmatter", () => {
    const existing = "---\nautopilot:\n  budget: 3\n---\n## Rules\n- keep me\n";
    const out = spliceLine(existing, "rules", LINE, "abc123");
    expect(out).toContain("---\nautopilot:\n  budget: 3\n---");
    expect(out).toContain("- keep me");
  });

  it("appends a missing section", () => {
    const out = spliceLine("# hand-made\n\n## Rules\n- r\n", "workflows", LINE, "abc123");
    expect(out).toContain(`## Workflows\n\n${LINE}`);
    expect(out).toContain("- r");
  });

  it("is idempotent when the tag is already present", () => {
    const once = spliceLine(null, "rules", LINE, "abc123");
    expect(spliceLine(once, "rules", LINE, "abc123")).toBe(once);
  });
});

describe("removeTaggedLine", () => {
  it("removes exactly the tagged line", () => {
    const content = spliceLine("## Rules\n- keep me\n", "rules", LINE, "abc123");
    const out = removeTaggedLine(content, "abc123");
    expect(out).not.toContain(LINE);
    expect(out).toContain("- keep me");
  });

  it("returns null when the tag is absent", () => {
    expect(removeTaggedLine("## Rules\n- keep me\n", "abc123")).toBeNull();
  });
});

describe("proseDiff", () => {
  it("marks removed and added lines", () => {
    const diff = proseDiff("## Rules\n- old line\n- shared\n", "## Rules\n- new line\n- shared\n");
    expect(diff).toContain("- - old line");
    expect(diff).toContain("+ - new line");
    expect(diff).not.toContain("shared");
  });
});
