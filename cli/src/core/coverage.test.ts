import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHusks, extractSessionRefs, findMissingSessions } from "./coverage.js";

describe("findHusks", () => {
  it("flags bridged transcripts with no minable prompts, not stubs or live files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-cov-"));
    const husk = join(dir, "husk.jsonl");
    const live = join(dir, "live.jsonl");
    const stub = join(dir, "stub.jsonl");
    await writeFile(husk, '{"type":"bridge-session","bridgeSessionId":"session_01AAA"}\n');
    await writeFile(live, '{"type":"bridge-session"}\n{"type":"user","message":{"content":"hi"}}\n');
    await writeFile(stub, '{"type":"queued_command"}\n'); // opened-but-never-used, no bridge
    const counts = new Map([[husk, 0], [live, 1], [stub, 0]]);
    const missing = join(dir, "gone.jsonl"); // unreadable files are skipped, not fatal
    expect(await findHusks([husk, live, stub, missing], counts)).toEqual([husk]);
  });
});

describe("extractSessionRefs", () => {
  it("pulls local uuids and claude.ai ids out of bare and URL trailer values", () => {
    const refs = extractSessionRefs(
      [
        "https://claude.ai/code/session_01QWSd4ysdZr5ZeJkpL6bbV4",
        "3FCDC692-F65F-4985-8295-9B222361E14D",
        "not a session ref",
        "",
      ].join("\n"),
    );
    expect(refs).toContain("session_01QWSd4ysdZr5ZeJkpL6bbV4");
    expect(refs).toContain("3fcdc692-f65f-4985-8295-9b222361e14d");
    expect(refs.length).toBe(2);
  });
});

describe("findMissingSessions", () => {
  const uuidA = "aaaaaaaa-1111-2222-3333-444444444444";
  const uuidB = "bbbbbbbb-1111-2222-3333-444444444444";

  it("reports trailer sessions with no local transcript by name or bridge mention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-cov-"));
    const onDisk = join(dir, `${uuidA}.jsonl`);
    const bridged = join(dir, "cccccccc-1111-2222-3333-444444444444.jsonl");
    await writeFile(onDisk, '{"type":"user"}\n');
    await writeFile(bridged, '{"type":"bridge-session","bridgeSessionId":"session_01FOUND"}\n');
    const gitLogFn = async () =>
      [
        `https://claude.ai/code/session_01FOUND`, // mentioned inside a local transcript → present
        `https://claude.ai/code/session_01LOST`, // nowhere on disk → missing
        uuidA, // file exists → present
        uuidB, // no file → missing
      ].join("\n");
    const missing = await findMissingSessions(dir, [onDisk, bridged], { gitLogFn });
    expect(missing.sort()).toEqual(["session_01LOST", uuidB].sort());
  });

  it("treats a missing git repo (or no trailers) as empty, never as an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-cov-"));
    expect(await findMissingSessions(dir, [])).toEqual([]);
    const gitLogFn = async () => "\n\n";
    expect(await findMissingSessions(dir, [], { gitLogFn })).toEqual([]);
  });
});
