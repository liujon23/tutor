import type { Curriculum, Lane, SpacingConfig, Topic, Unit } from "./types.js";
import { allTopics, topicById, unitById } from "./curriculum.js";
import { DEFAULT_SPACING, getRecall, offerProbability, seededUnit, stabilityDays } from "./spacing.js";

export interface Recommendation {
  laneId: string;
  kind: "next-up" | "next-core" | "core-complete-options" | "unit-seam" | "empty";
  primary?: { topicId?: string; unitId?: string; reason: string; plan?: string };
  alternatives: { topicId?: string; unitId?: string; reason: string }[];
  note?: string;
}

/**
 * Deterministic "what should this lane do next".
 * Priority: lane.nextUp (queued at last wrap-up) → derive from unit state.
 */
export function recommendNext(c: Curriculum, lane: Lane): Recommendation {
  if (lane.nextUp) {
    if (lane.nextUp.topicId && topicById(c, lane.nextUp.topicId)) {
      return {
        laneId: lane.id,
        kind: "next-up",
        primary: {
          topicId: lane.nextUp.topicId,
          reason: `queued at the last wrap-up`,
          plan: lane.nextUp.plan,
        },
        alternatives: [],
      };
    }
    if (lane.nextUp.unitId && unitById(c, lane.nextUp.unitId)) {
      // A new unit queued at wrap-up — its topics aren't created yet, so this
      // is a unit seam the selection screen surfaces (no stale topic anchor).
      return {
        laneId: lane.id,
        kind: "unit-seam",
        primary: {
          unitId: lane.nextUp.unitId,
          reason: `queued at the last wrap-up`,
          plan: lane.nextUp.plan,
        },
        alternatives: [],
      };
    }
    // Dangling nextUp — validator will flag; fall through to derivation.
  }

  const cur = lane.currentUnit ? unitById(c, lane.currentUnit)?.unit : undefined;
  if (!cur) {
    // No current unit — recommend the first startable unit.
    const startable = firstStartableUnits(lane);
    return {
      laneId: lane.id,
      kind: "unit-seam",
      primary: startable[0] && { unitId: startable[0].id, reason: "first unit with satisfied prerequisites" },
      alternatives: startable.slice(1).map((u) => ({ unitId: u.id, reason: "also startable" })),
      note: "No current unit set for this lane.",
    };
  }

  if (cur.state === "in-progress" || cur.state === "not-started") {
    const next = cur.coreTopics.find((t) => t.state === "not-started" || t.state === "shaky");
    if (next) {
      return {
        laneId: lane.id,
        kind: "next-core",
        primary: { topicId: next.id, reason: next.state === "shaky" ? "shaky — worth revisiting" : "next core topic" },
        alternatives: bridgeAlternatives(c, cur),
      };
    }
    return {
      laneId: lane.id,
      kind: "core-complete-options",
      alternatives: coreCompleteOptions(c, lane, cur),
      note: "All core topics are done — unit state should probably flip to core-complete.",
    };
  }

  if (cur.state === "core-complete") {
    return { laneId: lane.id, kind: "core-complete-options", alternatives: coreCompleteOptions(c, lane, cur) };
  }

  // complete → unit seam
  const startable = firstStartableUnits(lane);
  return {
    laneId: lane.id,
    kind: "unit-seam",
    primary: startable[0] && { unitId: startable[0].id, reason: "next unit with satisfied prerequisites" },
    alternatives: startable.slice(1).map((u) => ({ unitId: u.id, reason: "also startable" })),
    note: "Current unit is complete — this is a unit seam; check intent before committing.",
  };
}

function bridgeAlternatives(c: Curriculum, unit: Unit) {
  return unit.bridgeTopics
    .map((id) => ({ id, hit: topicById(c, id) }))
    .filter((x) => x.hit && x.hit.topic.state !== "comfortable")
    .map((x) => ({ topicId: x.id, reason: `bridge topic (in unit ${x.hit!.unit.id})` }));
}

function coreCompleteOptions(c: Curriculum, lane: Lane, unit: Unit) {
  const opts: { topicId?: string; unitId?: string; reason: string }[] = [];
  for (const t of unit.optionalTopics) {
    if (t.state === "not-started" || t.state === "shaky") {
      opts.push({ topicId: t.id, reason: "optional topic in this unit" });
    }
  }
  for (const b of bridgeAlternatives(c, unit)) opts.push(b);
  // Stale optional topics from prior completed units in this lane
  for (const u of lane.units) {
    if (u.id === unit.id || (u.state !== "complete" && u.state !== "core-complete")) continue;
    for (const t of u.optionalTopics) {
      if (t.state === "not-started" || t.state === "shaky") {
        opts.push({ topicId: t.id, reason: `optional topic from earlier unit ${u.id}` });
      }
    }
  }
  if (opts.length === 0) {
    for (const u of firstStartableUnits(lane)) opts.push({ unitId: u.id, reason: "next startable unit" });
  }
  return opts;
}

