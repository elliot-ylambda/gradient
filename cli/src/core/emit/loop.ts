import type { Suggestion } from "../types.js";

export function emitLoop(s: Suggestion): { command: string } {
  if (s.payload.type !== "loop") throw new Error("emitLoop needs a loop payload");
  const verb = s.payload.cadence ? "/schedule" : "/loop";
  const cadence = s.payload.cadence ? `${s.payload.cadence} ` : "";
  return { command: `${verb} ${cadence}"${s.payload.instruction}"` };
}
