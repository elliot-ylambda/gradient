import { describe, it, expect } from "vitest";
import { list, parseFrontmatter, scalar } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("reads scalars, inline lists, and block lists", () => {
    const parsed = parseFrontmatter([
      "---",
      'name: "commit"',
      "description: Stage and commit the current changes",
      "allowed-tools: [Bash, Read]",
      "paths:",
      "  - src/**/*.ts",
      "  - lib/**/*.ts",
      "---",
      "Body",
    ].join("\n"));
    expect(parsed.error).toBeUndefined();
    expect(scalar(parsed, "name")).toBe("commit");
    expect(scalar(parsed, "description")).toBe("Stage and commit the current changes");
    expect(list(parsed, "allowed-tools")).toEqual(["Bash", "Read"]);
    expect(list(parsed, "paths")).toEqual(["src/**/*.ts", "lib/**/*.ts"]);
    expect(parsed.keys).toEqual(["name", "description", "allowed-tools", "paths"]);
  });

  it("accepts the comma-separated spelling of paths", () => {
    const parsed = parseFrontmatter("---\npaths: src/**/*.ts, lib/**\n---\n");
    expect(list(parsed, "paths")).toEqual(["src/**/*.ts", "lib/**"]);
  });

  // Dogfood regression: a real installed skill carries `requires:` with a
  // nested map. Claude Code loads it, so reporting it as unreadable would have
  // told the user a working skill was broken.
  it("consumes a nested map without calling the document broken", () => {
    const parsed = parseFrontmatter([
      "---",
      "name: sentry-cli",
      "version: 0.38.0",
      "description: Guide for using the Sentry CLI",
      "requires:",
      '  bins: ["sentry"]',
      "  auth: true",
      "---",
      "Body",
    ].join("\n"));
    expect(parsed.error).toBeUndefined();
    expect(scalar(parsed, "description")).toBe("Guide for using the Sentry CLI");
    expect(parsed.keys).toEqual(["name", "version", "description", "requires"]);
  });

  it("reports only frontmatter no reader could use", () => {
    expect(parseFrontmatter("---\nname: x\nno close here\n").error).toContain("never closed");
    expect(parseFrontmatter("# Just markdown\n").present).toBe(false);
  });

  it("reports the length it consumed so a body offset is exact", () => {
    const raw = "---\nname: x\n---\nBody line\n";
    const parsed = parseFrontmatter(raw);
    expect(raw.slice(parsed.length)).toBe("Body line\n");
  });
});
