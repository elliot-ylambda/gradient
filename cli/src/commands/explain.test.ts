import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { explain } from "./explain.js";
import { suggestionsPath } from "./apply.js";

async function seed(): Promise<{ dir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "grad-explain-"));
  const home = await mkdtemp(join(tmpdir(), "grad-explain-home-"));
  const suggestions = [{
    id: "aaa", name: "ship", title: "Ship", rationale: "Repeated 9× across 3 sessions.",
    evidence: { count: 9, sessions: 3 }, confidence: "high",
    examples: ["push and open a PR", "push then open pr"],
    payload: { type: "command", commandName: "ship", body: "x" },
  }];
  const path = suggestionsPath(dir, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(suggestions));
  return { dir, home };
}

describe("explain", () => {
  it("finds a suggestion by name", async () => {
    const { dir, home } = await seed();
    const s = await explain(dir, "ship", { home });
    expect(s?.evidence.count).toBe(9);
    expect(s?.examples?.length).toBe(2);
  });
  it("finds a suggestion by id", async () => {
    const { dir, home } = await seed();
    expect((await explain(dir, "aaa", { home }))?.name).toBe("ship");
  });
  it("returns undefined when not found", async () => {
    const { dir, home } = await seed();
    expect(await explain(dir, "nope", { home })).toBeUndefined();
  });
});
