// The pure half of the key-points backfill (scripts/lesson-digests.ts): which
// lessons need one, what the model is shown, and how its answer is read.
// Kept apart from the script so it can be tested without a model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../web/src/curriculum/transcript-parse.js";
import { checkDigestFields, type LessonDigestsFile } from "../core/lesson-digests.js";

/** Lessons with a transcript and no digest, ascending. */
export function missingDigests(transcriptLessons: number[], file: LessonDigestsFile): number[] {
  return [...new Set(transcriptLessons)].filter((n) => !file.lessons[String(n)]).sort((a, b) => a - b);
}

/**
 * The keyPoints rule exactly as the teaching contract states it, so a
 * backfilled lesson is held to the same wording as one the tutor commits.
 */
export function keyPointsRule(contract: string): string {
  const text = contract.replace(/\r\n/g, "\n");
  const start = text.indexOf("- **keyPoints**");
  if (start < 0) throw new Error("teaching contract has no keyPoints rule");
  const rest = text.slice(start);
  const end = rest.slice(1).search(/\n- \*\*/);
  return (end < 0 ? rest : rest.slice(0, end + 1)).trim();
}

export function readKeyPointsRule(root: string): string {
  return keyPointsRule(readFileSync(join(root, "skills", "references", "teaching-contract.md"), "utf8"));
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
