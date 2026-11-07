#!/usr/bin/env node
// Autopilot's ship gate: replay the judge over real stops from this machine's
// Claude Code history and score it against what the user actually typed next.
//
//   cd cli && npm run build && node scripts/autopilot-eval.mjs [--limit 240] [--days 30]
//
// A stop is an assistant message followed by a user prompt. Its label is GO
// when that prompt is a plain go-ahead ("continue", "yes", "do it"), OTHER
// otherwise. Precision is the share of the pipeline's nudges that landed on a
// GO: the fraction of the time "Continue." was what the user would have sent.
// Makes at most one judge call per sampled stop through the configured backend.

import { copyFile, mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { respond } from "../dist/commands/respond.js";
import { loadConfig, projectKey } from "../dist/config.js";

const { values } = parseArgs({ options: { limit: { type: "string", default: "240" }, days: { type: "string", default: "30" } } });
const limit = Number(values.limit);
const since = Date.now() - Number(values.days) * 86_400_000;
const GO = /^(continue|go ahead|go for it|do it|proceed|keep going|yes|yep|yeah|yup|ok|okay|sure|please do|sounds good|lgtm)[.! ]*(please)?[.! ]*$/i;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block.type === "text").map(block => block.text ?? "").join(" ");
}

// One reading for both the sampling pass and the replay, so a stop's line index
// means the same line in each.
async function readLines(file) {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean);
}

async function transcripts() {
  const root = join(homedir(), ".claude", "projects");
  const out = [];
  for (const dir of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir, name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs >= since && info.size < 20_000_000) out.push(path);
    }
  }
  return out;
}

const stops = [];
for (const file of await transcripts()) {
  let sawAssistant = false;
  for (const [index, line] of (await readLines(file)).entries()) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.isSidechain) continue;
    if (record.type === "assistant") {
      if (textOf(record.message?.content).trim()) sawAssistant = true;
      continue;
    }
    if (record.type !== "user" || record.isMeta) continue;
    const content = record.message?.content;
    if (Array.isArray(content) && content.some(block => block.type === "tool_result")) continue;
    const text = textOf(content).trim();
    if (!text || text.length > 1500 || /^<|Caveat:|<command-|system-reminder|Stop hook feedback/.test(text)) continue;
    if (sawAssistant) stops.push({ file, upTo: index, go: GO.test(text) });
    sawAssistant = false;
  }
}

// Every go-ahead, then an even spread of the rest, up to the limit.
const go = stops.filter(stop => stop.go);
const other = stops.filter(stop => !stop.go);
const step = Math.max(1, Math.floor(other.length / Math.max(1, limit - go.length)));
const sample = [...go, ...other.filter((_, index) => index % step === 0)].slice(0, limit);
const goSampled = sample.filter(stop => stop.go).length;

const cwd = "/autopilot-eval";
const config = { ...await loadConfig(), autopilotProjects: { [projectKey(cwd)]: "nudge" }, autopilotBudget: 1 };
// Judge state (budgets, logs) goes to a scratch home, never the real one.
const stateHome = await mkdtemp(join(tmpdir(), "gradient-autopilot-eval-"));
// ...but with the user's own playbook, which the judge reads.
await mkdir(join(stateHome, ".config", "gradient"), { recursive: true });
await copyFile(join(homedir(), ".config", "gradient", "gradient.md"), join(stateHome, ".config", "gradient", "gradient.md")).catch(() => undefined);
let nudges = 0, right = 0, next = 0;
async function worker() {
  while (next < sample.length) {
    const index = next++;
    const stop = sample[index];
    const lines = (await readLines(stop.file)).slice(0, stop.upTo);
    const result = await respond(
      { session_id: `eval-${index}`, transcript_path: stop.file, cwd },
      { config, readLines: async () => lines, home: stateHome },
    );
    if (result.decision === "block") { nudges++; if (stop.go) right++; }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log(JSON.stringify({
  stops: stops.length, sampled: sample.length, goAheads: go.length, nudges,
  precision: nudges ? +(right / nudges).toFixed(2) : null,
  recall: goSampled ? +(right / goSampled).toFixed(2) : null,
}));
