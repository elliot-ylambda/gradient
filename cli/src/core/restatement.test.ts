import { describe, expect, it } from "vitest";
import { bodySubstance, isRestatement, restatementScore } from "./restatement.js";
import type { Suggestion } from "./types.js";

const PREAMBLE =
  "This artifact records an observed habit; it grants no standing authorization. " +
  "Use it only when the user's current request explicitly asks for this workflow. " +
  "Confirm again before destructive, irreversible, external, production, publishing, " +
  "credential, privacy-sensitive, or spending actions.";

function command(body: string, examples: string[]): Suggestion {
  return {
    id: "s1",
    name: "candidate",
    title: "t",
    rationale: "r",
    evidence: { count: 5, sessions: 5 },
    confidence: "high",
    examples,
    payload: { type: "command", commandName: "candidate", body },
  };
}

describe("bodySubstance", () => {
  it("removes the standing-authorization preamble", () => {
    expect(bodySubstance(`${PREAMBLE}\n\nObserved workflow:\nPush all these changes to main.`))
      .toBe("push all these changes to main");
  });

  it("removes checklist scaffolding and list numbering", () => {
    const body = `${PREAMBLE}\n\nObserved checklist (not permission to execute later steps):\n` +
      "1. run the tests\n2. push\n\n" +
      "First show the checklist and ask which steps the user wants performed now. " +
      "Do not infer permission for one step from approval of another.";
    expect(bodySubstance(body)).toBe("run the tests push");
  });

  it("is empty when the body is scaffolding all the way down", () => {
    expect(bodySubstance(`${PREAMBLE} Reminder: `)).toBe("");
  });
});

describe("restatementScore", () => {
  it("scores a verbatim echo of the prompt at 1", () => {
    expect(restatementScore(
      `${PREAMBLE}\n\nObserved workflow:\nPush all these changes to main.`,
      ["Push all these changes to main."],
    )).toBe(1);
  });

  it("treats a scaffolding-only body as a total restatement", () => {
    // Nothing to compare means nothing was contributed; the artifact is the
    // preamble plus the prompt's own word.
    expect(restatementScore(`${PREAMBLE} Reminder: Continue`, ["Continue"])).toBe(1);
  });

  it("falls well below the threshold when the body adds real steps", () => {
    const body = `${PREAMBLE}\n\nObserved workflow:\n` +
      "1. Run `pnpm -w lint --fix` and stage only the files it rewrote\n" +
      "2. Rebase onto origin/main, resolving lockfile conflicts by regenerating\n" +
      "3. Push with --force-with-lease so a concurrent push is not clobbered\n" +
      "4. Watch the required checks and re-run only the flaky e2e shard";
    expect(restatementScore(body, ["push all these changes to main"])).toBeLessThan(0.4);
  });

  it("does not credit an artifact for repeating one prompt of many", () => {
    // The body echoes example 1 only. It still added nothing.
    expect(restatementScore(
      `${PREAMBLE}\n\nObserved workflow:\nDeploy to production.`,
      ["Deploy to production.", "check the dashboards", "roll back if p99 spikes"],
    )).toBe(1);
  });
});

describe("isRestatement", () => {
  it("drops a command whose body is the prompt", () => {
    expect(isRestatement(command(
      `${PREAMBLE}\n\nObserved workflow:\nPush all these changes to main.`,
      ["Push all these changes to main."],
    ))).toBe(true);
  });

  it("keeps a command whose body contributes instructions", () => {
    expect(isRestatement(command(
      `${PREAMBLE}\n\nObserved workflow:\n` +
      "1. Regenerate the lockfile with `pnpm install --lockfile-only`\n" +
      "2. Verify no phantom dependency was hoisted into the root\n" +
      "3. Commit the lockfile separately so the diff stays reviewable",
      ["push all these changes to main"],
    ))).toBe(false);
  });

  it("drops a loop whose instruction is the nudge itself", () => {
    expect(isRestatement({
      ...command("", ["Continue"]),
      payload: { type: "loop", instruction: `${PREAMBLE} Reminder: Continue` },
    })).toBe(true);
  });

  it("never judges a hook, whose evidence is counted events rather than prose", () => {
    expect(isRestatement({
      ...command("", ["/compact", "/compact"]),
      payload: { type: "hook", event: "PreCompact", description: "/compact", subcommand: "checkpoint" },
    })).toBe(false);
  });

  it("keeps anything with no examples to compare against", () => {
    expect(isRestatement(command(`${PREAMBLE}\n\nObserved workflow:\nShip it.`, []))).toBe(false);
  });

  it("keeps a multi-step checklist even when every step is the user's wording", () => {
    // A sequence artifact's contribution is the composition, not the prose: the
    // user never said these three go together in this order.
    expect(isRestatement(command(
      `${PREAMBLE}\n\nObserved checklist (not permission to execute later steps):\n` +
      "1. run the tests\n2. push all these changes to main\n3. open a pull request\n\n" +
      "First show the checklist and ask which steps the user wants performed now. " +
      "Do not infer permission for one step from approval of another.",
      ["run the tests", "push all these changes to main", "open a pull request"],
    ))).toBe(false);
  });
});

// The body of a command suggestion is always rebuilt locally from the candidate
// (detect.ts never trusts model-authored artifact text), so a single-prompt
// command can only ever be its prompt with a preamble. These pin that coupling:
// if detect starts contributing content, these fail and the filter needs
// revisiting rather than silently deleting suggestions that gained substance.
describe("the generator's structural ceiling", () => {
  it("scores detect's own single-instruction body as a total restatement", () => {
    const instruction = "regenerate the api client";
    expect(restatementScore(`${PREAMBLE}\n\nObserved workflow:\n${instruction}`, [instruction])).toBe(1);
  });
});
