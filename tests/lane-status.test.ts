// A course (lane) ending: when it counts as finished, what that changes for the
// select screen and recall, and how reopening it in course-setup undoes it.
// Runs against the frozen fixture (tests/fixtures/), mutated in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCurriculum, saveCurriculum, topicById } from "../core/curriculum.js";
import {
  capstoneDue,
  looseEnds,
  FINISHED_RECALL_FACTOR,
  isLaneFinished,
  laneFinishedAt,
  laneOutOfUnits,
  laneShares,
  recallInterval,
} from "../core/lane-status.js";
import { recallCandidates, recommendNext } from "../core/selector.js";
import { DEFAULT_SPACING, stabilityDays } from "../core/spacing.js";
import { validateCurriculum } from "../core/validator.js";
import { buildSessionPacket } from "../core/slicer.js";
import { applySessionPatch } from "../core/patcher.js";
import { CAPSTONE_MACHINERY, kickoffMessage } from "../server/prompt.js";
import type { Curriculum, DataPaths, Lane, SessionPatch, Unit } from "../core/types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(): Curriculum {
  return loadCurriculum(join(FIX, "curriculum.yaml"));
}

/** Every unit done on `doneOn`, and the ending recorded on `finishedAt`. */
function finish(lane: Lane, doneOn: string, finishedAt: string | null = doneOn): void {
  for (const u of lane.units) {
    u.state = "core-complete";
    u.completedAt = doneOn;
  }
  lane.finishedAt = finishedAt;
}

function scratch(c: Curriculum): DataPaths {
  const dir = mkdtempSync(join(tmpdir(), "tutor-lane-status-"));
  for (const f of ["profile.md", "lesson-history.md"]) cpSync(join(FIX, f), join(dir, f));
  const paths: DataPaths = {
    curriculum: join(dir, "curriculum.yaml"),
    profile: join(dir, "profile.md"),
    history: join(dir, "lesson-history.md"),
    projectsDir: join(dir, "projects"),
    unitSummaries: join(dir, "unit-summaries.json"),
    lessonDigests: join(dir, "lesson-digests.json"),
  };
  saveCurriculum(paths.curriculum, c);
  return paths;
}

test("a lane is finished only when every unit is done AND the ending is recorded", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  assert.equal(laneOutOfUnits(ai), false);
  assert.equal(laneFinishedAt(ai), null, "a running lane is not finished");

  finish(ai, "2026-11-20", null);
  assert.equal(laneOutOfUnits(ai), true, "every unit core-complete = out of units");
  assert.equal(laneFinishedAt(ai), null, "out of units is not finished until the ending is recorded");

  ai.finishedAt = "2026-11-20";
  assert.equal(laneFinishedAt(ai), "2026-11-20", "same-day ending counts");

  ai.units[0].state = "complete";
  assert.equal(isLaneFinished(ai), true, "complete and core-complete both count as done");

  // A date recorded on a lane that still has work left doesn't finish it.
  ai.units[1].state = "in-progress";
  assert.equal(isLaneFinished(ai), false);

  // An empty lane is never out of units.
  const empty: Lane = { ...ai, units: [], finishedAt: "2026-11-20" };
  assert.equal(isLaneFinished(empty), false);
});

test("reopening in course-setup un-finishes a lane without clearing the date", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  finish(ai, "2026-11-20");
  assert.equal(isLaneFinished(ai), true);

  // course-setup appends a unit: the lane is running again.
  const added: Unit = { ...structuredClone(ai.units[0]), id: "ai-new-unit", state: "not-started", completedAt: null };
  ai.units.push(added);
  assert.equal(isLaneFinished(ai), false, "a new not-started unit reopens the course");

  // That unit gets done later: out of units again, but the old ending predates it,
  // so the course is waiting on a fresh ending (its own capstone), not finished.
  added.state = "core-complete";
  added.completedAt = "2026-12-05";
  assert.equal(laneOutOfUnits(ai), true);
  assert.equal(isLaneFinished(ai), false, "a unit completed after finishedAt means it was extended");

  ai.finishedAt = "2026-12-06";
  assert.equal(laneFinishedAt(ai), "2026-12-06");
});

test("a finished lane recommends nothing, even with a stale nextUp", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  assert.ok(ai.nextUp, "fixture lane has a nextUp");
  finish(ai, "2026-11-20");
  const rec = recommendNext(c, ai);
  assert.equal(rec.kind, "finished");
  assert.equal(rec.primary, undefined);
  assert.deepEqual(rec.alternatives, []);
  assert.match(rec.note ?? "", /finished on 2026-11-20/);
});

