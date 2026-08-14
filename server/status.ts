// GET /api/status — everything the selection screen needs, straight from core/.
// Zero AI tokens are spent here; that's the point of Option B selection.
import { readFileSync } from "node:fs";
import { allTopics, laneById, loadCurriculum, topicById, unitById } from "../core/curriculum.js";
import { recallCandidates, recommendNext, type RecallCandidate } from "../core/selector.js";
import type { SpacingConfig } from "../core/types.js";
import { SECTIONS } from "../core/profile.js";
import { DATA_PATHS, todayLocal } from "../scripts/lib.js";
import { listSessions } from "./store.js";
import type { StoredSession } from "./types.js";

export interface StatusLane {
  id: string;
  name: string;
  weight: number;
  currentUnit: { id: string; name: string; state: string } | null;
  recommendation: {
    kind: string;
    topicId?: string;
    topicName?: string;
    unitId?: string;
    unitName?: string;
    reason?: string;
    plan?: string;
    note?: string;
  };
}

export function buildStatus(spacing: SpacingConfig) {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  const today = todayLocal();

  const lanes: StatusLane[] = c.lanes.map((lane) => {
    const rec = recommendNext(c, lane);
    const cur = lane.currentUnit ? unitById(c, lane.currentUnit)?.unit : undefined;
    const primaryTopic = rec.primary?.topicId ? topicById(c, rec.primary.topicId) : undefined;
    const primaryUnit = rec.primary?.unitId ? unitById(c, rec.primary.unitId) : undefined;
    return {
      id: lane.id,
      name: lane.name,
      weight: lane.weight,
      currentUnit: cur ? { id: cur.id, name: cur.name, state: cur.state } : null,
      recommendation: {
        kind: rec.kind,
        topicId: rec.primary?.topicId,
        topicName: primaryTopic?.topic.name,
        unitId: rec.primary?.unitId,
        unitName: primaryUnit?.unit.name,
        reason: rec.primary?.reason,
        plan: rec.primary?.plan,
        note: rec.note,
      },
    };
  });

  const topics = allTopics(c).map(({ lane, unit, topic, group }) => ({
    id: topic.id,
    name: topic.name,
    laneId: lane.id,
    unitId: unit.id,
    unitName: unit.name,
    state: topic.state,
    group,
  }));

  const all = listSessions();
  const active = all
    .filter((s) => s.status === "active")
    .map((s) => ({
      id: s.id,
      title: s.title,
      params: s.params,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    }));

  // Recall chips are lane-paired: the client shows only the selected lane's set,
  // computed per lane here so a lane switch is a lookup, not a refetch. The seeded
  // draw keeps each day's sets stable across renders and consistent with the packet.
  const recallCandidatesByLane: Record<string, RecallCandidate[]> = {};
  for (const lane of c.lanes) {
    const cands = recallCandidates(c, { today, laneId: lane.id, spacing });
    if (cands.length) recallCandidatesByLane[lane.id] = cands;
  }

  return {
    today,
    spacing,
    lanes,
    recallCandidatesByLane,
    openSettledItems: openSettledItems(),
    topics,
    activeSessions: active,
    attention: computeAttention(all),
  };
}

export interface AttentionItem {
  id: string;
  title: string;
  reason: "pending-approval" | "uncommitted";
  at: string;
}

/**
 * Sessions that need the learner's attention on return: proposals awaiting the gate, and
 * lessons that were ended but never committed (so they don't vanish at expiry).
 */
export function computeAttention(sessions: StoredSession[]): AttentionItem[] {
  const attention: AttentionItem[] = [];
  for (const s of sessions) {
    if (
      s.status === "committed" &&
      s.commit &&
      s.commit.proposedConfirmedPatterns.length > 0 &&
      !s.commit.patternsResolved
    ) {
      attention.push({ id: s.id, title: s.title, reason: "pending-approval", at: s.lastActivityAt });
    } else if (s.status === "active" && s.ending && !s.commit) {
      attention.push({ id: s.id, title: s.title, reason: "uncommitted", at: s.lastActivityAt });
    }
  }
  return attention.sort((a, b) => b.at.localeCompare(a.at));
}

/** OPEN items from the profile's Settled questions ledger — the wrap-up watch-list. */
function openSettledItems(): string[] {
  const lines = readFileSync(DATA_PATHS.profile, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(SECTIONS.settledQuestions));
  if (start === -1) return [];
  const out: string[] = [];
  let current: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("## ")) break;
    if (l.startsWith("- ")) {
      if (current?.includes("OPEN")) out.push(current);
      current = l.slice(2);
    } else if (/^\s{2,}\S/.test(l) && current !== null) {
      current += " " + l.trim();
    }
  }
  if (current?.includes("OPEN")) out.push(current);
  return out;
}

export function laneForTopic(topicId: string): string | null {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  return topicById(c, topicId)?.lane.id ?? null;
}

export function laneExists(laneId: string): boolean {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  return laneById(c, laneId) !== undefined;
}
