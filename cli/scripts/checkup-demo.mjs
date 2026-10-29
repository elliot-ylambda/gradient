#!/usr/bin/env node
// A repeatable public example. Every file and setting lives in a disposable home.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runner = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugin/bin/gradient.mjs");
const sandbox = await mkdtemp(join(tmpdir(), "gradient-checkup-demo-"));
const project = join(sandbox, "example project");
const home = join(sandbox, "home");
const originals = {
  "CLAUDE.md": "# Project instructions\n\n- Run `scripts/old-check.sh` before opening a PR.\n",
  "AGENTS.md": "# Shared instructions\n\n- Keep user-facing error messages clear and actionable.\n",
};

function run(args, json = true) {
  const stdout = execFileSync(process.execPath, [runner, ...args, ...(json ? ["--json"] : [])], {
    cwd: project,
    env: {
      ...process.env,
      GRADIENT_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return json ? JSON.parse(stdout) : stdout;
}

try {
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, content] of Object.entries(originals)) await writeFile(join(project, name), content);

  const before = run(["optimize", "--target", "both"]);
  const fixes = before.findings.filter(finding => ["stale", "drift"].includes(finding.family));
  assert.equal(fixes.length, 2, "fixture must expose one stale reference and one required import");
  const applied = run(["optimize", "--apply", fixes.map(finding => finding.id).join(",")]);
  assert.equal(applied.applied.length, 2);
  assert.equal(applied.skipped.length, 0);
  assert.ok(applied.runId);

  const after = run(["optimize"]);
  assert.equal(after.findings.filter(finding => ["stale", "drift"].includes(finding.family)).length, 0);
  assert.match(await readFile(join(project, "CLAUDE.md"), "utf8"), /^@AGENTS\.md/m);

  run(["optimize", "--undo", applied.runId], false);
  for (const [name, content] of Object.entries(originals)) {
    assert.equal(await readFile(join(project, name), "utf8"), content, `${name} must restore byte for byte`);
  }
  console.log("Synthetic checkup fixture — no personal history or model calls");
  console.log("PASS  Found a stale script reference and a required instruction import");
  console.log("PASS  Applied the two selected fixes");
  console.log("PASS  Rechecked: both findings resolved");
  console.log("PASS  Undid the run: original files restored byte for byte");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
