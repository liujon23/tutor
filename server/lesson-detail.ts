// Everything about one past lesson that its archived transcript doesn't carry:
// its key points and sources (lesson-digests.json), the lesson-history fields,
// the ratings distilled at commit, cost including
// the commit turn, names instead of ids, and its neighbours. Feeds the
// transcript reader; zero AI tokens.
import { existsSync, readFileSync } from "node:fs";
import { allUnits, loadCurriculum } from "../core/curriculum.js";
import { parseHistory } from "../core/history.js";
import { digestFor, loadDigests, type LessonDigest } from "../core/lesson-digests.js";
import { PATHS } from "../scripts/lib.js";
import { buildLessonIndex, DEFAULT_INDEX_PATHS, type LessonIndexPaths } from "./lesson-index.js";
import { readLedger } from "./usage-report.js";
import { usageHeadline } from "./usage.js";

export interface LessonDetailPaths extends LessonIndexPaths {
  feedbackLedger: string;
  lessonDigests: string;
}

export const DEFAULT_DETAIL_PATHS: LessonDetailPaths = {
  ...DEFAULT_INDEX_PATHS,
  feedbackLedger: PATHS.feedbackLedger,
  lessonDigests: PATHS.lessonDigests,
};

export interface HistoryFields {
  whatHappened: string;
  performanceSketch: string;
  sourcesUsed: string;
  feedbackCaptured: string;
  askedAbout: string;
}

export interface LessonRating {
  level: number;
  context: string;
  takeaway: string;
}

export interface LessonDetail {
  lessonNumber: number;
  date: string;
  laneId: string;
  laneName: string;
  unitId: string;
  unitName: string;
  topics: string;
  hasTranscript: boolean;
  /** Key points and sources; null for a lesson committed before them and not yet backfilled. */
  digest: LessonDigest | null;
  history: HistoryFields | null;
  ratings: LessonRating[];
  /** usageHeadline of the ledger entry, commit turn included where recorded. */
  usage: string | null;
  /** The nearest earlier and later lessons with a transcript, across all lanes. */
  prev: number | null;
  next: number | null;
}

// The labels renderEntry (core/history.ts) writes, → LessonRecord field.
const HISTORY_LABELS: Record<string, keyof HistoryFields> = {
  "What happened": "whatHappened",
  "Performance sketch": "performanceSketch",
  "Sources used": "sourcesUsed",
  "Feedback captured": "feedbackCaptured",
  "Asked about": "askedAbout",
};

/** The labelled fields of a history entry. A line with no label continues the field above it. */
export function parseHistoryFields(body: string): HistoryFields {
  const out: HistoryFields = { whatHappened: "", performanceSketch: "", sourcesUsed: "", feedbackCaptured: "", askedAbout: "" };
  let key: keyof HistoryFields | null = null;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\*\*([^*]+?):\*\*\s?(.*)$/.exec(line);
    if (m) {
      key = HISTORY_LABELS[m[1].trim()] ?? null;
      if (key) out[key] = m[2].trim();
      continue;
    }
    if (key && line.trim() && !line.startsWith("## ")) out[key] += `\n${line}`;
  }
  return out;
}

function readRatings(path: string, lessonNumber: number): LessonRating[] {
  if (!existsSync(path)) return [];
  const out: LessonRating[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { lessonNumber?: unknown; level?: unknown; context?: unknown; takeaway?: unknown };
      if (r.lessonNumber !== lessonNumber || typeof r.level !== "number") continue;
      out.push({
        level: r.level,
        context: typeof r.context === "string" ? r.context : "",
        takeaway: typeof r.takeaway === "string" ? r.takeaway : "",
      });
    } catch {
      /* a corrupt line shouldn't sink the reader */
    }
  }
  return out;
}

/** Null when no record of the lesson exists anywhere. */
export function buildLessonDetail(
  lessonNumber: number,
  paths: LessonDetailPaths = DEFAULT_DETAIL_PATHS
): LessonDetail | null {
  const index = buildLessonIndex(paths);
  const i = index.findIndex((e) => e.lessonNumber === lessonNumber);
  if (i < 0) return null;
  const e = index[i];

  const c = loadCurriculum(paths.curriculum);
  const placed = allUnits(c).find((x) => x.unit.id === e.unitId);
  const laneName = placed?.lane.name ?? c.lanes.find((l) => l.id === e.laneId)?.name ?? e.laneId;

  const entry = parseHistory(readFileSync(paths.history, "utf8")).entries.find((h) => h.number === lessonNumber);
  const ledger = readLedger(paths.usageLedger).find((l) => l.lessonNumber === lessonNumber);

  const withTranscript = index.filter((x) => x.hasTranscript);
  const prev = [...withTranscript].reverse().find((x) => x.lessonNumber < lessonNumber)?.lessonNumber ?? null;
  const next = withTranscript.find((x) => x.lessonNumber > lessonNumber)?.lessonNumber ?? null;

  return {
    lessonNumber,
    date: e.date,
    laneId: e.laneId,
    laneName,
    unitId: e.unitId,
    unitName: placed?.unit.name ?? e.unitId,
    topics: e.topicsFull,
    hasTranscript: e.hasTranscript,
    digest: digestFor(loadDigests(paths.lessonDigests), lessonNumber),
    history: entry ? parseHistoryFields(entry.body) : null,
    ratings: readRatings(paths.feedbackLedger, lessonNumber),
    usage: ledger?.usage ? usageHeadline(ledger.usage) : null,
    prev,
    next,
  };
}
