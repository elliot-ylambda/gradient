import { createInterface } from "node:readline/promises";
import type { Assistant, Config } from "./types.js";
import { loadConfig, saveConfig } from "../config.js";

/**
 * Which assistants this machine is optimizing for.
 *
 * The only question `optimize` ever asks, and it asks it once. Everything
 * downstream reads from it: which transcripts are mined, which instruction
 * files are inspected, where a skill is written, and whether the CLAUDE.md ↔
 * AGENTS.md bridge is worth proposing at all.
 *
 * This is the consent `init` used to collect. The verb is gone; the consent is
 * not, because writing into a second assistant's configuration is not something
 * to infer from a default.
 */

export type TargetChoice = "claude-code" | "codex" | "both";

export const TARGET_CHOICES: readonly TargetChoice[] = ["claude-code", "codex", "both"];

export function targetsFor(choice: TargetChoice): Assistant[] {
  return choice === "both" ? ["claude-code", "codex"] : [choice];
}

/** Parse `--target`; undefined means the flag was not given. Throws on a value
 *  that is not one of the three, rather than quietly optimizing the wrong thing. */
export function parseTargetFlag(value: string | boolean | undefined): Assistant[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TARGET_CHOICES.includes(value as TargetChoice)) {
    throw new Error(`unknown target: ${String(value)} (use ${TARGET_CHOICES.join("|")})`);
  }
  return targetsFor(value as TargetChoice);
}

export type TargetAsker = () => Promise<TargetChoice | null>;

/** Interactive chooser. Returns null when the user declines to answer, which is
 *  a real answer: nothing is written and nothing is assumed. */
export function readlineTargetAsker(): TargetAsker {
  return async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("\nWhich assistants should gradient optimize?\n");
    process.stdout.write("  [1] Claude Code\n  [2] Codex\n  [3] both\n");
    const answer = (await rl.question("  choose a number › ")).trim();
    rl.close();
    if (answer === "1") return "claude-code";
    if (answer === "2") return "codex";
    if (answer === "3") return "both";
    return null;
  };
}

export interface EnsureTargetsResult {
  targets: Assistant[];
  /**
   * True when nothing was configured before this call — whether the answer came
   * from a prompt or from `--target`.
   *
   * Not "did we ask": a first run that passes the flag is still a first run, and
   * gating setup on the prompt meant `gradient optimize --target both` on a
   * fresh machine configured itself and installed nothing.
   */
  firstRun: boolean;
}

/**
 * The configured targets, asking once if there are none.
 *
 * A non-interactive caller with no configuration gets an error naming the exact
 * flag to pass rather than a default. Guessing here would mean a cron job or a
 * hook silently deciding to write into an assistant's configuration the user
 * never mentioned.
 */
export async function ensureTargets(
  opts: { flag?: string | boolean; home?: string } = {},
  deps: { ask?: TargetAsker } = {},
): Promise<EnsureTargetsResult> {
  const config: Config = await loadConfig(opts.home);
  const configured = config.targets !== undefined && config.targets.length > 0;

  const fromFlag = parseTargetFlag(opts.flag);
  if (fromFlag) {
    // An explicit flag on a fresh install is also a decision worth remembering,
    // so the next run does not ask; on a configured install it is a one-off
    // override and must not rewrite the stored default.
    if (!configured) await saveConfig({ ...config, targets: fromFlag }, opts.home);
    return { targets: fromFlag, firstRun: !configured };
  }

  if (configured) return { targets: config.targets!, firstRun: false };

  const choice = await (deps.ask ?? readlineTargetAsker())();
  if (!choice) {
    throw new Error(
      "gradient does not know which assistants to optimize for. " +
      "Run it again with --target claude-code, --target codex, or --target both.",
    );
  }
  const targets = targetsFor(choice);
  await saveConfig({ ...config, targets }, opts.home);
  return { targets, firstRun: true };
}
