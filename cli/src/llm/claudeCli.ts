import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface RunResult { code: number; stdout: string; stderr: string }
type RunFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<RunResult>;
type WhichFn = (bin: string) => Promise<string | null>;
const OUTPUT_MAX_CHARS = 2_000_000;
const WHICH_OUTPUT_MAX_CHARS = 8_192;
const WHICH_TIMEOUT_MS = 3_000;

const defaultRun: RunFn = (cmd, args, input, opts) =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"], cwd: opts?.cwd, env: opts?.env, signal: opts?.signal,
    });
    let stdout = "", stderr = "";
    const collect = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      if (next.length > OUTPUT_MAX_CHARS) {
        child.kill();
        return next.slice(0, OUTPUT_MAX_CHARS);
      }
      return next;
    };
    child.stdout.on("data", d => (stdout = collect(stdout, d)));
    child.stderr.on("data", d => (stderr = collect(stderr, d)));
    child.on("error", err => resolveP({ code: 1, stdout: "", stderr: err.message }));
    child.on("close", code => resolveP({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {}); // ignore EPIPE if the process failed to start
    child.stdin.write(input);
    child.stdin.end();
  });

const defaultWhich: WhichFn = (bin) =>
  new Promise((resolveP) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, WHICH_TIMEOUT_MS);
    child.stdout.on("data", d => {
      out += d.toString();
      if (out.length > WHICH_OUTPUT_MAX_CHARS) {
        child.kill();
        finish(null);
      }
    });
    child.on("close", code => finish(code === 0 && out.trim() ? out.trim().split("\n")[0] : null));
    child.on("error", () => finish(null));
  });

/** Isolated text-only Claude CLI backend for untrusted transcript snippets. */
export class ClaudeCliBackend implements LLMBackend {
  name = "claude-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;
  /** Readable so callers/tests can assert the child never runs in the project. */
  readonly spawnCwd?: string;
  private extraEnv?: Record<string, string>;
  private executable?: string;

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
    try {
      const found = await this.whichFn("claude");
      if (!found || !isAbsolute(found)) return false;
      this.executable = await realpath(found);
      return true;
    } catch {
      return false;
    }
  }

  async complete(req: LLMRequest): Promise<string> {
    if (!this.executable && !(await this.available())) {
      throw new Error("claude CLI is unavailable or did not resolve to an absolute path");
    }
    // --system-prompt REPLACES Claude Code's default; --append-system-prompt would
    // leave the coding-agent framing (tools, cwd awareness) in front of ours. Both
    // callers here — scan's classifier and autopilot's judge — are pure LLM calls,
    // and the appended framing made the judge answer in prose about its temp cwd
    // instead of the JSON contract.
    const args = [
      "-p",
      "--output-format", "json",
      "--system-prompt", req.system,
      // These calls process untrusted transcript text. Safe mode disables user
      // hooks/plugins/MCP/skills; --tools "" separately removes built-ins.
      "--safe-mode",
      "--tools", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
    ];
    if (this.model) args.push("--model", this.model);
    const privateCwd = this.spawnCwd ?? await mkdtemp(join(tmpdir(), "gradient-claude-"));
    const opts = {
      cwd: privateCwd,
      env: this.extraEnv ? { ...process.env, ...this.extraEnv } : undefined,
      signal: req.signal,
    };
    try {
      // Prompt text stays off the process list and out of persisted Claude
      // sessions. The static system contract is safe to pass as an argument.
      const { code, stdout, stderr } = await this.runFn(this.executable!, args, req.prompt, opts);
      if (code !== 0) throw new Error(`claude CLI failed (${code}): ${stderr}`);
      try {
        const wrapper = JSON.parse(stdout) as { result?: string };
        return wrapper.result ?? stdout;
      } catch {
        return stdout; // not wrapped — return raw
      }
    } finally {
      if (!this.spawnCwd) await rm(privateCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