function firstStartableUnits(lane: Lane): Unit[] {
  const done = new Set(lane.units.filter((u) => u.state === "complete").map((u) => u.id));
  return lane.units.filter(
    (u) => u.state === "not-started" && u.prerequisites.every((p) => done.has(p))
  );
}

// ---------------------------------------------------------------------------
// Spaced recall
// ---------------------------------------------------------------------------

export interface RecallCandidate {
  topicId: string;
  name: string;
  laneId: string;
  unitId: string;
  lastTouched: string;
  daysStale: number;
  streak: number; // consecutive clean recalls so far
  stabilityDays: number; // the interval that streak earns
  overdueDays: number; // daysStale - stabilityDays (>= 0 for anything returned)
  offerProbability: number;
  /** Other candidates in this same result set that this one is genuinely linked
   *  to — the tutor folds a bundle into ONE question rather than asking each
   *  topic in isolation. */
  bundleWith: string[];
}

export interface RecallOptions {
  today: string; // YYYY-MM-DD
  /** Pair recall to the session's track: only this lane's topics are eligible.
   *  Omit only for cross-lane aggregates (the Stats screen). */
  laneId?: string;
  max?: number; // default 3
  spacing?: SpacingConfig;
  /** Default true. False returns every topic past its interval, unsampled —
   *  what a "how many topics are stale?" count wants. */
  probabilistic?: boolean;
}

/**
 * Cold-recall warm-up candidates. A topic is eligible once it is `comfortable`
 * and past the interval its recall streak has earned; past that floor it is
 * *sampled*, so a due topic surfaces soon but not necessarily today. Most-overdue
 * first, capped at `max`. Offered, never forced — these never override the
 * learner's plan for the session.
 */
export function recallCandidates(c: Curriculum, opts: RecallOptions): RecallCandidate[] {
  const { today, laneId, max = 3, spacing = DEFAULT_SPACING, probabilistic = true } = opts;
  const t0 = new Date(today + "T00:00:00Z").getTime();
  const out: RecallCandidate[] = [];

  for (const { lane, unit, topic } of allTopics(c)) {
    if (laneId && lane.id !== laneId) continue;
    if (topic.state !== "comfortable" || !topic.lastTouched) continue;
    const t1 = new Date(topic.lastTouched.date + "T00:00:00Z").getTime();
    const daysStale = Math.floor((t0 - t1) / 86_400_000);
    const { streak } = getRecall(topic);
    const stability = stabilityDays(streak, spacing);
    const p = offerProbability(daysStale, stability);
    if (p <= 0) continue; // still inside the interval this topic earned
    if (probabilistic && seededUnit(`${today}|${topic.id}`) >= p) continue;
    out.push({
      topicId: topic.id,
      name: topic.name,
      laneId: lane.id,
      unitId: unit.id,
      lastTouched: topic.lastTouched.date,
      daysStale,
      streak,
      stabilityDays: stability,
      overdueDays: daysStale - stability,
      offerProbability: p,
      bundleWith: [],
    });
  }

  out.sort((a, b) => b.overdueDays - a.overdueDays);
  const picked = out.slice(0, max);
  fillBundles(c, picked);
  return picked;
}

/**
 * Mark which of the picked candidates hang together, so the warm-up can bridge
 * them in a single question. "Related" reuses the graph that already exists:
 * same unit, a direct prerequisite/buildsToward edge, or a bridge topic pointing
 * across units.
 */
function fillBundles(c: Curriculum, picked: RecallCandidate[]): void {
  for (const a of picked) {
    for (const b of picked) {
      if (a.topicId === b.topicId) continue;
      if (areRelated(c, a, b)) a.bundleWith.push(b.topicId);
    }
  }
}

function areRelated(c: Curriculum, a: RecallCandidate, b: RecallCandidate): boolean {
  if (a.unitId === b.unitId) return true;
  const ta = topicById(c, a.topicId);
  const tb = topicById(c, b.topicId);
  if (!ta || !tb) return false;
  const edges = (t: typeof ta) => [...t.topic.prerequisites, ...t.topic.buildsToward];
  if (edges(ta).includes(b.topicId) || edges(tb).includes(a.topicId)) return true;
  return ta.unit.bridgeTopics.includes(b.topicId) || tb.unit.bridgeTopics.includes(a.topicId);
}
