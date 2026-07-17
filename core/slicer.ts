import type { Curriculum, DataPaths, Lane, PacketOptions } from "./types.js";
import { laneById, topicById, unitById } from "./curriculum.js";
import { loadCurriculum } from "./curriculum.js";
import { condenseEntry, lastN } from "./history.js";
import { readProfile } from "./profile.js";
import { readProjectDoc } from "./project.js";
import { renderLaneOneLiner, renderUnitFull, renderUnitOneLiner } from "./render.js";
import { recallCandidates, recommendNext, type Recommendation } from "./selector.js";

/**
 * Build the session packet: everything the tutor needs for one lesson,
 * and nothing else. This is the whole point of Phase 1 — no more loading
 * three full documents to teach one topic.
 */
export function buildSessionPacket(paths: DataPaths, opts: PacketOptions): string {
  const c = loadCurriculum(paths.curriculum);
  const profile = readProfile(paths.profile);
  const history = lastN(paths.history, opts.historyN);

  const lane = opts.laneId ? laneById(c, opts.laneId) : pickDefaultLane(c);
  if (!lane) throw new Error(`lane '${opts.laneId}' not found`);

  const rec = recommendNext(c, lane);
  const recall = recallCandidates(c, opts.today, opts.staleDays);

  const sections: string[] = [];

  sections.push(`# Session Packet — ${opts.today}`);
  sections.push(
    [
      `## Today's parameters`,
      `- lane: ${lane.name} (${lane.id})${opts.laneId ? " — the learner's explicit choice" : " — default (highest-weight active lane)"}`,
      `- session size: ${opts.size}`,
      `- model: ${opts.model}`,
      `- history depth: last ${opts.historyN} lesson(s)`,
    ].join("\n")
  );

  sections.push(renderRecommendation(c, rec));

  sections.push(
    `## Recall warm-up candidates (cold retrieval — offer, don't force)\n` +
      (recall.length
        ? recall
            .map(
              (r) =>
                `- ${r.name} (${r.topicId}) — ${r.laneId}/${r.unitId}, last touched ${r.lastTouched} (${r.daysStale} days ago)`
            )
            .join("\n")
        : `(none — nothing comfortable is stale enough yet; threshold is ${opts.staleDays} days)`)
  );

  sections.push(`## Learner profile (verbatim — honor confirmed patterns and preferences)\n\n${profile.trim()}`);

  const laneSlice = [
    `## Curriculum — active lane slice`,
    `**${lane.name}** (~${lane.weight}%)`,
    `Direction: ${lane.direction.replace(/\s+/g, " ").trim()}`,
    lane.nextUp
      ? `Next up (queued): ${lane.nextUp.topicId ?? `unit ${lane.nextUp.unitId}`} — ${lane.nextUp.plan}`
      : `Next up: (not queued)`,
    ``,
    renderCurrentUnit(c, lane),
    ``,
    `**Other units in this lane (one-liners)**`,
    ...lane.units.filter((u) => u.id !== lane.currentUnit).map((u) => renderUnitOneLiner(u)),
    ``,
    `**Other lanes (context only — per-session override is the learner's call)**`,
    ...c.lanes.filter((l) => l.id !== lane.id).map((l) => renderLaneOneLiner(c, l)),
  ].join("\n");
  sections.push(laneSlice);

  // Project artifact (only lanes that have one): injected verbatim so the design
  // prose keeps its formatting — unlike curriculum notes, this is not collapsed.
  const projectDoc = readProjectDoc(paths.projectsDir, lane.id);
  if (projectDoc && projectDoc.trim()) {
    sections.push(
      `## Project (design artifact — the spec the learner is building across this lane; evolve it, don't grade it)\n\n` +
        projectDoc.trim()
    );
  }

  sections.push(
    `## Recent lesson history (newest first — latest in full, older entries condensed to their ` +
      `performance sketch; last ${history.length})\n\n` +
      (history.length
        ? history.map((e, i) => (i === 0 ? e.body : condenseEntry(e))).join("\n\n")
        : "(no lessons yet)")
  );

  return sections.join("\n\n---\n\n") + "\n";
}

function pickDefaultLane(c: Curriculum): Lane | undefined {
  // Default = highest-weight lane. The tutor/UI may still surface others;
  // the interest mix itself is the learner's deliberate setting, enforced socially not mechanically.
  return [...c.lanes].sort((a, b) => b.weight - a.weight)[0];
}

function renderCurrentUnit(c: Curriculum, lane: Lane): string {
  const cur = lane.currentUnit ? unitById(c, lane.currentUnit)?.unit : undefined;
  if (!cur) return "(no current unit)";
  return renderUnitFull(cur);
}

function renderRecommendation(c: Curriculum, rec: Recommendation): string {
  const lines: string[] = [`## Recommendation (deterministic — the learner can override freely)`];
  if (rec.note) lines.push(`_${rec.note}_`);
  if (rec.primary) {
    const label = rec.primary.topicId
      ? describeTopic(c, rec.primary.topicId)
      : `unit ${rec.primary.unitId}`;
    lines.push(`**Primary:** ${label} — ${rec.primary.reason}`);
    if (rec.primary.plan) lines.push(`**Carried plan:** ${rec.primary.plan}`);
    if (rec.primary.topicId) lines.push(prereqReadiness(c, rec.primary.topicId));
  }
  if (rec.alternatives.length) {
    lines.push(`**Alternatives:**`);
    for (const a of rec.alternatives) {
      lines.push(`- ${a.topicId ? describeTopic(c, a.topicId) : `unit ${a.unitId}`} — ${a.reason}`);
    }
  }
  if (!rec.primary && !rec.alternatives.length) lines.push(`(nothing derivable — check lane pointers)`);
  return lines.join("\n");
}

function describeTopic(c: Curriculum, id: string): string {
  const hit = topicById(c, id);
  return hit ? `${hit.topic.name} (${id})` : id;
}

function prereqReadiness(c: Curriculum, topicId: string): string {
  const hit = topicById(c, topicId);
  if (!hit) return "";
  const rows = hit.topic.prerequisites.map((p) => {
    const ph = topicById(c, p);
    return `- ${ph ? ph.topic.name : p} (${p}): ${ph ? ph.topic.state : "?"}${
      ph?.topic.lastTouched ? `, last touched ${ph.topic.lastTouched.date}` : ""
    }`;
  });
  return (
    `**Prerequisite readiness (topic-level):**\n` +
    (rows.length ? rows.join("\n") : "- (none)") +
    `\n_Cross-cutting prerequisites live in the profile's Broader prerequisites section._`
  );
}
