// Per-message feedback: validation, the wrap-up hand-off, the commit guard,
// and the durable distilled ledger. Mirrors usage.ts — pure logic here, file
// I/O kept to one thin append, everything unit-testable.
//
// The contract (agreed with the learner):
// - Only tutor (assistant) messages are rateable; a written note is required.
// - Only a double thumbs-down (-2) reaches the model mid-lesson; ±1/+2 are
//   siloed until wrap-up. Absence of a rating is NEVER a signal.
// - The durable record is a distilled "smart log" (context + takeaway per
//   item), one JSON line per rating in transcripts/feedback.jsonl — raw
//   ratings die with the session file.
import { appendFileSync, mkdirSync } from "node:fs";
import { PATHS } from "../scripts/lib.js";
import { RATING_LEVELS } from "./types.js";
import type { FeedbackLogEntry, MessageFeedback, RatingLevel, StoredSession } from "./types.js";

export const FEEDBACK_LEDGER = PATHS.feedbackLedger;

/** Longest accepted explanation — generous for prose, a guard against bulk. */
export const MAX_NOTE_LENGTH = 2000;

const LEVEL_LABEL: Record<RatingLevel, string> = {
  2: "⏫ strong thumbs-up (+2)",
  1: "👍 thumbs-up (+1)",
  [-1]: "👎 thumbs-down (-1)",
  [-2]: "⏬ strong thumbs-down (-2)",
};

export function levelLabel(level: RatingLevel): string {
  return LEVEL_LABEL[level];
}

/** What the feedback endpoint receives from the client. */
export interface FeedbackInput {
  messageId?: unknown;
  level?: unknown;
  note?: unknown;
}

/**
 * Validate a rating against the live session. Returns a human-readable error
 * or null when acceptable. Only non-hidden assistant messages are rateable,
 * and only while the lesson is active and uncommitted.
 */
export function validateFeedbackInput(
  input: FeedbackInput,
  session: StoredSession
): string | null {
  if (session.status !== "active") return `lesson is ${session.status}`;
  if (session.commit) return "lesson is already committed";
  if (!RATING_LEVELS.includes(input.level as RatingLevel)) {
    return `level must be one of ${RATING_LEVELS.join(", ")}`;
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!note) return "a written explanation is required with every rating";
  if (note.length > MAX_NOTE_LENGTH) return `note is too long (max ${MAX_NOTE_LENGTH} chars)`;
  const id = input.messageId;
  if (typeof id !== "string" || !id) return "messageId is required";
  const entry = session.transcript.find((t) => t.id === id);
  if (!entry) return `no message '${id}' in this lesson`;
  if (entry.hidden || entry.role !== "assistant") return "only tutor messages can be rated";
  return null;
}

/** First line-ish snippet of a rated message, for context in flags/hand-offs. */
export function messageSnippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The wrap-up hand-off: every siloed rating, ordered by transcript position,
 * with the learner's note and a snippet of the rated message. Double-downs that already
 * fired live are marked so the tutor doesn't re-litigate them. Empty string
 * when there is no feedback — no feedback is not a signal.
 */
export function composeFeedbackHandoff(session: StoredSession): string {
  const items = session.feedback ?? [];
  if (items.length === 0) return "";
  const byId = new Map(items.map((f) => [f.messageId, f]));
  const lines: string[] = [];
  for (const t of session.transcript) {
    const f = t.id ? byId.get(t.id) : undefined;
    if (!f) continue;
    const flaggedNote = f.flagged ? " [already surfaced live — don't re-litigate]" : "";
    lines.push(
      `- ${f.messageId} · ${levelLabel(f.level)}${flaggedNote}\n` +
        `  Note: "${f.note}"\n` +
        `  (rated message: "${messageSnippet(t.text)}")`
    );
  }
  return (
    `[Per-message feedback the learner left during this lesson — collected now, at wrap-up. ` +
    `Unrated messages carry no signal either way. Distill each item into ` +
    `patch.feedback.entries when you commit, and fold what you learn into your ` +
    `wrap-up + profile guesses per your instructions.]\n` +
    lines.join("\n")
  );
}

/**
 * The commit guard's pure core: the patch's distilled entries must cover the
 * session's rated messages exactly — every rating distilled, no entries for
 * messages the learner never rated. Returns an error naming the mismatches, or null.
 */
export function checkFeedbackCoverage(
  session: StoredSession,
  entries: FeedbackLogEntry[]
): string | null {
  const rated = new Set((session.feedback ?? []).map((f) => f.messageId));
  const covered = new Set(entries.map((e) => e.messageId));
  const missing = [...rated].filter((id) => !covered.has(id));
  const extra = [...covered].filter((id) => !rated.has(id));
  if (missing.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length) {
    parts.push(
      `patch.feedback.entries is missing the learner's rating(s) on: ${missing.join(", ")} — ` +
        `every rated message needs a distilled entry`
    );
  }
  if (extra.length) {
    parts.push(
      `patch.feedback.entries includes message id(s) the learner never rated: ${extra.join(", ")}`
    );
  }
  return parts.join("; ");
}

// --- Durable ledger ----------------------------------------------------------

/** Lesson metadata pinned to each ledger line (mirrors usage's LedgerMeta). */
export interface FeedbackLedgerMeta {
  lessonNumber: number;
  date: string;
  laneId: string;
  unitId: string;
  topicIds: string[];
  committedAt: string;
}

/** Pure builder for ledger lines — one JSON line per feedback item. */
export function buildFeedbackLedgerLines(
  meta: FeedbackLedgerMeta,
  entries: FeedbackLogEntry[]
): string[] {
  return entries.map((e) => JSON.stringify({ ...meta, ...e }));
}

/**
 * Append the distilled entries to transcripts/feedback.jsonl — one line per
 * rating, each self-contained with its lesson metadata. Rides the same git
 * commit as the lesson (transcripts/ is staged). This is the substrate for
 * smarter processing deferred for now: per-item lines cluster and query cleanly.
 */
export function appendFeedbackLedger(
  meta: FeedbackLedgerMeta,
  entries: FeedbackLogEntry[]
): string {
  mkdirSync(PATHS.transcriptsDir, { recursive: true });
  appendFileSync(FEEDBACK_LEDGER, buildFeedbackLedgerLines(meta, entries).join("\n") + "\n", "utf8");
  return "transcripts/feedback.jsonl";
}
