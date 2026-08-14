// GET /api/curriculum — everything the curriculum viewer draws, assembled from
// data already on disk. Zero AI tokens, same contract as /api/status and
// /api/report: this endpoint reads, it never generates. (Unit summaries are
// written ahead of time by `npm run unit-summaries`; a unit without one gets a
// deterministic fallback here, not a model call.)
import { loadCurriculum, topicById } from "../core/curriculum.js";
import { layerUnits } from "../core/layout.js";
import {
  fallbackSummary,
  loadUnitSummaries,
  unitSourceHash,
} from "../core/unit-summaries.js";
import { DATA_PATHS, PATHS, todayLocal } from "../scripts/lib.js";
import { buildLessonIndex, lessonsForUnit, type LessonIndexEntry } from "./lesson-index.js";
import type { Curriculum, Lane, Topic, Unit } from "../core/types.js";

export interface TopicView {
  id: string;
  name: string;
  state: string;
  lastTouchedDate: string | null;
  lastLesson: number | null;
  /** False when that lesson predates the transcript archive — render text, not a link. */
  lastLessonHasTranscript: boolean;
}

export interface UnitLessonView {
  lessonNumber: number;
  date: string;
  topicsLabel: string;
  topicsFull: string;
  hasTranscript: boolean;
}

export interface UnitView {
  id: string;
  name: string;
  state: string;
  completedAt: string | null;
  prerequisites: string[];
  summary: string | null;
  summaryStale: boolean;
  progress: { coreComfortable: number; coreTotal: number };
  optionalRemaining: number;
  lastLessonDate: string | null;
  coreTopics: TopicView[];
  optionalTopics: TopicView[];
  bridgesInLane: { topicId: string; topicName: string; unitId: string; unitName: string }[];
  bridgesCrossLane: { topicId: string; topicName: string; unitName: string; laneName: string }[];
  lessons: UnitLessonView[];
}

export interface LaneView {
  id: string;
  name: string;
  weight: number;
  direction: string;
  currentUnitId: string | null;
  layers: string[][];
  units: UnitView[];
}

export interface CurriculumView {
  today: string;
  lanes: LaneView[];
}

/** Lesson number → whether its transcript was archived. */
function transcriptMap(index: LessonIndexEntry[]): Map<number, boolean> {
  return new Map(index.map((e) => [e.lessonNumber, e.hasTranscript]));
}

function topicView(t: Topic, hasTranscript: Map<number, boolean>): TopicView {
  const lastLesson = t.lastTouched?.lesson ?? null;
  return {
    id: t.id,
    name: t.name,
    state: t.state,
    lastTouchedDate: t.lastTouched?.date ?? null,
    lastLesson,
    // Two ways this is false: the lesson predates the transcript archive
    // (lessons 1-3), or the number doesn't resolve at all. Either way the
    // client must render plain text rather than a dead link.
    lastLessonHasTranscript: lastLesson !== null && (hasTranscript.get(lastLesson) ?? false),
  };
}

function buildUnitView(
  c: Curriculum,
  lane: Lane,
  unit: Unit,
  index: LessonIndexEntry[],
  hasTranscript: Map<number, boolean>,
  summaries: ReturnType<typeof loadUnitSummaries>
): UnitView {
  const lessons = lessonsForUnit(index, unit.id);
  const entry = summaries.units[unit.id];
  const currentHash = unitSourceHash(lane, unit);

  // bridgeTopics point at topics in OTHER units. In-lane ones become dashed
  // edges in the graph; cross-lane ones have nowhere to point, so they're
  // listed in the expansion instead.
  const bridgesInLane: UnitView["bridgesInLane"] = [];
  const bridgesCrossLane: UnitView["bridgesCrossLane"] = [];
  for (const topicId of unit.bridgeTopics) {
    const hit = topicById(c, topicId);
    if (!hit) continue; // dangling — the validator reports it
    if (hit.lane.id === lane.id) {
      bridgesInLane.push({
        topicId,
        topicName: hit.topic.name,
        unitId: hit.unit.id,
        unitName: hit.unit.name,
      });
    } else {
      bridgesCrossLane.push({
        topicId,
        topicName: hit.topic.name,
        unitName: hit.unit.name,
        laneName: hit.lane.name,
      });
    }
  }

  const fallback = fallbackSummary(unit);
  return {
    id: unit.id,
    name: unit.name,
    state: unit.state,
    completedAt: unit.completedAt ?? null,
    prerequisites: unit.prerequisites,
    summary: entry?.summary ?? (fallback || null),
    // A fallback is "stale" too — it tells the client to show the marker that
    // says this prose isn't a real generated summary.
    summaryStale: !entry || entry.sourceHash !== currentHash,
    progress: {
      coreComfortable: unit.coreTopics.filter((t) => t.state === "comfortable").length,
      coreTotal: unit.coreTopics.length,
    },
    optionalRemaining: unit.optionalTopics.filter((t) => t.state === "not-started").length,
    lastLessonDate: lessons.length ? lessons[lessons.length - 1].date : null,
    coreTopics: unit.coreTopics.map((t) => topicView(t, hasTranscript)),
    optionalTopics: unit.optionalTopics.map((t) => topicView(t, hasTranscript)),
    bridgesInLane,
    bridgesCrossLane,
    lessons: lessons.map((e) => ({
      lessonNumber: e.lessonNumber,
      date: e.date,
      topicsLabel: e.topicsLabel,
      topicsFull: e.topicsFull,
      hasTranscript: e.hasTranscript,
    })),
  };
}

export function buildCurriculumView(): CurriculumView {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  const index = buildLessonIndex();
  const hasTranscript = transcriptMap(index);
  const summaries = loadUnitSummaries(PATHS.unitSummaries);

  const lanes: LaneView[] = c.lanes.map((lane) => ({
    id: lane.id,
    name: lane.name,
    weight: lane.weight,
    direction: lane.direction,
    currentUnitId: lane.currentUnit ?? null,
    layers: layerUnits(lane.units),
    units: lane.units.map((unit) =>
      buildUnitView(c, lane, unit, index, hasTranscript, summaries)
    ),
  }));

  return { today: todayLocal(), lanes };
}
