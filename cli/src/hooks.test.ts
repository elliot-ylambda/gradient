import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { CHECKPOINT_SUB, RECAP_SUB } from "./commands/continuity.js";
import { SESSION_START_SUB, SESSION_END_SUB } from "./commands/features.js";
import { RESPOND_SUB } from "./commands/autopilot.js";
import { DIGEST_SUB, REFRESH_SUB } from "./commands/board.js";

/**
 * Deliberately its own file, with nothing mocked: the point is that the command
 * line a feature writes into a settings file is one the real CLI answers.
 * cli.test.ts mocks the command modules, which would make this vacuous.
 */
const INSTALLED_SUBCOMMANDS = [
  CHECKPOINT_SUB, RECAP_SUB, SESSION_START_SUB, SESSION_END_SUB,
  RESPOND_SUB, DIGEST_SUB, REFRESH_SUB,
];

describe("the subcommands `gradient on` writes into settings", () => {
  /**
   * `on board` wrote `board digest` and `board refresh`. Nothing dispatched
   * either: both exited 2 and printed the whole help text — into SessionStart
   * and into UserPromptSubmit, so once per session and once per prompt, in the
   * one place a person cannot see a stack trace. Every test passed, because
   * each half was checked against itself: the writer against the string it
   * wrote, the dispatcher against the verb it already knew.
   */
  it("are all dispatched, and none of them is an unknown command", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-hooks-"));
    for (const subcommand of INSTALLED_SUBCOMMANDS) {
      const lines: string[] = [];
      const code = await main(subcommand.split(" "), {
        log: line => lines.push(line),
        home,
        readStdin: async () => ({}),
      });
      // 2 is the unknown-command exit. Report which one, and what it printed:
      // a hook that prints anything at all has already leaked into a session.
      expect(code, `\`${subcommand}\` → ${lines[0] ?? "(no output)"}`).toBe(0);
      expect(lines.join("\n"), `\`${subcommand}\` printed a usage error`).not.toMatch(/^Usage:/m);
    }
  });
});
