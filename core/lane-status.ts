// Whether a lane (course) has ended, and what ending changes.
//
// A course ENDS when every unit is done and its ending has been recorded in
// `lane.finishedAt`. It can be reopened: course-setup adds a unit, and the lane
// stops being finished without anyone clearing the date (see `laneFinishedAt`).
//
// What a finished lane changes:
//   - it leaves Today's pick, and its weight is shared out over the rest;
//   - its topics stay in recall, at FINISHED_RECALL_FACTOR × the usual interval;
//   - the selector stops recommending lessons in it (review is still allowed).
import type { Curriculum, Lane, SpacingConfig, Topic, Unit, UnitState } from "./types.js";
import { DEFAULT_SPACING, stabilityDays } from "./spacing.js";

const DONE: UnitState[] = ["core-complete", "complete"];

/** Recall intervals on a finished course are this many times longer, still capped
 *  at `maxDays`. Reviewed less often, never dropped. */
export const FINISHED_RECALL_FACTOR = 2;

/** True when the lane has units and every one of them is core-complete or complete. */
export function laneOutOfUnits(lane: Lane): boolean {
  return lane.units.length > 0 && lane.units.every((u) => DONE.includes(u.state));
}

/**
 * The date the lane finished, or null while it is still running.
 *
 * `finishedAt` alone isn't enough: a course reopened in course-setup keeps its
 * old date in the file. It only counts while the lane is still out of units AND
 * no unit was completed after it — a unit added and finished since then means
 * the course was extended, and is waiting on a fresh ending.
 */
export function laneFinishedAt(lane: Lane): string | null {
  const at = lane.finishedAt;
  if (!at || !laneOutOfUnits(lane)) return null;
  for (const u of lane.units) {
    if (u.completedAt && u.completedAt > at) return null;
  }
  return at;
}

export function isLaneFinished(lane: Lane): boolean {
  return laneFinishedAt(lane) !== null;
}

/**
 * Every unit is done but the ending isn't recorded yet: the closing capstone is
 * next. Committing the capstone (server/tutor-tool.ts → applySessionPatch's
 * `finishLaneId`) is what stamps `finishedAt`. A course extended and finished
 * again is capstone-due again — each ending gets its own capstone.
 */
export function capstoneDue(lane: Lane): boolean {
  return laneOutOfUnits(lane) && !isLaneFinished(lane);
}

/** Topics in the lane that were taught but never settled (touched or shaky) — the
 *  capstone works them in on purpose, since recall only ever reaches comfortable ones. */
export function looseEnds(lane: Lane): { unit: Unit; topic: Topic }[] {
  const out: { unit: Unit; topic: Topic }[] = [];
  for (const unit of lane.units) {
    for (const topic of [...unit.coreTopics, ...unit.optionalTopics]) {
      if (topic.state === "touched" || topic.state === "shaky") out.push({ unit, topic });
    }
  }
  return out;
}

/**
 * The review interval, in days, for a topic in this lane at this recall streak.
 * The one place the finished-course stretch is applied — selector, patcher,
 * recall check and packets all read it from here.
 */
export function recallInterval(
  lane: Lane,
  streak: number,
  spacing: SpacingConfig = DEFAULT_SPACING
): number {
  const base = stabilityDays(streak, spacing);
  if (!isLaneFinished(lane)) return base;
  return Math.min(base * FINISHED_RECALL_FACTOR, spacing.maxDays);
}

/**
 * Each lane's share of attention, in whole percent. Finished lanes get 0 and the
 * rest is renormalized over the running lanes, so a finished course's weight is
 * spread out automatically. With no running lanes, every share is 0.
 */
export function laneShares(c: Curriculum): Map<string, number> {
  const running = c.lanes.filter((l) => !isLaneFinished(l));
  const total = running.reduce((s, l) => s + Math.max(0, l.weight), 0);
  const out = new Map<string, number>();
  for (const l of c.lanes) {
    out.set(
      l.id,
      total > 0 && !isLaneFinished(l) ? Math.round((Math.max(0, l.weight) / total) * 100) : 0
    );
  }
  return out;
}
