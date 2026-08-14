// Generated one-line descriptions of what each unit covers — the only prose in
// the curriculum viewer a human didn't write.
//
// The whole design is about generating them RARELY. Each entry stores the hash
// of the unit's *structure*; a summary regenerates only when that hash moves.
// Everything volatile — states, notes, lastTouched — is deliberately outside
// the hash, because those change after every single lesson and would turn a
// write-once cache into a per-lesson bill.
//
// Nothing here calls a model. Generation lives in scripts/unit-summaries.ts;
// readers (the viewer) only ever load what's already on disk.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Curriculum, Lane, Unit } from "./types.js";

export interface UnitSummaryEntry {
  summary: string;
  sourceHash: string;
  generatedAt: string; // ISO
  model: string;
}

export interface UnitSummariesFile {
  /** Bump to force a full regeneration when the hash inputs change meaning. */
  version: 1;
  units: Record<string, UnitSummaryEntry>;
}

export const SUMMARIES_VERSION = 1;

export function emptySummaries(): UnitSummariesFile {
  return { version: SUMMARIES_VERSION, units: {} };
}

/**
 * The exact inputs a summary is allowed to depend on. Adding a field here means
 * every unit regenerates, so the bar is "would the two sentences actually read
 * differently?" — a topic's state wouldn't change the prose, its name would.
 */
function hashInput(lane: Lane, unit: Unit) {
  return {
    unitId: unit.id,
    name: unit.name,
    prerequisites: [...unit.prerequisites].sort(),
    coreTopics: unit.coreTopics.map((t) => ({ id: t.id, name: t.name })),
    optionalTopics: unit.optionalTopics.map((t) => ({ id: t.id, name: t.name })),
    laneDirection: lane.direction,
  };
}

/** Stable fingerprint of a unit's structure + its lane's direction. */
export function unitSourceHash(lane: Lane, unit: Unit): string {
  return createHash("sha256").update(JSON.stringify(hashInput(lane, unit))).digest("hex");
}

export function loadUnitSummaries(path: string): UnitSummariesFile {
  if (!existsSync(path)) return emptySummaries();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptySummaries(); // corrupt file → regenerate rather than crash the viewer
  }
  const f = parsed as Partial<UnitSummariesFile>;
  if (f?.version !== SUMMARIES_VERSION || typeof f.units !== "object" || f.units === null) {
    return emptySummaries();
  }
  return { version: SUMMARIES_VERSION, units: f.units };
}

export function saveUnitSummaries(path: string, file: UnitSummariesFile): void {
  // Key-sorted so the committed diff shows only what actually changed.
  const units = Object.fromEntries(Object.entries(file.units).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify({ version: file.version, units }, null, 2) + "\n", "utf8");
}

export interface StaleUnit {
  lane: Lane;
  unit: Unit;
  hash: string;
  reason: "missing" | "changed";
}

/** Units whose summary is absent or whose structure has drifted since generation. */
export function staleUnits(c: Curriculum, file: UnitSummariesFile): StaleUnit[] {
  const out: StaleUnit[] = [];
  for (const lane of c.lanes) {
    for (const unit of lane.units) {
      const hash = unitSourceHash(lane, unit);
      const entry = file.units[unit.id];
      if (!entry) out.push({ lane, unit, hash, reason: "missing" });
      else if (entry.sourceHash !== hash) out.push({ lane, unit, hash, reason: "changed" });
    }
  }
  return out;
}

/**
 * What the viewer shows for a unit with no usable summary: its core topic
 * names. Deterministic, always available, and honest about being a fallback —
 * the viewer never generates on demand.
 */
export function fallbackSummary(unit: Unit): string {
  const names = unit.coreTopics.map((t) => t.name);
  return names.length > 0 ? names.join(" · ") : "";
}
