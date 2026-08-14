import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { Curriculum, Lane, Topic, Unit } from "./types.js";

/** Load and lightly normalize curriculum.yaml. Shape errors are reported by the validator. */
export function loadCurriculum(path: string): Curriculum {
  const raw = YAML.parse(readFileSync(path, "utf8"));
  if (!raw || !Array.isArray(raw.lanes)) {
    throw new Error(`curriculum at ${path}: expected a top-level 'lanes' array`);
  }
  for (const lane of raw.lanes) {
    lane.units ??= [];
    lane.nextUp ??= null;
    lane.currentUnit ??= null;
    lane.direction ??= "";
    for (const unit of lane.units) {
      unit.coreTopics ??= [];
      unit.optionalTopics ??= [];
      unit.prerequisites ??= [];
      unit.bridgeTopics ??= [];
      unit.currentTopic ??= null;
      unit.notes ??= "";
      unit.completedAt ??= null;
      for (const t of [...unit.coreTopics, ...unit.optionalTopics]) {
        t.prerequisites ??= [];
        t.buildsToward ??= [];
        t.lastTouched ??= null;
        t.notes ??= "";
        t.assets ??= [];
      }
    }
  }
  return raw as Curriculum;
}

// Re-emitted on every save so the hand-editable file keeps its state legend and
// validate reminder at the top — the YAML serializer drops all comments, so the
// header has to be reattached here rather than living inline in the file.
const HEADER = [
  " Curriculum Map — structured store (see skills/references/document-formats.md)",
  " States: topic = not-started | touched | comfortable | shaky",
  "         unit  = not-started | in-progress | core-complete | complete",
  " Edit by hand if you like, but run `npm run validate` afterward.",
].join("\n");

export function saveCurriculum(path: string, c: Curriculum): void {
  const doc = new YAML.Document(c);
  doc.commentBefore = HEADER;
  writeFileSync(path, doc.toString({ lineWidth: 100 }), "utf8");
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function allUnits(c: Curriculum): { lane: Lane; unit: Unit }[] {
  return c.lanes.flatMap((lane) => lane.units.map((unit) => ({ lane, unit })));
}

export function allTopics(c: Curriculum): { lane: Lane; unit: Unit; topic: Topic; group: "core" | "optional" }[] {
  const out: { lane: Lane; unit: Unit; topic: Topic; group: "core" | "optional" }[] = [];
  for (const { lane, unit } of allUnits(c)) {
    for (const topic of unit.coreTopics) out.push({ lane, unit, topic, group: "core" });
    for (const topic of unit.optionalTopics) out.push({ lane, unit, topic, group: "optional" });
  }
  return out;
}

export function laneById(c: Curriculum, id: string): Lane | undefined {
  return c.lanes.find((l) => l.id === id);
}

export function unitById(c: Curriculum, id: string): { lane: Lane; unit: Unit } | undefined {
  return allUnits(c).find((x) => x.unit.id === id);
}

export function topicById(
  c: Curriculum,
  id: string
): { lane: Lane; unit: Unit; topic: Topic; group: "core" | "optional" } | undefined {
  return allTopics(c).find((x) => x.topic.id === id);
}
