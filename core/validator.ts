import type { Curriculum, Topic, Unit } from "./types.js";
import { TOPIC_ASSET_KINDS, TOPIC_STATES, UNIT_STATES } from "./types.js";
import { allTopics, allUnits } from "./curriculum.js";

/**
 * Validate the curriculum per the document contract:
 *  - unique, well-formed IDs; valid state vocabularies
 *  - every referenced ID exists
 *  - topic→topic edges stay within one unit; unit→unit edges within one lane
 *  - bridge topics point at topics in *other* units
 *  - no dependency cycles (topic graph per unit; unit graph per lane)
 *  - lane currentUnit / unit currentTopic / lane nextUp pointers resolve
 * Returns a list of human-readable errors; empty means valid.
 */
export function validateCurriculum(c: Curriculum): string[] {
  const errors: string[] = [];
  const laneIds = new Set<string>();
  const unitIds = new Set<string>();
  const topicIds = new Set<string>();

  // Pass 1: uniqueness + vocab
  for (const lane of c.lanes) {
    if (!lane.id) errors.push(`a lane is missing an id`);
    else if (laneIds.has(lane.id)) errors.push(`duplicate lane id: ${lane.id}`);
    laneIds.add(lane.id);
    for (const unit of lane.units) {
      if (!unit.id) errors.push(`lane ${lane.id}: a unit is missing an id`);
      else if (unitIds.has(unit.id)) errors.push(`duplicate unit id: ${unit.id}`);
      unitIds.add(unit.id);
      if (!UNIT_STATES.includes(unit.state)) {
        errors.push(`unit ${unit.id}: invalid state '${unit.state}'`);
      }
      for (const t of [...unit.coreTopics, ...unit.optionalTopics]) {
        if (!t.id) errors.push(`unit ${unit.id}: a topic is missing an id`);
        else if (topicIds.has(t.id)) errors.push(`duplicate topic id: ${t.id}`);
        topicIds.add(t.id);
        if (!TOPIC_STATES.includes(t.state)) {
          errors.push(`topic ${t.id}: invalid state '${t.state}'`);
        }
        if (t.lastTouched && !/^\d{4}-\d{2}-\d{2}$/.test(t.lastTouched.date)) {
          errors.push(`topic ${t.id}: lastTouched.date '${t.lastTouched.date}' is not YYYY-MM-DD`);
        }
        for (const a of t.assets ?? []) {
          if (!TOPIC_ASSET_KINDS.includes(a.kind)) {
            errors.push(`topic ${t.id}: asset kind '${a.kind}' is not image|text|link`);
          }
          if (!a.url) errors.push(`topic ${t.id}: an asset is missing a url`);
          if (!a.title) errors.push(`topic ${t.id}: an asset is missing a title`);
        }
      }
    }
  }

  // Pass 2: references + edge locality
  for (const { lane, unit } of allUnits(c)) {
    const localTopicIds = new Set([...unit.coreTopics, ...unit.optionalTopics].map((t) => t.id));
    for (const dep of unit.prerequisites) {
      if (!unitIds.has(dep)) errors.push(`unit ${unit.id}: prerequisite unit '${dep}' does not exist`);
      else if (!lane.units.some((u) => u.id === dep)) {
        errors.push(`unit ${unit.id}: prerequisite unit '${dep}' is in a different lane`);
      }
    }
    for (const b of unit.bridgeTopics) {
      if (!topicIds.has(b)) errors.push(`unit ${unit.id}: bridge topic '${b}' does not exist`);
      else if (localTopicIds.has(b)) {
        errors.push(`unit ${unit.id}: bridge topic '${b}' is inside this unit (bridges must point elsewhere)`);
      }
    }
    for (const t of [...unit.coreTopics, ...unit.optionalTopics]) {
      for (const edgeList of [t.prerequisites, t.buildsToward] as const) {
        for (const dep of edgeList) {
          if (!topicIds.has(dep)) {
            errors.push(`topic ${t.id}: edge target '${dep}' does not exist`);
          } else if (!localTopicIds.has(dep)) {
            errors.push(
              `topic ${t.id}: edge to '${dep}' crosses a unit boundary (express it as a unit→unit prerequisite instead)`
            );
          }
        }
      }
    }
    if (unit.currentTopic && !localTopicIds.has(unit.currentTopic)) {
      errors.push(`unit ${unit.id}: currentTopic '${unit.currentTopic}' is not a topic in this unit`);
    }
  }

  for (const lane of c.lanes) {
    if (lane.currentUnit && !lane.units.some((u) => u.id === lane.currentUnit)) {
      errors.push(`lane ${lane.id}: currentUnit '${lane.currentUnit}' is not a unit in this lane`);
    }
    if (lane.nextUp) {
      const { topicId, unitId } = lane.nextUp;
      if ((topicId ? 1 : 0) + (unitId ? 1 : 0) !== 1) {
        errors.push(`lane ${lane.id}: nextUp must set exactly one of topicId / unitId`);
      } else if (topicId) {
        const inLane = lane.units.some((u) =>
          [...u.coreTopics, ...u.optionalTopics].some((t) => t.id === topicId)
        );
        if (!inLane) errors.push(`lane ${lane.id}: nextUp topic '${topicId}' is not in this lane`);
      } else if (unitId && !lane.units.some((u) => u.id === unitId)) {
        errors.push(`lane ${lane.id}: nextUp unit '${unitId}' is not in this lane`);
      }
    }
    // Unit-graph cycle check per lane
    const cyc = findCycle(
      lane.units.map((u) => u.id),
      (id) => lane.units.find((u) => u.id === id)?.prerequisites ?? []
    );
    if (cyc) errors.push(`lane ${lane.id}: unit prerequisite cycle: ${cyc.join(" → ")}`);
  }

  // Topic-graph cycle check per unit (prerequisites only; buildsToward is advisory)
  for (const { unit } of allUnits(c)) {
    const topics: Topic[] = [...unit.coreTopics, ...unit.optionalTopics];
    const cyc = findCycle(
      topics.map((t) => t.id),
      (id) => topics.find((t) => t.id === id)?.prerequisites ?? []
    );
    if (cyc) errors.push(`unit ${unit.id}: topic prerequisite cycle: ${cyc.join(" → ")}`);
  }

  return errors;
}

/** DFS cycle finder over a node list + edge function. Returns one cycle path or null. */
function findCycle(nodes: string[], edges: (id: string) => string[]): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n, WHITE]));
  const stack: string[] = [];
  let found: string[] | null = null;

  function visit(n: string): void {
    if (found) return;
    color.set(n, GRAY);
    stack.push(n);
    for (const m of edges(n)) {
      if (!color.has(m)) continue; // dangling edge — reported elsewhere
      if (color.get(m) === GRAY) {
        found = [...stack.slice(stack.indexOf(m)), m];
        return;
      }
      if (color.get(m) === WHITE) visit(m);
    }
    stack.pop();
    color.set(n, BLACK);
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE) visit(n);
    if (found) break;
  }
  return found;
}
