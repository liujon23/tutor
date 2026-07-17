import { readFileSync, writeFileSync } from "node:fs";
import type { LessonRecord } from "./types.js";

/** Resolves curriculum ids to display names (injected so this module stays dependency-free). */
export interface NameResolver {
  lane(id: string): string;
  unit(id: string): string;
  topic(id: string): string;
}

export interface HistoryEntry {
  number: number;
  date: string;
  body: string; // full markdown of the entry, including its "## Lesson N — date" header
}

const HEADER_RE = /^## Lesson (\d+) — (\d{4}-\d{2}-\d{2})\s*$/m;

/** Parse lesson-history.md into entries (file is reverse-chronological, newest first). */
export function parseHistory(raw: string): { preamble: string; entries: HistoryEntry[] } {
  const lines = raw.split("\n");
  const starts: { idx: number; number: number; date: string }[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^## Lesson (\d+) — (\d{4}-\d{2}-\d{2})\s*$/);
    if (m) starts.push({ idx, number: Number(m[1]), date: m[2] });
  });
  if (starts.length === 0) return { preamble: raw, entries: [] };
  const preamble = lines.slice(0, starts[0].idx).join("\n");
  const entries = starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    return { number: s.number, date: s.date, body: lines.slice(s.idx, end).join("\n").trimEnd() };
  });
  return { preamble, entries };
}

export function loadHistory(path: string) {
  return parseHistory(readFileSync(path, "utf8"));
}

export function nextLessonNumber(path: string): number {
  const { entries } = loadHistory(path);
  return entries.length === 0 ? 1 : Math.max(...entries.map((e) => e.number)) + 1;
}

export function lastN(path: string, n: number): HistoryEntry[] {
  return loadHistory(path).entries.slice(0, n); // newest first
}

const CONDENSE_FIELD_RES = [
  /^## Lesson \d+ — \d{4}-\d{2}-\d{2}\s*$/,
  /^\*\*Lane \/ Unit \/ Topic:\*\*/,
  /^\*\*Performance sketch:\*\*/,
];

/**
 * Condense a history entry to just its header + Lane/Unit/Topic + Performance
 * sketch lines, dropping the (large) "What happened" / "Sources used" /
 * "Feedback captured" / "Asked about" fields. Tolerant of missing fields —
 * whichever of the three lines are present are kept, in file order. If none
 * of the expected lines are found (unparseable body), falls back to the full
 * body so a shape mismatch never breaks the packet build.
 */
export function condenseEntry(e: HistoryEntry): string {
  const lines = e.body
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => CONDENSE_FIELD_RES.some((re) => re.test(line)));
  return lines.length ? lines.join("\n") : e.body;
}

/** Render a new entry from a LessonRecord, resolving names via the injected resolver. */
export function renderEntry(names: NameResolver, rec: LessonRecord, lessonNumber: number): string {
  const topicNames =
    rec.topicsFreeform ?? rec.topicIds.map((id) => names.topic(id)).join(", ");
  return [
    `## Lesson ${lessonNumber} — ${rec.date}`,
    `**Lane / Unit / Topic:** ${names.lane(rec.laneId)} / ${names.unit(rec.unitId)} / ${topicNames}`,
    `**What happened:** ${rec.whatHappened}`,
    `**Performance sketch:** ${rec.performanceSketch}`,
    `**Sources used:** ${rec.sourcesUsed}`,
    `**Feedback captured:** ${rec.feedbackCaptured}`,
    `**Asked about:** ${rec.askedAbout}`,
  ].join("\n");
}

/** Prepend a rendered entry (newest-first file). */
export function prependEntry(path: string, entryMarkdown: string): void {
  const { preamble, entries } = loadHistory(path);
  const parts = [preamble.trimEnd(), "", entryMarkdown, "", ...entries.map((e) => e.body + "\n")];
  writeFileSync(path, parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
}
