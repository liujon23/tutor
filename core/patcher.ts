import { readFileSync, writeFileSync } from "node:fs";
import type {
  Curriculum,
  DataPaths,
  Lane,
  SessionPatch,
  SpacingConfig,
  Topic,
  TopicUpdate,
  Unit,
  UnitState,
} from "./types.js";
import { RECALL_RESULTS, TOPIC_STATES, UNIT_STATES } from "./types.js";
import { laneById, loadCurriculum, saveCurriculum, topicById, unitById } from "./curriculum.js";
import { getRecall } from "./spacing.js";
import { isLaneFinished, laneOutOfUnits, recallInterval } from "./lane-status.js";
import { applyRecallGrade } from "./recall.js";
import { validateCurriculum } from "./validator.js";
import { nextLessonNumber, prependEntry, renderEntry } from "./history.js";
import { applyProfilePatchToLines, checkProfilePatch } from "./profile.js";
import { writeProjectDoc } from "./project.js";
import { checkDigestFields, checkTitle, digestFromRecord, loadDigests, saveDigests } from "./lesson-digests.js";

export interface ApplyOptions {
  /**
   * The lesson was this lane's closing capstone: record the course's ending
   * (`finishedAt` = the lesson date) in the same write. Server-decided from the
   * session's params, never a patch field — like `completedAt`, the model has no
   * say in it.
   */
  finishLaneId?: string;
}

export interface ApplyResult {
  lessonNumber: number;
  summary: string[];
  proposedConfirmedPatterns: string[];
}

/**
 * Validate a patch against current data WITHOUT writing anything.
 * Returns human-readable errors; empty = safe to apply.
 */
export function checkPatch(paths: DataPaths, patch: SessionPatch): string[] {
  const errors: string[] = [];
  let c: Curriculum;
  try {
    c = loadCurriculum(paths.curriculum);
  } catch (e) {
    return [`could not load curriculum: ${(e as Error).message}`];
  }

  const L = patch.lesson;
  if (!L) return ["patch.lesson is required"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(L.date ?? "")) errors.push(`lesson.date '${L.date}' is not YYYY-MM-DD`);
  if (!laneById(c, L.laneId)) errors.push(`lesson.laneId '${L.laneId}' does not exist`);
  if (!unitById(c, L.unitId)) errors.push(`lesson.unitId '${L.unitId}' does not exist`);
  errors.push(...checkTitle(L.title));
  errors.push(...checkDigestFields(L));

  // Apply curriculum changes to a deep copy, then run the graph validator.
  const copy: Curriculum = structuredClone(c);
  try {
    applyCurriculumChanges(copy, patch, 0 /* number irrelevant for check */);
  } catch (e) {
    errors.push((e as Error).message);
    return errors;
  }
  // Lesson topicIds must exist AFTER newTopics are added.
  for (const tid of L.topicIds ?? []) {
    if (!topicById(copy, tid)) errors.push(`lesson.topicIds: '${tid}' does not exist (even after newTopics)`);
  }
  for (const u of patch.curriculum?.topicUpdates ?? []) {
    if (u.state && !TOPIC_STATES.includes(u.state)) errors.push(`topicUpdate ${u.id}: bad state '${u.state}'`);
    if (u.recall && !RECALL_RESULTS.includes(u.recall)) {
      errors.push(`topicUpdate ${u.id}: bad recall '${u.recall}' (clean|rusty|miss)`);
    }
  }
  for (const u of patch.curriculum?.unitUpdates ?? []) {
    if (u.state && !UNIT_STATES.includes(u.state)) errors.push(`unitUpdate ${u.id}: bad state '${u.state}'`);
  }
  errors.push(...validateCurriculum(copy).map((e) => `post-patch curriculum invalid: ${e}`));

  if (patch.project) {
    const p = patch.project;
    if (!laneById(c, p.laneId)) errors.push(`project.laneId '${p.laneId}' does not exist`);
    if (p.laneId !== L.laneId)
      errors.push(`project.laneId '${p.laneId}' must match lesson.laneId '${L.laneId}'`);
    if (typeof p.content !== "string" || !p.content.trim())
      errors.push(`project.content must be a non-empty string`);
  }

  if (patch.profile) {
    errors.push(...checkProfilePatch(paths.profile, patch.profile).map((e) => `profile: ${e}`));
  }

  return errors;
}

/**
 * Apply a validated patch: curriculum → history → profile → project.
 * Compute-then-write: every output (the mutated curriculum, the rendered
 * history entry, the transformed profile text) is computed first; file
 * writes only start once all of them have succeeded, so a late failure
 * (e.g. a profile edit whose needle doesn't match) can never leave a
 * partial apply on disk — nothing before the writes throws mid-write.
 */
