import { spawn } from "node:child_process";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface CodexRunResult { code: number; stdout: string; stderr: string }
type RunFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CodexRunResult>;
type WhichFn = (bin: string) => Promise<string | null>;

const defaultRun: RunFn = (cmd, args, input, opts) => new Promise(resolve => {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts?.cwd, env: opts?.env });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => (stdout += chunk));
  child.stderr.on("data", chunk => (stderr += chunk));
  child.on("error", error => resolve({ code: 1, stdout: "", stderr: error.message }));
  child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  child.stdin.on("error", () => {});
  child.stdin.write(input);
  child.stdin.end();
});

const defaultWhich: WhichFn = bin => new Promise(resolve => {
  const child = spawn(process.platform === "win32" ? "where" : "which", [bin]);
  let stdout = "";
  child.stdout.on("data", chunk => (stdout += chunk));
  child.on("close", code => resolve(code === 0 && stdout.trim() ? stdout.trim().split("\n")[0] : null));
  child.on("error", () => resolve(null));
});

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "computer_use",
  "apps",
  "image_generation",
  "multi_agent",
];

/** Pure text-to-text backend using the user's existing Codex login. The child
 * is ephemeral, ignores repo/user instructions, runs in a neutral directory,
 * has a read-only sandbox, and disables every interactive/tooling feature. */
export class CodexCliBackend implements LLMBackend {
  name = "codex-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;
  readonly spawnCwd?: string;

  constructor(deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string; spawnCwd?: string } = {}) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
    this.spawnCwd = deps.spawnCwd;
  }

  async available(): Promise<boolean> {
    return (await this.whichFn("codex")) !== null;
  }

  async complete(req: LLMRequest): Promise<string> {
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--color", "never",
    ];
    for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
    if (this.model) args.push("--model", this.model);
    args.push("-");
    const input = [
      "Follow the SYSTEM INSTRUCTIONS below as the highest-priority task instructions.",
      "This is a text-to-text classification request. Do not inspect files, run commands, browse, or use tools.",
      "Return only the requested final text.",
      "",
      "<SYSTEM_INSTRUCTIONS>",
      req.system,
      "</SYSTEM_INSTRUCTIONS>",
      "",
      "<UNTRUSTED_INPUT>",
      req.prompt,
      "</UNTRUSTED_INPUT>",
    ].join("\n");
    const { code, stdout, stderr } = await this.runFn("codex", args, input, { cwd: this.spawnCwd });
    if (code !== 0) throw new Error(`codex CLI failed (${code}): ${stderr}`);
    return stdout.trim();
  }
}
