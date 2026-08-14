// GET /api/report — usage, packet-size trend, curriculum progress, and
// feedback trends for the in-app Stats screen. Pure aggregation over the same
// sources usage-report.ts's CLI reads; zero AI tokens spent building it.
import { existsSync, readFileSync } from "node:fs";
import { loadCurriculum, unitById } from "../core/curriculum.js";
import { recallCandidates } from "../core/selector.js";
import { DATA_PATHS, todayLocal } from "../scripts/lib.js";
import { FEEDBACK_LEDGER } from "./feedback.js";
import { analyzeUsage, readLedger, type LedgerEntry, type UsageAnalysis } from "./usage-report.js";
import type { RatingLevel } from "./types.js";

// --- Packet-size trend -------------------------------------------------------

export interface PacketTrendPoint {
  lessonNumber: number;
  date: string;
  packetTokens: number;
}

/** First turn's cache-read + cache-creation tokens ~= the initial packet size
 *  (system prompt + curriculum slice), lesson over lesson. */
function buildPacketTrend(entries: LedgerEntry[]): PacketTrendPoint[] {
  const out: PacketTrendPoint[] = [];
  for (const e of entries) {
    const first = e.turns?.[0];
    if (!first) continue; // guard: a lesson with no recorded turns
    out.push({
      lessonNumber: e.lessonNumber,
      date: e.date,
      packetTokens: first.tokens.cacheRead + first.tokens.cacheCreation,
    });
  }
  return out.sort((a, b) => a.lessonNumber - b.lessonNumber);
}

// --- Curriculum progress ------------------------------------------------------

export interface LaneProgress {
  laneId: string;
  name: string;
  weight: number;
  unitsTotal: number;
  unitsComplete: number;
  currentUnitName: string | null;
  coreTopicsTotal: number;
  coreTopicsComfortable: number;
  staleTopics: number;
  lessonsTaken: number;
}

function buildProgress(entries: LedgerEntry[]): LaneProgress[] {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  const today = todayLocal();
  // Unsampled + uncapped = every topic past its earned interval, not just the few
  // the day's probabilistic draw would offer on the select screen.
  const stale = recallCandidates(c, {
    today,
    probabilistic: false,
    max: Number.MAX_SAFE_INTEGER,
  });
  const staleByLane = new Map<string, number>();
  for (const s of stale) staleByLane.set(s.laneId, (staleByLane.get(s.laneId) ?? 0) + 1);

  return c.lanes.map((lane) => {
    const unitsComplete = lane.units.filter(
      (u) => u.state === "complete" || u.state === "core-complete"
    ).length;
    const coreTopics = lane.units.flatMap((u) => u.coreTopics);
    const currentUnit = lane.currentUnit ? unitById(c, lane.currentUnit)?.unit : undefined;
    return {
      laneId: lane.id,
      name: lane.name,
      weight: lane.weight,
      unitsTotal: lane.units.length,
      unitsComplete,
      currentUnitName: currentUnit?.name ?? null,
      coreTopicsTotal: coreTopics.length,
      coreTopicsComfortable: coreTopics.filter((t) => t.state === "comfortable").length,
      staleTopics: staleByLane.get(lane.id) ?? 0,
      lessonsTaken: entries.filter((e) => e.laneId === lane.id).length,
    };
  });
}

// --- Feedback trend ------------------------------------------------------------

export interface FeedbackCounts {
  "2": number;
  "1": number;
  "-1": number;
  "-2": number;
}

export interface FeedbackTrendEntry {
  lessonNumber: number;
  counts: FeedbackCounts;
}

export interface FeedbackTrend {
  entries: FeedbackTrendEntry[];
  totals: FeedbackCounts;
}

function emptyCounts(): FeedbackCounts {
  return { "2": 0, "1": 0, "-1": 0, "-2": 0 };
}

const VALID_LEVELS: RatingLevel[] = [2, 1, -1, -2];

/** One line of transcripts/feedback.jsonl — only the fields this report needs. */
interface FeedbackLedgerLine {
  lessonNumber: unknown;
  level: unknown;
}

function buildFeedbackTrend(): FeedbackTrend {
  const totals = emptyCounts();
  if (!existsSync(FEEDBACK_LEDGER)) return { entries: [], totals };

  const byLesson = new Map<number, FeedbackCounts>();
  for (const line of readFileSync(FEEDBACK_LEDGER, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: FeedbackLedgerLine;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // a corrupt line shouldn't sink the whole report
    }
    if (typeof rec.lessonNumber !== "number" || !VALID_LEVELS.includes(rec.level as RatingLevel)) {
      continue;
    }
    const key = String(rec.level) as keyof FeedbackCounts;
    const counts = byLesson.get(rec.lessonNumber) ?? emptyCounts();
    counts[key] += 1;
    byLesson.set(rec.lessonNumber, counts);
    totals[key] += 1;
  }

  const entries = [...byLesson.entries()]
    .map(([lessonNumber, counts]) => ({ lessonNumber, counts }))
    .sort((a, b) => a.lessonNumber - b.lessonNumber);
  return { entries, totals };
}

// --- Report --------------------------------------------------------------------

export interface Report {
  usage: UsageAnalysis;
  packetTrend: PacketTrendPoint[];
  progress: LaneProgress[];
  feedbackTrend: FeedbackTrend;
}

export function buildReport(): Report {
  const entries = readLedger();
  return {
    usage: analyzeUsage(entries),
    packetTrend: buildPacketTrend(entries),
    progress: buildProgress(entries),
    feedbackTrend: buildFeedbackTrend(),
  };
}
