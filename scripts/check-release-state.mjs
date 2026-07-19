#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function websiteVersion(html) {
  return /class=["']ver["'][^>]*>v([^<]+)</.exec(html)?.[1] ?? null;
}

export function compareReleaseState(expected, actual) {
  const mismatches = [];
  for (const [surface, version] of Object.entries(actual)) {
    if (version !== expected) mismatches.push(`${surface}: expected ${expected}, found ${version ?? "missing"}`);
  }
  return mismatches;
}

async function fetchOk(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "cli", "package.json"), "utf8"));
  const expected = pkg.version;
  const headers = { "User-Agent": "gradient-release-check" };

  const [npm, release, site] = await Promise.all([
    fetchOk("https://registry.npmjs.org/gradient.md/latest", { headers }).then((response) => response.json()),
    fetchOk("https://api.github.com/repos/elliot-ylambda/gradient/releases/latest", { headers }).then((response) => response.json()),
    fetchOk("https://gradient.md", { headers }).then((response) => response.text()),
  ]);
  const actual = {
    npm: npm.version ?? null,
    "GitHub Release": typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : null,
    website: websiteVersion(site),
  };
  const mismatches = compareReleaseState(expected, actual);
  if (mismatches.length) {
    throw new Error(`release state is inconsistent:\n- ${mismatches.join("\n- ")}`);
  }
  console.log(`release ${expected} is aligned across npm, GitHub Releases, and gradient.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
