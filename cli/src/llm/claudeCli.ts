import { spawn } from "node:child_process";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface RunResult { code: number; stdout: string; stderr: string }
type RunFn = (cmd: string, args: string[], input: string) => Promise<RunResult>;
type WhichFn = (bin: string) => Promise<string | null>;

const defaultRun: RunFn = (cmd, args, input) =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
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

export class ClaudeCliBackend implements LLMBackend {
  name = "claude-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;

  constructor(deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string } = {}) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
  }

  async available(): Promise<boolean> {
    return (await this.whichFn("claude")) !== null;
  }

  async complete(req: LLMRequest): Promise<string> {
    const args = ["-p", req.prompt, "--output-format", "json", "--append-system-prompt", req.system];
    if (this.model) args.push("--model", this.model);
    const { code, stdout, stderr } = await this.runFn("claude", args, "");
    if (code !== 0) throw new Error(`claude CLI failed (${code}): ${stderr}`);
    try {
      const wrapper = JSON.parse(stdout) as { result?: string };
      return wrapper.result ?? stdout;
    } catch {
      return stdout; // not wrapped — return raw
    }
  }
}
