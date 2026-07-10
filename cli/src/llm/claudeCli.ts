import { spawn } from "node:child_process";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface RunResult { code: number; stdout: string; stderr: string }
type RunFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;
type WhichFn = (bin: string) => Promise<string | null>;

const defaultRun: RunFn = (cmd, args, input, opts) =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts?.cwd, env: opts?.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", err => resolveP({ code: 1, stdout: "", stderr: err.message }));
    child.on("close", code => resolveP({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {}); // ignore EPIPE if the process failed to start
    child.stdin.write(input);
    child.stdin.end();
  });

const defaultWhich: WhichFn = (bin) =>
  new Promise((resolveP) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [bin]);
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.on("close", code => resolveP(code === 0 && out.trim() ? out.trim().split("\n")[0] : null));
    child.on("error", () => resolveP(null));
  });

/** Every Claude Code tool, denied. Verified against `claude --disallowed-tools`:
 * unknown names emit a "matches no known tool" warning, so keep this list valid. */
export const DENIED_TOOLS = [
  "Bash", "BashOutput", "Edit", "Glob", "Grep", "KillShell",
  "NotebookEdit", "Read", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write",
];

export class ClaudeCliBackend implements LLMBackend {
  name = "claude-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;
  /** Readable so callers/tests can assert the child never runs in the project. */
  readonly spawnCwd?: string;
  private extraEnv?: Record<string, string>;

  constructor(
    deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string; spawnCwd?: string; extraEnv?: Record<string, string> } = {},
  ) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
    this.spawnCwd = deps.spawnCwd;
    this.extraEnv = deps.extraEnv;
  }

  async available(): Promise<boolean> {
    return (await this.whichFn("claude")) !== null;
  }

  async complete(req: LLMRequest): Promise<string> {
    // --system-prompt REPLACES Claude Code's default; --append-system-prompt would
    // leave the coding-agent framing (tools, cwd awareness) in front of ours. Both
    // callers here — scan's classifier and autopilot's judge — are pure LLM calls,
    // and the appended framing made the judge answer in prose about its temp cwd
    // instead of the JSON contract.
    const args = [
      "-p", req.prompt,
      "--output-format", "json",
      "--system-prompt", req.system,
      // Both callers are text->text. Without this the child inherits the full
      // toolset and will use it — and its input (transcript tails, mined prompts)
      // is untrusted. An empty --allowed-tools does NOT block; only a deny list does.
      "--disallowed-tools", ...DENIED_TOOLS,
    ];
    if (this.model) args.push("--model", this.model);
    const opts = {
      cwd: this.spawnCwd,
      env: this.extraEnv ? { ...process.env, ...this.extraEnv } : undefined,
    };
    const { code, stdout, stderr } = await this.runFn("claude", args, "", opts);
    if (code !== 0) throw new Error(`claude CLI failed (${code}): ${stderr}`);
    try {
      const wrapper = JSON.parse(stdout) as { result?: string };
      return wrapper.result ?? stdout;
    } catch {
      return stdout; // not wrapped — return raw
    }
  }
}
