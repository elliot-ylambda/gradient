import { describe, expect, it } from "vitest";
import { NOTIFY_BODY, NOTIFY_TITLE, notify } from "./notify.js";

describe("notify", () => {
  it("uses osascript with static text on macOS", async () => {
    const calls: Array<[string, string[]]> = [];
    await notify({ platform: "darwin", spawnFn: (command, args) => calls.push([command, args]) });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("osascript");
    expect(calls[0][1].join(" ")).toContain(NOTIFY_TITLE);
    expect(calls[0][1].join(" ")).toContain(NOTIFY_BODY);
  });

  it("uses notify-send on Linux", async () => {
    const calls: Array<[string, string[]]> = [];
    await notify({ platform: "linux", spawnFn: (command, args) => calls.push([command, args]) });
    expect(calls).toEqual([["notify-send", [NOTIFY_TITLE, NOTIFY_BODY]]]);
  });

  it("no-ops on other platforms and swallows spawn failures", async () => {
    let calls = 0;
    await expect(notify({
      platform: "win32",
      spawnFn: () => { calls++; },
    })).resolves.toBeUndefined();
    expect(calls).toBe(0);
    await expect(notify({
      platform: "darwin",
      spawnFn: () => { throw new Error("missing"); },
    })).resolves.toBeUndefined();
  });
});
