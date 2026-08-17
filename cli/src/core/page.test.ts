import { describe, it, expect } from "vitest";
import { renderPage } from "./page.js";
import type { Finding } from "./findings.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "a1b2c3d4e5f6",
  family: "stale",
  severity: "high",
  title: "CLAUDE.md:24 refers to something that is gone",
  detail: "The instruction names \"scripts/build.sh\", and no such file exists.",
  evidence: "Build the project with `scripts/build.sh` first",
  targets: ["claude-code"],
  deterministic: true,
  commandBearing: false,
  changes: [{
    op: "delete-line", path: "/repo/CLAUDE.md", assistant: "claude-code",
    line: 24, before: "Build the project with `scripts/build.sh` first",
  }],
  ...over,
});

const page = (over: Partial<Parameters<typeof renderPage>[0]> = {}): string => renderPage({
  runId: "20260813-221000-abc123",
  projectDir: "/repo",
  targets: ["claude-code", "codex"],
  findings: [finding()],
  invocation: "node ~/.agents/skills/gradient-optimize/bin/gradient.mjs",
  ...over,
});

describe("renderPage", () => {
  it("is a complete document with the run's identity in it", () => {
    const html = page();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("20260813-221000-abc123");
    expect(html).toContain("claude-code + codex");
    expect(html).toContain("a1b2c3d4e5f6");
  });

  // The whole reason it is a file:// page and not a served one: it must render
  // identically offline, and must never be able to phone home with what it is
  // displaying.
  it("references nothing outside itself", () => {
    const html = page();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/\bhref\s*=/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/);
  });

  it("escapes every mined string rather than letting it become markup", () => {
    const html = page({
      findings: [finding({
        title: "<script>alert(1)</script>",
        detail: "a \" quote & an <b>ampersand</b>",
        evidence: "</pre><img>",
        changes: [{
          op: "delete-line", path: "/repo/<evil>.md", assistant: "claude-code",
          line: 1, before: "<script>steal()</script>",
        }],
      })],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>steal()</script>");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Exactly one script element: the page's own.
    // Case-insensitive, because that is what "exactly one script element"
    // means: HTML tag names are not case-sensitive, so a check that only sees
    // lower-case ones is not counting script elements, it is counting a
    // spelling of them.
    expect(html.match(/<script/gi)).toHaveLength(1);
  });

  it("builds the apply command from ids alone", () => {
    const html = page();
    expect(html).toContain('data-id="a1b2c3d4e5f6"');
    expect(html).toContain("node ~/.agents/skills/gradient-optimize/bin/gradient.mjs optimize");
    // Ids are hex, so nothing user-derived reaches the script.
    const script = /<script>([\s\S]*?)<\/script>/i.exec(html)![1];
    expect(script).not.toContain("scripts/build.sh");
    expect(script).not.toContain("CLAUDE.md");
  });

  it("groups by family and shows a diff per change", () => {
    const html = page({
      findings: [
        finding(),
        finding({ id: "f00d", family: "drift", severity: "high", title: "bridge missing" }),
      ],
    });
    expect(html).toContain(">stale</h2>");
    expect(html).toContain(">drift</h2>");
    expect(html).toContain('class="del"');
  });

  it("renders a run that found nothing", () => {
    const html = page({ findings: [] });
    expect(html).toContain("Nothing to change");
    expect(html).not.toContain('class="card"');
  });

  it("shows the context cost when it is known", () => {
    const html = page({ contextCost: { skills: 32, chars: 9191 } });
    expect(html).toContain("9191");
    expect(html).toContain("skill description chars");
  });

  it("defines its colours for both themes", () => {
    const html = page();
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toMatch(/body\{[^}]*background:var\(--bg\)/);
  });
});
