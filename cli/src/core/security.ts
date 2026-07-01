import { resolve, relative, isAbsolute } from "node:path";

export function assertInside(base: string, target: string): void {
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${b}: ${t}`);
  }
}

export function sanitizeName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return name || "untitled";
}

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Za-z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{3,}/g,
  /\bgh[a-z]_[A-Za-z0-9]{20,}/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
