import { describe, expect, it } from "vitest";
import { readlineConfirm } from "./confirm.js";

describe("readlineConfirm", () => {
  it("answers no without prompting when there is no TTY", async () => {
    // vitest workers run without a TTY, so this exercises the headless guard
    // directly: the promise must resolve immediately rather than hang on stdin.
    const confirm = readlineConfirm();
    await expect(confirm("Continue?", true)).resolves.toBe(false);
    await expect(confirm("Continue?", false)).resolves.toBe(false);
  });
});
