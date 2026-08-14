// A complete, deterministic map of every lesson ever taught → the unit it
// belongs to and whether its transcript was archived. The curriculum viewer's
// substrate; zero AI tokens, like /api/status and /api/report.
//
// Why three sources: the record-keeping grew over time, so no single file has
// every lesson.
//
//   usage.jsonl      structured, authoritative — but only since lesson 5
//   transcript head  structured ids, written by renderTranscript — since lesson 4
//   lesson-history   the only trace of lessons 1-3, and it stores display NAMES
//
// Using fewer than all three silently under-reports a unit's lessons, which is
// exactly the thing the viewer exists to show. Lesson numbers are NOT
// contiguous (there is no lesson 6 — a number allocated and never committed),
// so nothing here may count 1..N; it merges actual records.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allUnits, loadCurriculum, topicById } from "../core/curriculum.js";
import { parseHistory } from "../core/history.js";
import { DATA_PATHS, PATHS } from "../scripts/lib.js";
import { readLedger } from "./usage-report.js";
import type { Curriculum } from "../core/types.js";

/** Longest `topicsLabel` carried in the payload; the full text rides along separately. */
const LABEL_MAX = 120;

/**
 * The four files the index reads. Passed in rather than reached for so the
 * merge logic can be tested against fixtures instead of the live data root.
 */
export interface LessonIndexPaths {
  curriculum: string;
  history: string;
  transcriptsDir: string;
  usageLedger: string;
}

export const DEFAULT_INDEX_PATHS: LessonIndexPaths = {
  curriculum: DATA_PATHS.curriculum,
  history: DATA_PATHS.history,
  transcriptsDir: PATHS.transcriptsDir,
  usageLedger: PATHS.usageLedger,
};

export interface LessonIndexEntry {
  lessonNumber: number;
  date: string;
  laneId: string;
  unitId: string;
  topicIds: string[];
  topicsLabel: string; // truncated for display
  topicsFull: string; // untruncated, for a title tooltip
  hasTranscript: boolean;
  source: "ledger" | "transcript" | "history";
}

// --- Source 2: transcript headers -------------------------------------------

/** The fixed header renderTranscript() writes. Both ids are structured. */
const TRANSCRIPT_HEAD_RE = /^#\s+Lesson\s+(\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/m;
const TRANSCRIPT_UNIT_RE = /^-\s+\*\*Lane \/ Unit:\*\*\s*(\S+)\s*\/\s*(\S+)\s*$/m;
const TRANSCRIPT_TOPICS_RE = /^-\s+\*\*Topics:\*\*\s*(.+)$/m;

interface TranscriptHead {
  lessonNumber: number;
  date: string;
  laneId: string;
  unitId: string;
  topicsLine: string;
}

/** Parse the header block of an archived transcript. Null if it doesn't match. */
export function parseTranscriptHead(text: string): TranscriptHead | null {
  const head = TRANSCRIPT_HEAD_RE.exec(text);
  const unit = TRANSCRIPT_UNIT_RE.exec(text);
  if (!head || !unit) return null;
  return {
    lessonNumber: Number(head[1]),
    date: head[2],
    laneId: unit[1],
    unitId: unit[2],
    topicsLine: TRANSCRIPT_TOPICS_RE.exec(text)?.[1].trim() ?? "",
  };
}

/** lesson-NNN.md files present on disk, by lesson number. */
function scanTranscripts(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const m = /^lesson-(\d+)\.md$/.exec(name);
    if (m) out.set(Number(m[1]), join(dir, name));
  }
  return out;
}

// --- Source 3: lesson-history.md --------------------------------------------

// renderEntry() writes "**Lane / Unit / Topic:** <lane> / <unit> / <topics>" —
// display NAMES, not ids, and the lane name is inconsistent across the oldest
// entries ("AI Lane" in one, plain "AI" in another). The unit name is the only
// dependable key, so that's what we resolve on.
const HISTORY_LUT_RE = /^\*\*Lane \/ Unit \/ Topic:\*\*\s*(.+)$/m;

/**
 * Unit name → id, but only for names that identify exactly one unit. The
 * validator guarantees unique unit *ids*, not names, so an ambiguous name is
 * dropped rather than guessed at — a wrong attribution is worse than a missing
 * row. (All 26 unit names are distinct today.)
 */
function unambiguousUnitNames(c: Curriculum): Map<string, string> {
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const { unit } of allUnits(c)) {
    counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1);
    ids.set(unit.name, unit.id);
  }
  const out = new Map<string, string>();
  for (const [name, id] of ids) if (counts.get(name) === 1) out.set(name, id);
  return out;
}

interface HistoryLut {
  unitName: string;
  topics: string;
}

