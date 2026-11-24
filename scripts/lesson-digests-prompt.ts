// The pure half of the key-points and title backfill (scripts/lesson-digests.ts):
// which lessons need one, what the model is shown, and how its answer is read.
// Kept apart from the script so it can be tested without a model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../web/src/curriculum/transcript-parse.js";
import { checkDigestFields, checkTitle, type LessonDigestsFile } from "../core/lesson-digests.js";

const ascending = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);

/** Lessons with a transcript and no key points, ascending. */
export function missingDigests(transcriptLessons: number[], file: LessonDigestsFile): number[] {
  return ascending(transcriptLessons).filter((n) => !file.lessons[String(n)]?.keyPoints?.length);
}

/** Lessons on record (any history entry) with no title, ascending. */
export function missingTitles(lessons: number[], file: LessonDigestsFile): number[] {
  return ascending(lessons).filter((n) => !file.lessons[String(n)]?.title);
}

/**
 * One field's rule exactly as the teaching contract states it (the bullet that
 * starts "- **<field>**", up to the next bullet), so a backfilled lesson is held
 * to the same wording as one the tutor commits.
 */
export function contractRule(contract: string, field: string): string {
  const text = contract.replace(/\r\n/g, "\n");
  const start = text.indexOf(`- **${field}**`);
  if (start < 0) throw new Error(`teaching contract has no ${field} rule`);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/\n- \*\*/);
  return (end < 0 ? rest : rest.slice(0, end + 1)).trim();
}

export const keyPointsRule = (contract: string): string => contractRule(contract, "keyPoints");

function readContract(root: string): string {
  return readFileSync(join(root, "skills", "references", "teaching-contract.md"), "utf8");
}

export function readKeyPointsRule(root: string): string {
  return contractRule(readContract(root), "keyPoints");
}

export function readTitleRule(root: string): string {
  return contractRule(readContract(root), "title");
}

/**
 * The conversation as plain turns. Images go (the model can't see them and
 * they cost tokens); the text of every turn stays.
 */
export function conversationText(markdown: string): string {
  const parsed = parseTranscript(markdown);
  return parsed.turns
    .map((t) => {
      const who = t.role === "tutor" ? "Tutor" : t.spoken ? "Learner (spoken)" : "Learner";
      const body = t.text
        .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "[image]")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
        .trim();
      return `### ${who}\n\n${body}`;
    })
    .join("\n\n");
}

export function backfillPrompt(rule: string, lessonNumber: number, whatHappened: string, conversation: string): string {
  return [
    `Below is the full transcript of lesson ${lessonNumber} of a one-to-one tutoring course,`,
    `and the summary the tutor wrote when the lesson ended. Write the lesson's key points:`,
    `the record the learner reads when looking the lesson back up.`,
    ``,
    `The rule the tutor follows when writing them:`,
    ``,
    rule,
    ``,
    `The examples in the rule come from other lessons: never reuse their wording.`,
    `Work from what the conversation actually reached, not from the topic in general.`,
    `Output only the key points, one per line, each starting with "- ". No heading, no`,
    `numbering, nothing before or after.`,
    ``,
    `--- Summary written at the end of the lesson ---`,
    whatHappened || "(none recorded)",
    ``,
    `--- Transcript ---`,
    conversation,
  ].join("\n");
}

/** The model's "- " lines → key points, checked against the same limits as a commit. */
export function parseKeyPoints(text: string): { keyPoints: string[]; errors: string[] } {
  const keyPoints = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => /^\s*[-*•]\s+(.+)$/.exec(l)?.[1].trim())
    .filter((l): l is string => !!l);
  return { keyPoints, errors: checkDigestFields({ keyPoints, sources: [] }, "") };
}

/**
 * The title is written from the lesson's summary and its key points, not the
 * transcript: the key points were drawn from the transcript already, and this
 * keeps a title to a cent or two. L1–3 have no transcript and no key points, so
 * the summary is all there is.
 */
export function titlePrompt(rule: string, lessonNumber: number, whatHappened: string, keyPoints: string[]): string {
  return [
    `Below is the summary of lesson ${lessonNumber} of a one-to-one tutoring course, written by the`,
    `tutor when the lesson ended${keyPoints.length ? ", and the lesson's key points" : ""}. Write the lesson's title.`,
    ``,
    `The rule the tutor follows when writing it:`,
    ``,
    rule,
    ``,
    `The example in the rule comes from another lesson: never reuse it.`,
    `A summary often opens with the recall warm-up; that is not what the lesson was about.`,
    `Output only the title, on one line, with no quotation marks and nothing before or after.`,
    ``,
    `--- Summary written at the end of the lesson ---`,
    whatHappened || "(none recorded)",
    ...(keyPoints.length ? [``, `--- Key points ---`, ...keyPoints.map((p) => `- ${p}`)] : []),
  ].join("\n");
}

/** The model's answer → a title, checked against the same limits as a commit. */
export function parseTitle(text: string): { title: string; errors: string[] } {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const title = (lines[0] ?? "")
    .replace(/^(?:[-*•]\s+|#+\s+|title:\s*)/i, "")
    .replace(/^["“'‘](.*)["”'’]$/, "$1")
    .replace(/\.$/, "")
    .trim();
  const errors = checkTitle(title, "");
  if (lines.length > 1) errors.push("answer ran over more than one line: give only the title");
  return { title, errors };
}
