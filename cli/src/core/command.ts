export const COMMAND_NAME_MAX_CHARS = 100;
const COMMAND_NAME_RE = /^\/?[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** Canonical bounded slash-command token. Arguments, controls, whitespace,
 * malformed tags, and empty values are rejected rather than mined. */
export function normalizeCommandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (!command || command.length > COMMAND_NAME_MAX_CHARS ||
    /[\u0000-\u0020\u007f-\u009f]/.test(command) || !COMMAND_NAME_RE.test(command)) {
    return null;
  }
  return command;
}

/** Case-insensitive lookup key used by insights, classifiers, and adoption. */
export function commandKey(value: unknown): string | null {
  return normalizeCommandName(value)?.replace(/^\//, "").toLowerCase() ?? null;
}