export function applySessionPatch(
  paths: DataPaths,
  patch: SessionPatch,
  /** The configured curve, so the summary quotes the interval the selector will
   *  actually honor. Omit only where no spacing config exists. */
  spacing?: SpacingConfig,
  opts: ApplyOptions = {}
): ApplyResult {
  const pre = checkPatch(paths, patch);
  if (pre.length) throw new Error(`patch rejected:\n  - ${pre.join("\n  - ")}`);

  const summary: string[] = [];
  const c = loadCurriculum(paths.curriculum);
  const lessonNumber = nextLessonNumber(paths.history);

  // --- compute phase: no writes yet ---
  applyCurriculumChanges(c, patch, lessonNumber, summary, spacing, opts.finishLaneId);

  const names = {
    lane: (id: string) => laneById(c, id)?.name ?? id,
    unit: (id: string) => unitById(c, id)?.unit.name ?? id,
    topic: (id: string) => topicById(c, id)?.topic.name ?? id,
  };
  const entry = renderEntry(names, patch.lesson, lessonNumber);

  let proposed: string[] = [];
  let profileResult: { lines: string[]; changed: boolean } | null = null;
  if (patch.profile) {
    const rawLines = readFileSync(paths.profile, "utf8").split("\n");
    profileResult = applyProfilePatchToLines(rawLines, patch.profile);
    proposed = patch.profile.proposedConfirmedPatterns ?? [];
  }

  const digests = loadDigests(paths.lessonDigests);
  digests.lessons[String(lessonNumber)] = digestFromRecord(patch.lesson, "commit");

  // --- write phase: everything above succeeded, so these can't leave a partial apply ---
  saveCurriculum(paths.curriculum, c);
  summary.push(`curriculum.yaml written`);

  prependEntry(paths.history, entry);
  summary.push(`lesson-history.md: added Lesson ${lessonNumber}`);

  saveDigests(paths.lessonDigests, digests);
  summary.push(`lesson-digests.json: title, ${patch.lesson.keyPoints.length} key points, ${patch.lesson.sources.length} source(s)`);

  if (profileResult && profileResult.changed) {
    writeFileSync(paths.profile, profileResult.lines.join("\n"), "utf8");
    summary.push(`profile.md updated`);
  }

  if (patch.project) {
    writeProjectDoc(paths.projectsDir, patch.project.laneId, patch.project.content);
    summary.push(`project ${patch.project.laneId}.md written`);
  }

  return { lessonNumber, summary, proposedConfirmedPatterns: proposed };
}

// ---------------------------------------------------------------------------

function applyCurriculumChanges(
  c: Curriculum,
  patch: SessionPatch,
  lessonNumber: number,
  summary?: string[],
  spacing?: SpacingConfig,
  finishLaneId?: string
): void {
  // Topic lines quote the earned recall interval, which depends on whether the
  // lane ends in this same write — so they're worded last, after the ending.
  const topicLines: (() => string)[] = [];
  applyCurriculumEdits(c, patch, lessonNumber, topicLines, summary, spacing);
  if (finishLaneId) recordEnding(c, finishLaneId, patch.lesson.date, summary ?? []);
  for (const line of topicLines) summary?.push(line());
}

