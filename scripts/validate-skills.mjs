#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_FRONTMATTER = new Set(["name", "description"]);

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`invalid quoted YAML scalar: ${trimmed}`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseSkill(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md must start with YAML frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");

  const metadata = new Map();
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`unsupported frontmatter line: ${line}`);
    const [, key, raw] = match;
    if (metadata.has(key)) throw new Error(`duplicate frontmatter key: ${key}`);
    metadata.set(key, scalar(raw));
  }

  for (const key of metadata.keys()) {
    if (!ALLOWED_FRONTMATTER.has(key)) throw new Error(`unsupported frontmatter key: ${key}`);
  }
  const name = metadata.get("name");
  const description = metadata.get("description");
  if (!name) throw new Error("frontmatter name is required");
  if (!description) throw new Error("frontmatter description is required");
  if (!NAME_RE.test(name) || name.length > 63) throw new Error(`invalid skill name: ${name}`);

  const body = lines.slice(end + 1).join("\n").trim();
  if (!body) throw new Error("SKILL.md body is empty");
  if (body.split("\n").length > 500) throw new Error("SKILL.md body exceeds 500 lines; move detail into references/");
  return { name, description, body };
}

function localMarkdownLinks(source) {
  const links = [];
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    links.push(decodeURIComponent(target));
  }
  return links;
}

async function validateOpenAiMetadata(skillDir, name) {
  const metadataPath = path.join(skillDir, "agents", "openai.yaml");
  let source;
  try {
    source = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const key of ["display_name", "short_description", "default_prompt"]) {
    if (!new RegExp(`^\\s{2}${key}:\\s+.+$`, "m").test(source)) {
      throw new Error(`agents/openai.yaml is missing interface.${key}`);
    }
  }
  if (!source.includes(`$${name}`)) {
    throw new Error(`agents/openai.yaml default_prompt must invoke $${name}`);
  }
}

export async function validateSkill(skillDir) {
  const folder = path.basename(skillDir);
  if (!NAME_RE.test(folder)) throw new Error(`invalid skill directory name: ${folder}`);
  const skillPath = path.join(skillDir, "SKILL.md");
  const source = await readFile(skillPath, "utf8");
  const parsed = parseSkill(source);
  if (parsed.name !== folder) throw new Error(`frontmatter name ${parsed.name} does not match directory ${folder}`);

  const root = `${path.resolve(skillDir)}${path.sep}`;
  for (const target of localMarkdownLinks(source)) {
    const resolved = path.resolve(skillDir, target);
    if (!resolved.startsWith(root)) throw new Error(`reference escapes skill directory: ${target}`);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) throw new Error(`missing referenced file: ${target}`);
  }
  await validateOpenAiMetadata(skillDir, parsed.name);
  return parsed.name;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const skillsRoot = path.join(repoRoot, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(skillsRoot, entry.name));
  if (!skillDirs.length) throw new Error("no skills found");

  const names = [];
  for (const skillDir of skillDirs.sort()) names.push(await validateSkill(skillDir));
  console.log(`validated ${names.length} skill(s): ${names.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`skill validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
