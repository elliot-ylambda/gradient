import { createInterface } from "node:readline/promises";

export type Confirm = (question: string, defaultYes: boolean) => Promise<boolean>;

/** Continuation prompts only make sense with a human attached: without a TTY
 * on both ends the answer is always "no", so hooks, pipes, and detached runs
 * never hang waiting for input. */
export function readlineConfirm(): Confirm {
  return async (question, defaultYes) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} › `))
      .trim()
      .toLowerCase();
    rl.close();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  };
}
