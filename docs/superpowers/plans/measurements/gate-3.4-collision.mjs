// Gate for 3.4, second pass: separate genuine concurrent collisions from
// fork/resume replay. A resumed session inherits its parent's events verbatim,
// timestamps included — so parent and child look like two agents editing the
// same file in the same millisecond. F13 and F20 were both this bug.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");

function readSession(path) {
  let cwd = null;
  const edits = [];
  let first = null, last = null;
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd && !cwd) cwd = o.cwd;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (!["Edit", "Write", "NotebookEdit"].includes(block.name)) continue;
      const file = block.input?.file_path ?? block.input?.notebook_path;
      if (typeof file === "string" && Number.isFinite(ts)) edits.push({ ts, file, id: `${ts}|${file}` });
    }
  }
  if (first === null || !cwd || edits.length === 0) return null;
  return { path, cwd, first, last, edits, ids: new Set(edits.map(e => e.id)) };
}

const sessions = [];
for (const dir of readdirSync(ROOT)) {
  const full = join(ROOT, dir);
  try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(full).filter(f => f.endsWith(".jsonl"))) {
    const s = readSession(join(full, f));
    if (s) sessions.push(s);
  }
}

const byRepo = new Map();
for (const s of sessions) {
  if (!byRepo.has(s.cwd)) byRepo.set(s.cwd, []);
  byRepo.get(s.cwd).push(s);
}

const CLOSE_MS = 10 * 60 * 1000;
let overlapping = 0, colliding = 0, replayPairs = 0, genuine = 0;
const genuineHits = [];

for (const [repo, group] of byRepo) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      if (a.last < b.first || b.last < a.first) continue;
      overlapping++;

      // Shared *identical* edit events = one is a replay of the other's lineage.
      let shared = 0;
      for (const id of a.ids) if (b.ids.has(id)) shared++;
      const smaller = Math.min(a.ids.size, b.ids.size);
      const replayRatio = smaller === 0 ? 0 : shared / smaller;
      const isReplay = replayRatio >= 0.5;

      const bFiles = new Map();
      for (const e of b.edits) {
        if (!bFiles.has(e.file)) bFiles.set(e.file, []);
        bFiles.get(e.file).push(e);
      }
      const hits = [];
      for (const e of a.edits) {
        const other = bFiles.get(e.file);
        if (!other) continue;
        for (const o of other) {
          if (Math.abs(o.ts - e.ts) > CLOSE_MS) continue;
          // A byte-identical (ts, file) event is the same write seen twice.
          if (o.id === e.id) continue;
          hits.push({ file: e.file, gapMs: Math.abs(o.ts - e.ts) });
        }
      }
      if (hits.length === 0) continue;
      colliding++;
      if (isReplay) { replayPairs++; continue; }
      genuine++;
      const best = hits.reduce((m, h) => (h.gapMs < m.gapMs ? h : m));
      genuineHits.push({ repo, file: best.file, gapMin: (best.gapMs / 60000).toFixed(1), n: hits.length, ratio: replayRatio.toFixed(2) });
    }
  }
}

console.log(`sessions with edits:        ${sessions.length}`);
console.log(`time-overlapping pairs:     ${overlapping}`);
console.log(`pairs sharing an edited file within 10m (raw):  ${colliding}`);
console.log(`  of those, fork/resume replay of one lineage:  ${replayPairs}`);
console.log(`  GENUINELY concurrent, distinct writes:        ${genuine}`);
console.log("");
const byFile = new Map();
for (const g of genuineHits) {
  const k = `${g.repo}::${g.file}`;
  if (!byFile.has(k) || Number(byFile.get(k).gapMin) > Number(g.gapMin)) byFile.set(k, g);
}
console.log(`distinct (repo, file) genuinely co-edited:      ${byFile.size}`);
for (const g of [...byFile.values()].sort((x, y) => x.gapMin - y.gapMin).slice(0, 20)) {
  console.log(`  ${String(g.gapMin).padStart(5)}m  ${g.file.replace(homedir(), "~")}`);
}
