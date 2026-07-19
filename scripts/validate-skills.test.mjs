import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseSkill, validateSkill } from "./validate-skills.mjs";

const validSkill = `---
name: sample-skill
description: Use for validating a sample skill.
---

# Sample

Read [the checklist](references/checklist.md).
`;

test("parses the required frontmatter and body", () => {
  assert.deepEqual(parseSkill(validSkill), {
    name: "sample-skill",
    description: "Use for validating a sample skill.",
    body: "# Sample\n\nRead [the checklist](references/checklist.md).",
  });
});

test("rejects assistant-specific shared frontmatter", () => {
  assert.throws(() => parseSkill(validSkill.replace("description:", "model: fast\ndescription:")), /unsupported frontmatter key/);
});

test("validates local references and OpenAI metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gradient-skill-test-"));
  const skillDir = path.join(root, "sample-skill");
  try {
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await mkdir(path.join(skillDir, "agents"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), validSkill);
    await writeFile(path.join(skillDir, "references", "checklist.md"), "# Checklist\n");
    await writeFile(
      path.join(skillDir, "agents", "openai.yaml"),
      'interface:\n  display_name: "Sample"\n  short_description: "Validate a sample"\n  default_prompt: "Use $sample-skill."\n',
    );
    await assert.doesNotReject(validateSkill(skillDir));
    await rm(path.join(skillDir, "references", "checklist.md"));
    await assert.rejects(validateSkill(skillDir), /missing referenced file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
