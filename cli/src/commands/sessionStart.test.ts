import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey, saveConfig } from "../config.js";
import { sessionStart } from "./sessionStart.js";
import { setFeature } from "./features.js";

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "grad-start-repo-"));
  const home = await mkdtemp(join(tmpdir(), "grad-start-home-"));
  await saveConfig({ targets: ["claude-code"], optimizeProjects: [projectKey(project)] }, home);
  return { project, home };
}

const summary = () => ({
  checkedAt: "2026-10-28T10:00:00Z", pagePath: "/private/checkup.html",
  targets: ["claude-code" as const],
  findings: [
    { id: "stale", family: "stale", title: "An instruction names a deleted script", severity: "high" as const, actionable: true },
    { id: "workflow", family: "workflow", title: "A repeated workflow", severity: "low" as const, actionable: true },
  ],
});

describe("sessionStart", () => {
  it("surfaces the highest ranked cached finding even without workflow suggestions", async () => {
    const { project, home } = await fixture();
    const output: string[] = [];
    await sessionStart(project, { home, loadLastCheckupFn: async () => summary(), write: line => output.push(line) });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("2026-10-28");
    expect(output[0]).toContain("An instruction names a deleted script");
    expect(output[0]).not.toContain("repeated workflow");
    expect(output[0]).toContain("optimize");
  });

  it("keeps a leftover callback inert after opt-out", async () => {
    const { project, home } = await fixture();
    await setFeature("optimize", false, project, { home });
    let read = false;
    await sessionStart(project, { home, loadLastCheckupFn: async () => { read = true; return summary(); } });
    expect(read).toBe(false);
  });

  it("does not transfer consent to another project or revive the legacy global flag", async () => {
    const { project, home } = await fixture();
    await saveConfig({ targets: ["claude-code"], scanOnSessionStart: true, optimizeProjects: ["/another/project"] }, home);
    let read = false;
    await sessionStart(project, { home, loadLastCheckupFn: async () => { read = true; return summary(); } });
    expect(read).toBe(false);
  });

  it("is silent with no findings or unreadable cache, without scheduling another scan", async () => {
    const { project, home } = await fixture();
    const output: string[] = [];
    for (const loadLastCheckupFn of [async () => null, async () => ({ ...summary(), findings: [] }), async () => { throw new Error("bad cache"); }]) {
      await expect(sessionStart(project, { home, loadLastCheckupFn, write: line => output.push(line) })).resolves.toBeUndefined();
    }
    expect(output).toEqual([]);
  });

  it("fails open on broken output and removes control characters from finding titles", async () => {
    const { project, home } = await fixture();
    const cached = summary();
    cached.findings[0].title = "stale\n\u001b[31mscript";
    let line = "";
    await expect(sessionStart(project, { home, loadLastCheckupFn: async () => cached, write: value => { line = value; throw new Error("closed pipe"); } })).resolves.toBeUndefined();
    expect(line).not.toMatch(/[\n\u001b]/);
  });

  it("does not run Claude callbacks for a Codex-only target", async () => {
    const { project, home } = await fixture();
    await saveConfig({ targets: ["codex"], optimizeProjects: [projectKey(project)] }, home);
    let read = false;
    await sessionStart(project, { home, loadLastCheckupFn: async () => { read = true; return summary(); } });
    expect(read).toBe(false);
  });
});
