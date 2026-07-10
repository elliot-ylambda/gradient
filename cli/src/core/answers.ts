import type { Assistant, Candidate } from "./types.js";
import type { DialogueTurn } from "./parse.js";
import { classifyPrompt } from "./filter.js";
import { normalize, similarity } from "./cluster.js";

export const ANSWER_MAX_CHARS = 80;
export const PAIR_MIN_COUNT = 3;
export const QUESTION_SIM = 0.4;

export interface AnswerPair {
  question: string;
  answer: string;
  sessionId: string;
  ts: string;
  assistant: Assistant;
}

function questionStem(question: string): string {
  const end = question.indexOf("?");
  return end >= 0 ? question.slice(0, end + 1) : question;
}

/** Convert trigram Jaccard to Dice after dropping volatile option prose. */
function questionSimilarity(a: string, b: string): number {
  const jaccard = similarity(normalize(questionStem(a)), normalize(questionStem(b)));
  return jaccard === 0 ? 0 : (2 * jaccard) / (1 + jaccard);
}

function endsWithQuestion(text: string): boolean {
  return text.trim().slice(-40).includes("?");
}

export function extractAnswerPairs(dialogue: DialogueTurn[]): AnswerPair[] {
  const pairs: AnswerPair[] = [];
  for (let i = 0; i < dialogue.length - 1; i++) {
    const question = dialogue[i];
    const answerTurn = dialogue[i + 1];
    if (question.role !== "assistant" || answerTurn.role !== "user") continue;
    if (question.sessionId !== answerTurn.sessionId || !endsWithQuestion(question.text)) continue;
    const answer = answerTurn.text.trim();
    if (!answer || answer.length >= ANSWER_MAX_CHARS || classifyPrompt(answer) !== "human") continue;
    pairs.push({
      question: question.text.trim(),
      answer,
      sessionId: answerTurn.sessionId,
      ts: answerTurn.ts,
      assistant: answerTurn.assistant ?? "claude-code",
    });
  }
  return pairs;
}

export function mineAnswerCandidates(pairs: AnswerPair[]): Candidate[] {
  const byAnswer = new Map<string, AnswerPair[]>();
  for (const pair of pairs) {
    const key = normalize(pair.answer);
    if (!key) continue;
    byAnswer.set(key, [...(byAnswer.get(key) ?? []), pair]);
  }

  const candidates: Candidate[] = [];
  for (const [answer, group] of byAnswer) {
    const subgroups: AnswerPair[][] = [];
    for (const pair of group) {
      const host = subgroups.find(subgroup =>
        questionSimilarity(subgroup[0].question, pair.question) >= QUESTION_SIM,
      );
      if (host) host.push(pair);
      else subgroups.push([pair]);
    }

    for (const subgroup of subgroups) {
      if (subgroup.length < PAIR_MIN_COUNT) continue;
      const sessions = new Set(subgroup.map(pair => pair.sessionId));
      candidates.push({
        kind: "answer",
        signature: `${answer} ← ${subgroup[0].question.slice(0, 60)}`,
        examples: subgroup.slice(0, 5).map(pair => `Q: ${pair.question.slice(0, 80)} → A: ${pair.answer}`),
        count: subgroup.length,
        sessions: sessions.size,
        sessionIds: [...sessions],
        confidence: "inferred",
        assistants: [...new Set(subgroup.map(pair => pair.assistant))],
      });
    }
  }
  return candidates.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
