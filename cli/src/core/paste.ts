import type { Turn, Candidate } from "./types.js";
import { redact, stripUnsafeControls } from "./security.js";

export const PASTE_MIN_CHARS = 400;
export const PASTE_MIN_COUNT = 3;
export const PASTE_KEY_CHARS = 80;

const ERROR_MARKERS = /error|exception|failed|fatal|traceback|cannot find|undefined is not|command not found/i;
const KNOWN_EXECUTABLES = new Set([
  "npm", "npx", "pnpm", "yarn", "bun", "node", "deno", "tsc", "vite", "vitest", "jest",
  "eslint", "prettier", "make", "cmake", "bazel", "cargo", "rustc", "go", "python", "python3",
  "pip", "pytest", "uv", "ruff", "black", "git", "gh", "docker", "kubectl", "terraform",
  "gradle", "mvn", "java", "javac", "dotnet", "php", "composer", "ruby", "bundle", "rails",
  "mix", "elixir", "swift", "xcodebuild", "clang", "gcc", "curl", "wget", "ssh", "bash", "sh", "zsh",
]);

function executableName(token: string): string {
  const normalized = token.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  return normalized.split("/").pop()?.replace(/\.exe$/i, "").toLowerCase() ?? "";
}

/** Retain only an executable and a harmless-looking subcommand. Arguments,
 * paths, URLs, env assignments, and free-form headers never leave the machine. */
function commandKey(head: string): string | null {
  const clean = stripUnsafeControls(head).trim();
  if (!clean || redact(clean) !== clean || /(?:https?:\/\/|@|[`;$|]|\$\(|&&|\|\|)/.test(clean)) return null;

  const prefixed = /^[>$%]\s+/.test(clean);
  const tokens = clean.replace(/^[>$%]\s+/, "").split(/\s+/);
  if (tokens.length === 0 || /^[A-Z_][A-Z0-9_]*=/.test(tokens[0])) return null;
  const executable = executableName(tokens[0]);
  const customExecutable = /^[a-z][a-z0-9._+-]{1,40}$/.test(executable) && /[-_.]/.test(executable);
  if (!KNOWN_EXECUTABLES.has(executable) && !customExecutable && !prefixed) return null;

  const subcommand = tokens[1];
  const safeSubcommand = subcommand && /^[A-Za-z][A-Za-z0-9._+-]{0,30}$/.test(subcommand)
    ? subcommand.toLowerCase()
    : "";
  return `${executable}${safeSubcommand ? ` ${safeSubcommand}` : ""}`.slice(0, PASTE_KEY_CHARS);
}

function errorClass(head: string): string | null {
  const match = head.match(/^([A-Za-z][A-Za-z0-9_.-]{0,30}(?:Error|Exception)|Error|Fatal)(?::|\b)/);
  return match?.[1] ?? null;
}

/** Return the short command/header that identifies a long error-like paste. */
export function extractPasteKey(text: string): string | null {
  if (text.length <= PASTE_MIN_CHARS || !ERROR_MARKERS.test(text)) return null;
  const first = text.split("\n").find(line => line.trim().length > 0);
  if (!first) return null;
  const head = first.trim();
  return commandKey(head) ?? errorClass(head);
}

/** Group repeated error pastes without retaining their potentially sensitive bodies. */
export function detectPasteCandidates(prompts: Turn[]): Candidate[] {
  const groups = new Map<string, { count: number; sessions: Set<string>; assistants: Set<"claude-code" | "codex">; occurrences: { ts: string; sessionId: string }[] }>();
  for (const prompt of prompts) {
    if (prompt.role !== "user" || !prompt.text) continue;
    const key = extractPasteKey(prompt.text);
    if (!key) continue;
    const group = groups.get(key) ?? {
      count: 0,
      sessions: new Set<string>(),
      assistants: new Set<"claude-code" | "codex">(),
      occurrences: [],
    };
    group.count++;
    group.sessions.add(prompt.sessionId);
    group.occurrences.push({ ts: prompt.ts, sessionId: prompt.sessionId });
    group.assistants.add(prompt.assistant ?? "claude-code");
    groups.set(key, group);
  }

  const candidates: Candidate[] = [];
  for (const [key, group] of groups) {
    if (group.count < PASTE_MIN_COUNT) continue;
    candidates.push({
      kind: "paste",
      signature: key,
      examples: [`pasted output of: ${key}`],
      count: group.count,
      sessions: group.sessions.size,
      sessionIds: [...group.sessions],
      occurrences: group.occurrences,
      memberSignatures: [],
      confidence: "high",
      assistants: [...group.assistants],
    });
  }
  return candidates.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
