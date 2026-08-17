import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * A NUL byte inside a template literal compiles and runs correctly, which is
 * exactly why this went unnoticed: `replay.ts` and `findings.ts` both used one
 * as a field separator and both worked.
 *
 * What it breaks is every tool that reads the source. `grep` classifies a file
 * containing NUL as binary and skips it silently, so a repository-wide search
 * for a symbol returns "not found" for a file that defines it — which is how a
 * type declared in `findings.ts` came back with no matches. Write the escape.
 */
describe("source hygiene", () => {
  it("has no literal NUL bytes in any source file", async () => {
    const offenders: string[] = [];
    for (const path of await sources(srcDir)) {
      if ((await readFile(path)).includes(0)) offenders.push(path.slice(srcDir.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