test("recall on a finished lane: intervals doubled, still capped, topics never dropped", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  for (const streak of [0, 1, 2, 3, 4, 9]) {
    assert.equal(recallInterval(ai, streak), stabilityDays(streak), "running lane: the usual curve");
  }
  finish(ai, "2026-11-20");
  assert.equal(FINISHED_RECALL_FACTOR, 2);
  assert.equal(recallInterval(ai, 0), 28);
  assert.equal(recallInterval(ai, 1), 70);
  assert.equal(recallInterval(ai, 3), DEFAULT_SPACING.maxDays, "219d × 2 caps at a year");
  assert.equal(recallInterval(ai, 9), DEFAULT_SPACING.maxDays);

  // A comfortable topic 20 days stale: due on a running lane (14d), quiet on a finished one (28d).
  const hit = topicById(c, "ai-nn-foundations-activation")!;
  hit.topic.state = "comfortable";
  hit.topic.lastTouched = { date: "2026-11-01", lesson: 1 };
  delete hit.topic.recall;
  const due = (today: string) =>
    recallCandidates(c, { today, laneId: "ai", probabilistic: false, max: 999, bundle: false }).map(
      (r) => r.topicId
    );
  assert.ok(!due("2026-11-21").includes("ai-nn-foundations-activation"), "inside the doubled interval");
  const later = recallCandidates(c, { today: "2026-11-29", laneId: "ai", probabilistic: false, max: 999 });
  const r = later.find((x) => x.topicId === "ai-nn-foundations-activation");
  assert.ok(r, "still offered once the doubled interval passes");
  assert.equal(r!.stabilityDays, 28);

  ai.finishedAt = null; // reopened → back to the usual curve
  assert.ok(due("2026-11-21").includes("ai-nn-foundations-activation"));
});

test("a finished lane's weight is shared out over the running lanes", () => {
  const c = fixture();
  const before = laneShares(c);
  const total = c.lanes.reduce((s, l) => s + l.weight, 0);
  for (const l of c.lanes) assert.equal(before.get(l.id), Math.round((l.weight / total) * 100));

  const ai = c.lanes.find((l) => l.id === "ai")!;
  finish(ai, "2026-11-20");
  const after = laneShares(c);
  assert.equal(after.get("ai"), 0);
  const rest = c.lanes.filter((l) => l.id !== "ai");
  const restTotal = rest.reduce((s, l) => s + l.weight, 0);
  for (const l of rest) assert.equal(after.get(l.id), Math.round((l.weight / restTotal) * 100));

  for (const l of c.lanes) finish(l, "2026-11-20");
  assert.ok([...laneShares(c).values()].every((v) => v === 0), "nothing running → every share 0");
});

test("validator checks finishedAt's shape; saving never stamps it on running lanes", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  ai.finishedAt = "Nov 20";
  assert.ok(validateCurriculum(c).some((e) => e.includes("finishedAt")));
  ai.finishedAt = "2026-11-20";
  assert.deepEqual(validateCurriculum(c), []);

  const paths = scratch(fixture());
  assert.ok(!readFileSync(paths.curriculum, "utf8").includes("finishedAt"), "no finishedAt: null churn");
});

test("packet: a finished lane says so instead of 'check lane pointers'; the default lane skips it", () => {
  const c = fixture();
  finish(c.lanes.find((l) => l.id === "ai")!, "2026-11-20");
  const paths = scratch(c);
  const opts = { size: "standard" as const, model: "opus", historyN: 1, today: "2026-11-24", spacing: DEFAULT_SPACING };

  const explicit = buildSessionPacket(paths, { ...opts, laneId: "ai" });
  assert.match(explicit, /This course finished on 2026-11-20/);
  assert.ok(!explicit.includes("nothing derivable"));

  const byDefault = buildSessionPacket(paths, opts);
  assert.ok(!byDefault.includes("(ai) — default"), "ai is the heaviest lane but finished");
  assert.match(byDefault, /\(sts\) — default/);
  assert.match(byDefault, /FINISHED 2026-11-20/, "other-lanes one-liner marks the finished course");
});

// ---------------------------------------------------------------------------
// The capstone: what closes a course out and records its ending.
// ---------------------------------------------------------------------------

test("out of units with no recorded ending → the capstone is next, over a stale nextUp", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  assert.equal(capstoneDue(ai), false);
  finish(ai, "2026-11-20", null);
  assert.ok(ai.nextUp, "a stale nextUp from the last wrap-up");
  assert.equal(capstoneDue(ai), true);
  const rec = recommendNext(c, ai);
  assert.equal(rec.kind, "capstone");
  assert.ok(rec.primary && !rec.primary.topicId && !rec.primary.unitId);
  // Leftover optional topics stay on offer.
  const optional = ai.units.flatMap((u) => u.optionalTopics).filter((t) => t.state === "not-started");
  assert.ok(optional.length > 0, "fixture has untouched optional topics");
  assert.deepEqual(new Set(rec.alternatives.map((a) => a.topicId)), new Set(optional.map((t) => t.id)));

  // Finished → no longer due. Extended and done again → due again (a fresh capstone).
  ai.finishedAt = "2026-11-20";
  assert.equal(capstoneDue(ai), false);
  ai.units[0].completedAt = "2026-12-01";
  assert.equal(capstoneDue(ai), true);
});

