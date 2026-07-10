import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTranscriptLines } from "./tail.js";

const execFileP = promisify(execFile);

// Coverage sanity checks: gradient mines whatever transcripts exist on disk, but the
// corpus can silently shrink — claude.ai-bridged sessions have (at times) stopped writing
// local transcripts, and retention reaps old ones. A scan over a shrunken corpus looks
// identical to a scan over a complete one, so these checks make the gaps loud. They are
// advisory only and must never fail a scan.

/**
 * Transcripts that carry claude.ai bridge markers but yielded no minable user prompts:
 * husks whose conversation lives only at claude.ai. Files with zero prompts and no
 * bridge marker are just opened-but-never-used stubs and are not flagged.
 */
export async function findHusks(
  files: string[],
  userTurnCounts: Map<string, number>,
): Promise<string[]> {
  const husks: string[] = [];
  for (const f of files) {
    if ((userTurnCounts.get(f) ?? 0) > 0) continue;
    let content: string;
    try {
      content = (await readTranscriptLines(f)).join("\n");
    } catch {
      continue;
    }
    if (content.includes('"type":"bridge-session"')) husks.push(f);
  }
  return husks;
}

const LOCAL_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CLOUD_ID = /session_[A-Za-z0-9]+/g;

/**
 * Session ids named in Claude-Session git-trailer values: local transcript uuids and
 * claude.ai session_… ids, in bare or https://claude.ai/code/<id> URL form.
 */
export function extractSessionRefs(trailerValues: string): string[] {
  const refs = new Set<string>();
  for (const m of trailerValues.matchAll(LOCAL_ID)) refs.add(m[0].toLowerCase());
  for (const m of trailerValues.matchAll(CLOUD_ID)) refs.add(m[0]);
  return [...refs];
}

async function gitTrailerLog(dir: string, sinceDays: number): Promise<string> {
  const { stdout } = await execFileP(
    "git",
    ["-C", dir, "log", `--since=${sinceDays} days ago`, "--format=%(trailers:key=Claude-Session,valueonly)"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

export interface MissingSessionsOptions {
  /** Trailer look-back window; defaults to 30 days so reaped ancient history isn't noise. */
  sinceDays?: number;
  /** Injectable trailer source for tests. */
  gitLogFn?: (dir: string, sinceDays: number) => Promise<string>;
}

/**
 * Sessions referenced by recent Claude-Session git trailers in <projectDir> that have no
 * local transcript. A local uuid counts as present when a collected file is named after
 * it; a claude.ai session_… id counts as present when some collected transcript mentions
 * it (bridged sessions record their bridge id in bridge-session entries). Whatever
 * remains was committed from a conversation this machine cannot mine — cloud-only,
 * another machine, or already cleaned up. Not a git repo (or no git) is normal: [].
 */
export async function findMissingSessions(
  projectDir: string,
  files: string[],
  opts: MissingSessionsOptions = {},
): Promise<string[]> {
  const gitLogFn = opts.gitLogFn ?? gitTrailerLog;
  let trailers: string;
  try {
    trailers = await gitLogFn(projectDir, opts.sinceDays ?? 30);
  } catch {
    return [];
  }
  const refs = extractSessionRefs(trailers);
  if (refs.length === 0) return [];
  const localIds = new Set(files.map(f => basename(f, ".jsonl").toLowerCase()));
  const cloudIds = new Set<string>();
  if (refs.some(r => r.startsWith("session_"))) {
    for (const f of files) {
      let content: string;
      try {
        content = (await readTranscriptLines(f)).join("\n");
      } catch {
        continue;
      }
      for (const m of content.matchAll(CLOUD_ID)) cloudIds.add(m[0]);
    }
  }
  return refs.filter(r => !localIds.has(r) && !cloudIds.has(r));
}
