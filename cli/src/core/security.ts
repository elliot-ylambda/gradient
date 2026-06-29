import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

/** Stable short id for a suggestion, derived from its normalized signature. */
export function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 10);
}

/** Lowercase kebab slug, safe for filenames and command names. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function sanitizeName(name: string): string {
  const s = slug(name);
  if (!s) throw new Error(`unsafe artifact name: "${name}"`);
  return s;
}

/** Resolve `target` under `base`, refusing anything that escapes it. */
export function assertInside(base: string, target: string): string {
  const b = resolve(base);
  const t = resolve(b, target);
  const rel = relative(b, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${base}: ${target}`);
  }
  return t;
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /(?<=(?:API|SECRET|TOKEN|KEY)\s*[=:]\s*)\S+/gi, // KEY=... assignments
];

/** Strip obvious secrets before any snippet leaves the machine for a model. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
