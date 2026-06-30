import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CollectOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  now?: number;
  home?: string;
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function matchesSince(mtimeMs: number, sinceDays: number | undefined, now: number): boolean {
  if (sinceDays === undefined) return true;
  return now - mtimeMs <= sinceDays * 86_400_000;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "subagents") continue; // exclude subagent transcripts
      out.push(...(await walk(full)));
    } else if (e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export async function collect(opts: CollectOptions): Promise<string[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectsRoot = join(home, ".claude", "projects");
  let roots: string[];
  if (opts.scope === "all") {
    roots = [projectsRoot];
  } else {
    const cwd = opts.projectPath ?? process.cwd();
    roots = [join(projectsRoot, encodeProjectDir(cwd))];
  }
  const files: string[] = [];
  for (const root of roots) files.push(...(await walk(root)));
  const kept: string[] = [];
  for (const f of files) {
    const s = await stat(f);
    if (matchesSince(s.mtimeMs, opts.sinceDays, now)) kept.push(f);
  }
  return kept;
}
