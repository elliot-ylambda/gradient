import type { Suggestion } from "../types.js";

export function emitLoop(s: Suggestion): { command: string } {
  if (s.payload.type !== "loop") throw new Error("emitLoop needs a loop payload");
  // Single line + escaped quotes so an embedded `"` or newline can't break out of the argument.
  const instruction = s.payload.instruction.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"').trim();
  const verb = s.payload.cadence ? "/schedule" : "/loop";
  // Restrict cadence to a safe charset (cron-ish): digits, letters, space, * / , - :
  const cadence = s.payload.cadence
    ? `${s.payload.cadence.replace(/[^A-Za-z0-9 */,:-]/g, "").trim()} `
    : "";
  return { command: `${verb} ${cadence}"${instruction}"` };
}
