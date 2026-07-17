import type { Curriculum, Lane, Topic, Unit } from "./types.js";
import { topicById, unitById } from "./curriculum.js";

function touched(t: Topic): string {
  return t.lastTouched ? `${t.lastTouched.date} (L${t.lastTouched.lesson})` : "never";
}

function topicLine(t: Topic): string {
  const edges: string[] = [];
  if (t.prerequisites.length) edges.push(`prereqs: ${t.prerequisites.join(", ")}`);
  if (t.buildsToward.length) edges.push(`builds toward: ${t.buildsToward.join(", ")}`);
  const edgeStr = edges.length ? `\n    ${edges.join("; ")}` : "";
  const notes = t.notes ? `\n    notes: ${t.notes.replace(/\s+/g, " ").trim()}` : "";
  const assets = (t.assets ?? [])
    .map(
      (a) =>
        `\n    asset [${a.kind}]: ${a.title} — <${a.url}>${
          a.note ? ` (${a.note.replace(/\s+/g, " ").trim()})` : ""
        }`
    )
    .join("");
  return `- [${t.state}] ${t.name} (${t.id}) — last touched ${touched(t)}${edgeStr}${notes}${assets}`;
}

export function renderUnitFull(unit: Unit): string {
  const head = [
    `### Unit: ${unit.name} (${unit.id})`,
    `state: ${unit.state} · current topic: ${unit.currentTopic ?? "none"} · unit prereqs: ${
      unit.prerequisites.join(", ") || "(none)"
    } · bridges: ${unit.bridgeTopics.join(", ") || "(none)"}`,
    unit.notes ? `notes: ${unit.notes.replace(/\s+/g, " ").trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const core = unit.coreTopics.length
    ? `\n**Core topics**\n${unit.coreTopics.map(topicLine).join("\n")}`
    : "";
  const opt = unit.optionalTopics.length
    ? `\n**Optional topics**\n${unit.optionalTopics.map(topicLine).join("\n")}`
    : "";
  return `${head}${core}${opt}`;
}

export function renderUnitOneLiner(unit: Unit): string {
  const nCore = unit.coreTopics.length;
  const doneCore = unit.coreTopics.filter((t) => t.state === "comfortable").length;
  return `- ${unit.name} (${unit.id}) — ${unit.state}, core ${doneCore}/${nCore}${
    unit.prerequisites.length ? `, after ${unit.prerequisites.join(", ")}` : ""
  }`;
}

export function renderLaneOneLiner(c: Curriculum, lane: Lane): string {
  const cur = lane.units.find((u) => u.id === lane.currentUnit);
  const next = lane.nextUp
    ? `next up: ${
        lane.nextUp.topicId
          ? topicById(c, lane.nextUp.topicId)?.topic.name ?? lane.nextUp.topicId
          : unitById(c, lane.nextUp.unitId!)?.unit.name ?? lane.nextUp.unitId
      }`
    : "next up: (not queued)";
  return `- ${lane.name} (${lane.id}, ~${lane.weight}%) — current unit: ${
    cur ? `${cur.name} [${cur.state}]` : "none"
  }; ${next}`;
}
