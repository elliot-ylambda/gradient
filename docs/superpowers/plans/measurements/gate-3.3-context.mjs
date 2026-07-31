// Gate for 3.3, second pass — in real tokens, not characters.
//
// Pass 1 said 45% of context in compacted sessions was *.png. That was an
// artifact: it counted base64 characters, and an image costs the model a fixed
// ~1.5k tokens no matter how many bytes its base64 runs to. Transcripts carry
// real per-turn usage, so context size at any turn is
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// and the growth between consecutive assistant turns is what the tool results
// in between actually cost. Attribute that delta, split across the results by
// character share when a turn produced several.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");

function ctx(u) {
  if (!u) return null;
  const n = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return n > 0 ? n : null;
}

function targetOf(name, input) {
  const i = input ?? {};
  if (typeof i.file_path === "string") return extname(i.file_path) ? `*${extname(i.file_path)}` : "file";
  if (typeof i.notebook_path === "string") return "*.ipynb";
  if (typeof i.command === "string") return `$ ${i.command.trim().split(/\s+/)[0]}`;
  if (typeof i.pattern === "string") return "grep/glob";
  if (typeof i.url === "string") return "web";
  return name;
}

function analyse(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const byTool = new Map(), byTarget = new Map();
  const pending = new Map();
  let compacted = false, prev = null, attributed = 0;
  // Results seen since the last assistant turn, awaiting a delta to split.
  let bucket = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isCompactSummary || o.subtype === "compact_boundary") { compacted = true; prev = null; bucket = []; continue; }
    const content = o.message?.content;
    const usage = ctx(o.message?.usage);

    if (usage !== null) {
      if (prev !== null && usage > prev && bucket.length) {
        const delta = usage - prev;
        const chars = bucket.reduce((a, b) => a + b.size, 0) || 1;
        for (const b of bucket) {
          const share = (delta * b.size) / chars;
          byTool.set(b.name, (byTool.get(b.name) ?? 0) + share);
          byTarget.set(b.target, (byTarget.get(b.target) ?? 0) + share);
          attributed += share;
        }
      }
      // A drop means the window was trimmed; restart rather than credit noise.
      prev = usage;
      bucket = [];
    }

    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") pending.set(b.id, { name: b.name, target: targetOf(b.name, b.input) });
      else if (b.type === "tool_result") {
        const size = typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length;
        const meta = pending.get(b.tool_use_id) ?? { name: "?", target: "?" };
        bucket.push({ ...meta, size: Math.max(size, 1) });
      }
    }
  }
  if (attributed === 0) return null;
  return { path, compacted, attributed, byTool, byTarget };
}

const all = [];
for (const dir of readdirSync(ROOT)) {
  const full = join(ROOT, dir);
  try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(full).filter(f => f.endsWith(".jsonl"))) {
    const a = analyse(join(full, f));
    if (a) all.push(a);
  }
}
const died = all.filter(a => a.compacted);

function top(maps, n) {
  const m = new Map();
  for (const x of maps) for (const [k, v] of x) m.set(k, (m.get(k) ?? 0) + v);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  return { rows: [...m].sort((a, b) => b[1] - a[1]).slice(0, n), total };
}

console.log(`sessions with attributable growth: ${all.length}`);
console.log(`of those, compacted:               ${died.length}`);
console.log("");
const pool = died;
const t = top(pool.map(a => a.byTool), 8);
console.log(`── real token cost, ${pool.length} compacted sessions (${(t.total / 1e6).toFixed(1)}M tokens attributed) ──`);
for (const [k, v] of t.rows) {
  console.log(`  ${String(((v / t.total) * 100).toFixed(1)).padStart(5)}%  ${(v / 1e6).toFixed(2)}M  ${k}`);
}
console.log("");
const g = top(pool.map(a => a.byTarget), 14);
console.log("── by target ──");
for (const [k, v] of g.rows) {
  console.log(`  ${String(((v / g.total) * 100).toFixed(1)).padStart(5)}%  ${(v / 1e6).toFixed(2)}M  ${k}`);
}
const ignorable = g.rows.filter(([k]) => k.startsWith("*.")).reduce((a, [, v]) => a + v, 0);
console.log("");
console.log(`attributable to file reads (the ".claudeignore" lever): ${((ignorable / g.total) * 100).toFixed(1)}%`);

// Is any single answer big enough to act on, per session?
const shares = pool.map(a => {
  const rows = [...a.byTarget].sort((x, y) => y[1] - x[1]);
  return rows.length ? rows[0][1] / a.attributed : 0;
});
shares.sort((a, b) => a - b);
const median = shares[Math.floor(shares.length / 2)] ?? 0;
console.log(`median share of the single largest source, per session:  ${(median * 100).toFixed(1)}%`);
console.log(`sessions where one source is >40% of growth:             ${shares.filter(s => s > 0.4).length}/${shares.length}`);
