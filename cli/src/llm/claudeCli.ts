import { spawnSync } from "node:child_process";
import type { LLMBackend } from "./backend";

/** Default backend: shells out to the local `claude` CLI, reusing its auth. */
export const claudeCli: LLMBackend = {
  name: "claude-cli",

  async available(): Promise<boolean> {
    try {
      const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
      return r.status === 0;
    } catch {
      return false;
    }
  },

  async complete(prompt: string): Promise<string> {
    const r = spawnSync(
      "claude",
      ["-p", "--output-format", "json"],
      { input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.status !== 0) {
      throw new Error(`claude CLI exited ${r.status}: ${r.stderr?.trim() ?? ""}`);
    }
    const parsed = JSON.parse(r.stdout) as { result?: string };
    if (typeof parsed.result !== "string") {
      throw new Error("claude CLI: unexpected JSON shape (no .result)");
    }
    return parsed.result;
  },
};
