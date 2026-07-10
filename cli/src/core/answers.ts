import type { Candidate } from "./types.js";
import type { DialogueTurn } from "./parse.js";
import { classifyPrompt } from "./filter.js";
import { normalize, similarity } from "./cluster.js";
import { redact } from "./security.js";

export const ANSWER_MAX_CHARS = 40;
export const QUESTION_MAX_CHARS = 500;
export const ANSWER_MAX_PAIRS = 1_500;
export const ANSWER_MAX_PER_VALUE = 100;
export const ANSWER_MAX_CANDIDATES = 50;
export const PAIR_MIN_COUNT = 3;
export const PAIR_MIN_SESSIONS = 2;
export const QUESTION_SIM = 0.4;

const PREFERENCE_QUESTION = /\b(?:prefer|preference|format|formatting|style|tone|verbosity|concise|detailed|package manager|indentation|tabs?|spaces?|colour|color|language|framework|test runner|naming|convention|layout|output)\b/i;
const CONSEQUENTIAL_QUESTION = /\b(?:deploy|production|prod|publish|release|push|merge|delete|remove|destroy|drop|truncate|overwrite|send|email|message|post|upload|purchase|buy|spend|pay|charge|refund|transfer|approve|permission|authori[sz]e|credential|password|passcode|otp|one[- ]?time|token|secret|api.?key|private.?key|recovery|account|billing|customer|personal|pii|ssn|social security|address|phone|sudo|curl|wget|ssh|kubectl|terraform)\b/i;
const AMBIGUOUS_APPROVAL = /^(?:y(?:es)?|n(?:o)?|ok(?:ay)?|sure|always|never|continue|proceed|do it|approve(?:d)?|allow|deny|[0-9]+)[.!\s]*$/i;

export interface AnswerPair {
  question: string;
  answer: string;
  sessionId: string;
  ts: string;
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

/** Only stable, low-impact presentation/tool preferences can become a rule.
 * Short approvals and answers to consequential questions are observations,
 * never standing authorization. */
export function isSafePreferencePair(question: string, answer: string): boolean {
  const q = question.trim().slice(-QUESTION_MAX_CHARS);
  const a = answer.trim();
  if (!PREFERENCE_QUESTION.test(q) || CONSEQUENTIAL_QUESTION.test(q)) return false;
  if (redact(q) !== q || redact(a) !== a) return false;
  if (AMBIGUOUS_APPROVAL.test(a) || /(?:https?:\/\/|@|[\\/])/.test(a)) return false;
  if (!/^[A-Za-z][A-Za-z ._+-]*$/.test(a)) return false;
  return a.split(/\s+/).length <= 6;
}

export function extractAnswerPairs(
  dialogue: DialogueTurn[],
  ignore: RegExp[] = [],
  maxPairs = ANSWER_MAX_PAIRS,
): AnswerPair[] {
  const pairs: AnswerPair[] = [];
  for (let i = 0; i < dialogue.length - 1; i++) {
    if (pairs.length >= maxPairs) break;
    const question = dialogue[i];
    const answerTurn = dialogue[i + 1];
    if (question.role !== "assistant" || answerTurn.role !== "user") continue;
    if (!question.sessionId || question.sessionId === "?" ||
      question.sessionId !== answerTurn.sessionId || !endsWithQuestion(question.text)) continue;
    const answer = answerTurn.text.trim();
    const boundedQuestion = question.text.trim().slice(-QUESTION_MAX_CHARS);
    if (!answer || answer.length > ANSWER_MAX_CHARS || classifyPrompt(answer, ignore) !== "human" ||
      !isSafePreferencePair(boundedQuestion, answer)) continue;
    pairs.push({
      question: boundedQuestion,
      answer,
      sessionId: answerTurn.sessionId,
      ts: answerTurn.ts,
    });
  }
  return pairs;
}

export function mineAnswerCandidates(pairs: AnswerPair[]): Candidate[] {
  const byAnswer = new Map<string, AnswerPair[]>();
  for (const pair of pairs.slice(0, ANSWER_MAX_PAIRS)) {
    if (!isSafePreferencePair(pair.question, pair.answer) || !pair.sessionId || pair.sessionId === "?") continue;
    const key = normalize(pair.answer);
    if (!key) continue;
    const group = byAnswer.get(key) ?? [];
    if (group.length < ANSWER_MAX_PER_VALUE) group.push(pair);
    byAnswer.set(key, group);
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
      if (sessions.size < PAIR_MIN_SESSIONS) continue;
      candidates.push({
        kind: "answer",
        signature: `${answer} ← ${subgroup[0].question.slice(0, 60)}`,
        examples: subgroup.slice(0, 5).map(pair => `Q: ${pair.question.slice(0, 80)} → A: ${pair.answer}`),
        count: subgroup.length,
        sessions: sessions.size,
        sessionIds: [...sessions],
        confidence: "inferred",
      });
      if (candidates.length >= ANSWER_MAX_CANDIDATES) break;
    }
    if (candidates.length >= ANSWER_MAX_CANDIDATES) break;
  }
  return candidates.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