/** Split the "Lane / Unit / Topic:" line. The topic part may itself contain " / ". */
export function parseHistoryLutLine(line: string): HistoryLut | null {
  const parts = line.split(" / ");
  if (parts.length < 3) return null;
  return { unitName: parts[1].trim(), topics: parts.slice(2).join(" / ").trim() };
}

// --- Merge -------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Label a lesson's topics. Structured ids resolve to real topic names; lessons
 * recorded with `topicsFreeform` instead (a good third of them) fall back to the
 * prose line, which can run a full paragraph — hence the truncation.
 */
function labelTopics(c: Curriculum, topicIds: string[], freeform: string): string {
  const names = topicIds.map((id) => topicById(c, id)?.topic.name ?? id);
  return names.length > 0 ? names.join(", ") : freeform;
}

/**
 * Every lesson on record, ascending by number. Later sources never overwrite
 * earlier ones: the ledger is structured and authoritative, the transcript
 * header is structured but thinner, and history is names-only guesswork of last
 * resort.
 */
export function buildLessonIndex(
  paths: LessonIndexPaths = DEFAULT_INDEX_PATHS
): LessonIndexEntry[] {
  const c = loadCurriculum(paths.curriculum);
  const transcripts = scanTranscripts(paths.transcriptsDir);
  const byNumber = new Map<number, LessonIndexEntry>();

  const add = (e: LessonIndexEntry) => {
    if (!byNumber.has(e.lessonNumber)) byNumber.set(e.lessonNumber, e);
  };

  // Transcript headers, parsed at most once each and only when actually needed
  // — as the sole source for a pre-ledger lesson, or to recover the freeform
  // topic line for a ledger lesson that recorded no topic ids.
  const heads = new Map<number, TranscriptHead | null>();
  const headFor = (n: number): TranscriptHead | null => {
    if (!heads.has(n)) {
      const file = transcripts.get(n);
      heads.set(n, file ? parseTranscriptHead(readFileSync(file, "utf8")) : null);
    }
    return heads.get(n)!;
  };

  // 1. usage.jsonl — structured ids, lessons 5 and 7+.
  for (const e of readLedger(paths.usageLedger)) {
    if (typeof e.lessonNumber !== "number") continue;
    const topicIds = Array.isArray(e.topicIds) ? e.topicIds : [];
    // A third of the lessons strayed off-graph and were committed with
    // `topicsFreeform` instead of ids (12, 19, 24 today). The ledger drops that
    // prose, so the transcript header is the only place left to read it.
    const freeform = topicIds.length === 0 ? (headFor(e.lessonNumber)?.topicsLine ?? "") : "";
    const full = labelTopics(c, topicIds, freeform);
    add({
      lessonNumber: e.lessonNumber,
      date: e.date,
      laneId: e.laneId,
      unitId: e.unitId,
      topicIds,
      topicsLabel: truncate(full, LABEL_MAX),
      topicsFull: full,
      hasTranscript: transcripts.has(e.lessonNumber),
      source: "ledger",
    });
  }

  // 2. Transcript headers — covers lesson 4, which predates the ledger.
  for (const n of transcripts.keys()) {
    if (byNumber.has(n)) continue;
    const head = headFor(n);
    if (!head) continue;
    add({
      lessonNumber: head.lessonNumber,
      date: head.date,
      laneId: head.laneId,
      unitId: head.unitId,
      topicIds: [],
      topicsLabel: truncate(head.topicsLine, LABEL_MAX),
      topicsFull: head.topicsLine,
      hasTranscript: true,
      source: "transcript",
    });
  }

  // 3. lesson-history.md — the only record of lessons 1-3.
  const nameToUnit = unambiguousUnitNames(c);
  for (const entry of parseHistory(readFileSync(paths.history, "utf8")).entries) {
    if (byNumber.has(entry.number)) continue;
    const lut = HISTORY_LUT_RE.exec(entry.body)?.[1];
    const parsed = lut ? parseHistoryLutLine(lut) : null;
    const unitId = parsed ? nameToUnit.get(parsed.unitName) : undefined;
    if (!parsed || !unitId) continue; // unresolvable or ambiguous — skip, never guess
    const lane = allUnits(c).find((x) => x.unit.id === unitId)!.lane;
    add({
      lessonNumber: entry.number,
      date: entry.date,
      laneId: lane.id,
      unitId,
      topicIds: [],
      topicsLabel: truncate(parsed.topics, LABEL_MAX),
      topicsFull: parsed.topics,
      hasTranscript: false, // predates the transcript archive
      source: "history",
    });
  }

  return [...byNumber.values()].sort((a, b) => a.lessonNumber - b.lessonNumber);
}

/** Lessons that happened in a given unit, ascending. */
export function lessonsForUnit(index: LessonIndexEntry[], unitId: string): LessonIndexEntry[] {
  return index.filter((e) => e.unitId === unitId);
}
