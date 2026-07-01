import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explain } from "./explain.js";

async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-explain-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  const suggestions = [{
    id: "aaa", name: "ship", title: "Ship", rationale: "Repeated 9× across 3 sessions.",
    evidence: { count: 9, sessions: 3 }, confidence: "high",
    examples: ["push and open a PR", "push then open pr"],
    payload: { type: "command", commandName: "ship", body: "x" },
  }];
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(suggestions));
  return dir;
}

describe("explain", () => {
  it("finds a suggestion by name", async () => {
    const s = await explain(await seed(), "ship");
    expect(s?.evidence.count).toBe(9);
    expect(s?.examples?.length).toBe(2);
  });
  it("finds a suggestion by id", async () => {
    expect((await explain(await seed(), "aaa"))?.name).toBe("ship");
  });
  it("returns undefined when not found", async () => {
    expect(await explain(await seed(), "nope")).toBeUndefined();
  });
});
