import { describe, it, expect } from "vitest";
import { isNudgeText, computeMetrics } from "./insights.js";
import type { Turn } from "./types.js";

const t = (text: string): Turn => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  role: "user",
  sessionId: "s",
  text,
});

describe("isNudgeText", () => {
  it.each(["continue", "Continue.", "what's next?", "lgtm", "Looks good.", "yes", "ship it"])(
    "recognizes %s",
    text => expect(isNudgeText(text)).toBe(true),
  );

  it.each(["continue the refactor in auth.ts", "yesterday's build failed"])(
    "rejects %s",
    text => expect(isNudgeText(text)).toBe(false),
  );
});

describe("computeMetrics", () => {
  it("counts each metric from a mixed transcript", () => {
    const turns = [
      t("continue"),
      t("fix the login bug"),
      t("[Request interrupted by user]"),
      t("This session is being continued from a previous conversation."),
      t("<command-name>/compact</command-name>"),
      t("<command-name>/model</command-name> opus"),
      t("<command-name>/effort</command-name>"),
      t("<task-notification>x</task-notification>"),
      t(`make dev\n${"error: boom\n".repeat(40)}`),
    ];
    expect(computeMetrics(turns)).toEqual({
      prompts: 3,
      nudges: 1,
      interrupts: 1,
      continuations: 1,
      notifications: 1,
      compacts: 1,
      modelSwitches: 1,
      effortSwitches: 1,
      errorPastes: 1,
    });
  });

  it("honors configured injected-prompt patterns", () => {
    expect(computeMetrics([t("site injector: continue")], [/^site injector:/i]).prompts).toBe(0);
  });
});