function applyCurriculumEdits(
  c: Curriculum,
  patch: SessionPatch,
  lessonNumber: number,
  topicLines: (() => string)[],
  summary?: string[],
  spacing?: SpacingConfig
): void {
  const cur = patch.curriculum;
  const L = patch.lesson;
  if (!cur) return;

  for (const spec of cur.newUnits ?? []) {
    const lane = laneById(c, spec.laneId);
    if (!lane) throw new Error(`newUnits: lane '${spec.laneId}' does not exist`);
    if (unitById(c, spec.unit.id)) throw new Error(`newUnits: unit id '${spec.unit.id}' already exists`);
    const unit: Unit = {
      id: spec.unit.id,
      name: spec.unit.name,
      state: spec.unit.state ?? "not-started",
      currentTopic: null,
      prerequisites: spec.unit.prerequisites ?? [],
      bridgeTopics: spec.unit.bridgeTopics ?? [],
      notes: spec.unit.notes ?? "",
      coreTopics: [],
      optionalTopics: [],
      completedAt: null,
    };
    // A unit created straight into a completed state still gets its date.
    stampCompletedAt(unit, L.date);
    lane.units.push(unit);
    summary?.push(`added unit ${spec.unit.id} to lane ${spec.laneId}`);
  }

  for (const spec of cur.newTopics ?? []) {
    const hit = unitById(c, spec.unitId);
    if (!hit) throw new Error(`newTopics: unit '${spec.unitId}' does not exist`);
    if (topicById(c, spec.topic.id)) throw new Error(`newTopics: topic id '${spec.topic.id}' already exists`);
    const t: Topic = {
      id: spec.topic.id,
      name: spec.topic.name,
      state: spec.topic.state ?? "not-started",
      lastTouched: null,
      prerequisites: spec.topic.prerequisites ?? [],
      buildsToward: spec.topic.buildsToward ?? [],
      notes: spec.topic.notes ?? "",
    };
    (spec.group === "core" ? hit.unit.coreTopics : hit.unit.optionalTopics).push(t);
    summary?.push(`added ${spec.group} topic ${t.id} to unit ${spec.unitId}`);
  }

  for (const u of cur.topicUpdates ?? []) {
    const hit = topicById(c, u.id);
    if (!hit) throw new Error(`topicUpdates: topic '${u.id}' does not exist`);
    if (u.state) hit.topic.state = u.state;
    if (u.notes !== undefined) hit.topic.notes = u.notes;
    if (u.touched !== false) hit.topic.lastTouched = { date: L.date, lesson: lessonNumber };
    // Shared with the standalone recall check so the streak rules can't drift.
    if (u.recall) applyRecallGrade(hit.topic, u.recall, L.date, u.state);
    topicLines.push(() => `topic ${u.id}: ${describeTopicUpdate(u, hit.topic, hit.lane, spacing)}`);
  }

  for (const u of cur.unitUpdates ?? []) {
    const hit = unitById(c, u.id);
    if (!hit) throw new Error(`unitUpdates: unit '${u.id}' does not exist`);
    if (u.state) {
      hit.unit.state = u.state;
      stampCompletedAt(hit.unit, L.date);
    }
    if (u.currentTopic !== undefined) hit.unit.currentTopic = u.currentTopic;
    if (u.notes !== undefined) hit.unit.notes = u.notes;
    summary?.push(`unit ${u.id} updated`);
  }

  for (const u of cur.laneUpdates ?? []) {
    const lane = laneById(c, u.id);
    if (!lane) throw new Error(`laneUpdates: lane '${u.id}' does not exist`);
    if (u.currentUnit !== undefined) lane.currentUnit = u.currentUnit;
    if (u.direction !== undefined) lane.direction = u.direction;
    if (u.nextUp !== undefined) lane.nextUp = u.nextUp;
    summary?.push(
      `lane ${u.id} updated${u.nextUp ? ` (next up: ${u.nextUp.topicId ?? u.nextUp.unitId})` : ""}`
    );
  }
}

/**
 * Stamp a lane's ending after a capstone. Only while the lane is still out of
 * units once the patch has applied — a capstone that reopened a unit (or ran on a
 * lane that was extended meanwhile) records nothing, and says so.
 */
function recordEnding(c: Curriculum, laneId: string, date: string, summary: string[]): void {
  const lane = laneById(c, laneId);
  if (!lane) return;
  if (isLaneFinished(lane)) {
    summary.push(`course ${laneId} was already finished (${lane.finishedAt}) — ending not re-recorded`);
  } else if (!laneOutOfUnits(lane)) {
    summary.push(`capstone committed, but course ${laneId} still has unfinished units — not marked finished`);
  } else {
    lane.finishedAt = date;
    summary.push(`course ${laneId} finished ${date}`);
  }
}

const COMPLETED_STATES: UnitState[] = ["core-complete", "complete"];

/**
 * Keep `completedAt` in step with the unit's state. Called after every state
 * write, never from a patch field — the model has no say in this date.
 *
 * First arrival at core-complete/complete stamps the lesson's date; a later
 * core-complete → complete keeps the original (first completion is the
 * meaningful one); reopening the unit clears it, so a re-completion re-stamps.
 */
function stampCompletedAt(unit: Unit, lessonDate: string): void {
  const done = COMPLETED_STATES.includes(unit.state);
  if (done) unit.completedAt ??= lessonDate;
  else unit.completedAt = null;
}

/** `after` is the already-mutated topic, so the summary can quote the earned interval.
 *  `spacing` must be the configured curve — quoting the default here reports an
 *  interval the selector will not honor once TUTOR_STALE_DAYS is set. */
function describeTopicUpdate(u: TopicUpdate, after: Topic, lane: Lane, spacing?: SpacingConfig): string {
  const bits: string[] = [];
  if (u.recall) {
    const { streak } = getRecall(after);
    bits.push(
      `recall ${u.recall} (streak ${streak} → next in ${Math.round(recallInterval(lane, streak, spacing))}d)`
    );
  }
  if (u.state) bits.push(`state → ${u.state}`);
  else if (u.recall === "miss") bits.push(`state → shaky`);
  if (u.notes !== undefined) bits.push(`notes replaced`);
  if (u.touched !== false) bits.push(`touched`);
  return bits.join(", ") || "no-op";
}