test("capstone packet maps the whole course and lists its loose ends", () => {
  const c = fixture();
  const ai = c.lanes.find((l) => l.id === "ai")!;
  finish(ai, "2026-11-20", null);
  const shaky = ai.units[1].coreTopics[0];
  shaky.state = "shaky";
  const paths = scratch(c);
  const opts = { size: "tight" as const, model: "opus", historyN: 1, today: "2026-11-24", spacing: DEFAULT_SPACING };

  const packet = buildSessionPacket(paths, { ...opts, laneId: "ai", capstone: true });
  assert.match(packet, /\*\*Primary:\*\* the closing capstone/);
  assert.match(packet, /## Capstone — closing out/);
  assert.match(packet, /3–5 questions whatever the session size/);
  for (const u of ai.units) assert.ok(packet.includes(`(${u.id}) [core-complete]`), `maps unit ${u.id}`);
  assert.ok(looseEnds(ai).some((x) => x.topic.id === shaky.id));
  assert.match(packet, new RegExp(`- ${shaky.name.replace(/[()]/g, ".")} \\(${shaky.id}\\) \\[shaky\\]`));

  const plain = buildSessionPacket(paths, { ...opts, laneId: "ai" });
  assert.ok(!plain.includes("## Capstone"), "only a capstone session gets the map");
});

function capstonePatch(): SessionPatch {
  return {
    lesson: {
      date: "2026-11-24",
      laneId: "ai",
      unitId: "ai-nn-foundations",
      topicIds: ["ai-nn-foundations-loss"],
      whatHappened: "Capstone (test).",
      performanceSketch: "Solid (test).",
      sourcesUsed: "None.",
      feedbackCaptured: "skipped",
      askedAbout: "nothing new",
      title: "Capstone: a test case",
      keyPoints: ["First conclusion.", "Second conclusion.", "Third conclusion."],
      sources: [],
    },
    curriculum: {
      topicUpdates: [{ id: "ai-nn-foundations-loss", recall: "rusty" }],
      laneUpdates: [{ id: "ai", nextUp: null }],
    },
  };
}

test("committing the capstone records the ending; nothing else does", () => {
  const c = fixture();
  finish(c.lanes.find((l) => l.id === "ai")!, "2026-11-20", null);

  // A normal commit on a capstone-due lane records nothing.
  let paths = scratch(c);
  applySessionPatch(paths, capstonePatch());
  assert.equal(loadCurriculum(paths.curriculum).lanes.find((l) => l.id === "ai")!.finishedAt ?? null, null);

  // The capstone commit stamps the lesson date, and the course is now finished.
  paths = scratch(c);
  const res = applySessionPatch(paths, capstonePatch(), DEFAULT_SPACING, { finishLaneId: "ai" });
  const after = loadCurriculum(paths.curriculum).lanes.find((l) => l.id === "ai")!;
  assert.equal(after.finishedAt, "2026-11-24");
  assert.equal(isLaneFinished(after), true);
  assert.ok(res.summary.includes("course ai finished 2026-11-24"));
  assert.ok(res.summary.some((l) => l.includes("next in 28d")), "a finished course's recall quotes the doubled interval");

  // A capstone whose patch reopened a unit records nothing, and says so.
  paths = scratch(c);
  const reopening = capstonePatch();
  reopening.curriculum!.unitUpdates = [{ id: "ai-nn-foundations", state: "in-progress" }];
  const res2 = applySessionPatch(paths, reopening, DEFAULT_SPACING, { finishLaneId: "ai" });
  assert.equal(loadCurriculum(paths.curriculum).lanes.find((l) => l.id === "ai")!.finishedAt ?? null, null);
  assert.ok(res2.summary.some((l) => l.includes("not marked finished")));
});

test("capstone instructions carry the design: case, arc, nudge, size, gentle grading", () => {
  const m = CAPSTONE_MACHINERY;
  assert.match(m, /recent and real/);
  assert.match(m, /say plainly that\s+it is invented/);
  assert.match(m, /3 TO 5 QUESTIONS/);
  assert.match(m, /NUDGE BEFORE YOU GRADE/);
  assert.match(m, /cut off/);
  assert.match(m, /recall "rusty", never "miss"/);
  assert.match(m, /Work every loose end/);
  const params = { size: "tight" as const, model: "opus" as const, historyN: 3, spacing: DEFAULT_SPACING };
  assert.match(kickoffMessage({ ...params, capstone: true }), /mode=capstone.*open the capstone/);
  assert.ok(!kickoffMessage(params).includes("capstone"));
});
