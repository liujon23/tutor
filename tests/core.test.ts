import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCurriculum, saveCurriculum } from "../core/curriculum.js";
import { validateCurriculum } from "../core/validator.js";
import { recommendNext, recallCandidates } from "../core/selector.js";
import { DEFAULT_SPACING, offerProbability, seededUnit, stabilityDays } from "../core/spacing.js";
import { parseHistory, nextLessonNumber, condenseEntry } from "../core/history.js";
import { applyProfilePatch, checkProfilePatch } from "../core/profile.js";
import { applySessionPatch, checkPatch } from "../core/patcher.js";
import { buildSessionPacket } from "../core/slicer.js";
import { renderUnitFull } from "../core/render.js";
import { buildLaneDoc, renderLaneMarkdown, renderLaneHtml } from "../core/lane-doc.js";
import type { DataPaths, Lane, ProfilePatch, SessionPatch } from "../core/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The real, mutable data files — only used to assert the *shipped* curriculum
// stays valid. Everything else runs against the frozen fixture below, so a real
// committed lesson (which mutates data/) can't shift these tests' expectations.
const REAL: DataPaths = {
  curriculum: join(ROOT, "data", "curriculum.yaml"),
  profile: join(ROOT, "data", "profile.md"),
  history: join(ROOT, "data", "lesson-history.md"),
  projectsDir: join(ROOT, "data", "projects"),
};

// A frozen snapshot of the data — see tests/fixtures/README.md. All behavioural
// assertions (lesson counts, staleness, nextUp, packet contents) are written
// against this exact state; regenerate it only deliberately.
const FIXTURE: DataPaths = {
  curriculum: join(ROOT, "tests", "fixtures", "curriculum.yaml"),
  profile: join(ROOT, "tests", "fixtures", "profile.md"),
  history: join(ROOT, "tests", "fixtures", "lesson-history.md"),
  projectsDir: join(ROOT, "tests", "fixtures", "projects"),
};

function scratchCopy(): DataPaths {
  const dir = mkdtempSync(join(tmpdir(), "tutor-test-"));
  cpSync(FIXTURE.curriculum, join(dir, "curriculum.yaml"));
  cpSync(FIXTURE.profile, join(dir, "profile.md"));
  cpSync(FIXTURE.history, join(dir, "lesson-history.md"));
  return {
    curriculum: join(dir, "curriculum.yaml"),
    profile: join(dir, "profile.md"),
    history: join(dir, "lesson-history.md"),
    projectsDir: join(dir, "projects"),
  };
}

test("shipped curriculum is valid", () => {
  const c = loadCurriculum(REAL.curriculum);
  assert.deepEqual(validateCurriculum(c), []);
  // Structural only — the lane count differs across checkouts of this repo
  // (this private repo currently has 4; a future public checkout has 3).
  assert.ok(c.lanes.length >= 1, "at least one lane");
});

// saveCurriculum re-serializes the whole doc, so the FIRST script write of a
// hand-authored file can reflow formatting once. After that it must be a fixed
// point — otherwise every committed lesson would churn hundreds of unrelated
// lines (quote/wrap noise) on top of its real changes. This locks that in.
test("saveCurriculum is idempotent — no formatting churn after the first write", () => {
  const paths = scratchCopy();
  saveCurriculum(paths.curriculum, loadCurriculum(paths.curriculum));
  const firstWrite = readFileSync(paths.curriculum, "utf8");
  saveCurriculum(paths.curriculum, loadCurriculum(paths.curriculum));
  const secondWrite = readFileSync(paths.curriculum, "utf8");
  assert.equal(secondWrite, firstWrite, "re-saving a saved curriculum must reproduce it byte-for-byte");
});

test("validator catches cross-unit topic edges and cycles", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  // Cross-unit edge: point an AI-foundations topic at a sequence-models topic.
  const t = c.lanes[0].units[0].coreTopics[0];
  t.prerequisites = ["ai-sequence-models-rnn"];
  let errs = validateCurriculum(c);
  assert.ok(errs.some((e) => e.includes("crosses a unit boundary")), errs.join("; "));

  // Cycle: A → B → A within one unit.
  const c2 = loadCurriculum(FIXTURE.curriculum);
  const u = c2.lanes[0].units[0];
  u.coreTopics[0].prerequisites = [u.coreTopics[1].id];
  u.coreTopics[1].prerequisites = [u.coreTopics[0].id];
  errs = validateCurriculum(c2);
  assert.ok(errs.some((e) => e.includes("cycle")), errs.join("; "));
});

test("selector honors nextUp, then derives", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const ai = c.lanes.find((l) => l.id === "ai")!;
  let rec = recommendNext(c, ai);
  assert.equal(rec.kind, "next-up");
  assert.equal(rec.primary?.topicId, "ai-nn-foundations-loss");
  // Clear nextUp → derivation should land on the same topic (first not-started core).
  ai.nextUp = null;
  rec = recommendNext(c, ai);
  assert.equal(rec.kind, "next-core");
  assert.equal(rec.primary?.topicId, "ai-nn-foundations-loss");
});

test("selector honors a unit-level nextUp (new unit, topics not created yet)", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const ai = c.lanes.find((l) => l.id === "ai")!;
  ai.nextUp = { unitId: "ai-sequence-models", plan: "Open the sequence-modeling unit." };
  const rec = recommendNext(c, ai);
  assert.equal(rec.kind, "unit-seam");
  assert.equal(rec.primary?.unitId, "ai-sequence-models");
  assert.equal(rec.primary?.topicId, undefined);
  assert.equal(rec.primary?.plan, "Open the sequence-modeling unit.");
  assert.deepEqual(validateCurriculum(c), [], "a unit-level nextUp is valid");
});

test("validator rejects a nextUp with no target or a bad unit", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const ai = c.lanes.find((l) => l.id === "ai")!;
  ai.nextUp = { plan: "no target" } as typeof ai.nextUp;
  assert.ok(validateCurriculum(c).some((e) => e.includes("exactly one of")));
  ai.nextUp = { unitId: "does-not-exist", plan: "bad unit" };
  assert.ok(validateCurriculum(c).some((e) => e.includes("nextUp unit")));
});

test("recall candidates respect staleness threshold and ordering", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  // As of 2026-07-16: activation was touched 2026-06-01 (45 days old — past its
  // streak-0 interval of 14d); backprop was touched 2026-07-10 (6 days old — not
  // due at any interval). Loss is `shaky`, not `comfortable`, so it's never a
  // recall candidate regardless of its lastTouched. Nothing outside the ai lane
  // is touched at all. probabilistic:false makes this a pure threshold check.
  const cands14 = recallCandidates(c, { today: "2026-07-16", probabilistic: false });
  assert.equal(cands14.length, 1);
  assert.equal(cands14[0].topicId, "ai-nn-foundations-activation");
  assert.equal(cands14[0].streak, 0);
  assert.equal(cands14[0].stabilityDays, 14);
  assert.equal(cands14[0].overdueDays, 45 - 14);
  // At a 2-day base both comfortable topics come due, most-overdue first —
  // backprop's streak of 1 widens its interval to 5d (2 · 2.5), and its 6 stale
  // days still clear that.
  const cands2 = recallCandidates(c, {
    today: "2026-07-16",
    probabilistic: false,
    max: 5,
    spacing: { ...DEFAULT_SPACING, baseDays: 2 },
  });
  assert.deepEqual(
    cands2.map((r) => r.topicId),
    ["ai-nn-foundations-activation", "ai-nn-foundations-backprop"]
  );
  assert.equal(cands2[1].streak, 1);
  assert.equal(cands2[1].stabilityDays, 5);
});

test("recall: a grown streak keeps a topic quiet until its widened interval passes", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  // Give activation a 2-streak: interval 14 · 2.5² = 87.5d. At 45 days stale it
  // is no longer due, even unsampled — a clean recall buys real silence.
  const activation = c.lanes[0].units[0].coreTopics[0];
  activation.recall = { streak: 2, reviews: 2, last: { date: "2026-06-01", result: "clean" } };
  assert.deepEqual(validateCurriculum(c), [], "recall history is valid");
  const cands = recallCandidates(c, { today: "2026-07-16", probabilistic: false });
  assert.ok(!cands.some((r) => r.topicId === activation.id), "inside its widened interval");
  // ...but 90 days out it has cleared the floor again.
  const later = recallCandidates(c, { today: "2026-08-30", probabilistic: false });
  assert.ok(later.some((r) => r.topicId === activation.id), "due again past the widened interval");
});

test("spacing math: exponential growth, capped; probability 0 below floor, ramping above", () => {
  assert.equal(stabilityDays(0), 14);
  assert.equal(stabilityDays(1), 35);
  assert.equal(stabilityDays(2), 87.5);
  assert.equal(stabilityDays(10), 365, "capped at maxDays");
  assert.equal(offerProbability(13, 14), 0, "hard floor");
  const atDue = offerProbability(14, 14);
  assert.ok(Math.abs(atDue - (1 - Math.exp(-1))) < 1e-9, "~63% the day it comes due");
  assert.ok(offerProbability(28, 14) > atDue, "monotonic past the floor");
});

test("recall sampling is seeded — identical within a day, and never offers an undue topic", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const draw1 = recallCandidates(c, { today: "2026-07-16" });
  const draw2 = recallCandidates(c, { today: "2026-07-16" });
  assert.deepEqual(draw1, draw2, "same day → same candidates on every call");
  // Whatever the draw includes must be a subset of the unsampled due set.
  const due = new Set(
    recallCandidates(c, { today: "2026-07-16", probabilistic: false }).map((r) => r.topicId)
  );
  for (const r of draw1) assert.ok(due.has(r.topicId), `${r.topicId} offered while not due`);
  // The seed varies by day and by topic.
  assert.notEqual(seededUnit("2026-07-16|a"), seededUnit("2026-07-17|a"));
  assert.notEqual(seededUnit("2026-07-16|a"), seededUnit("2026-07-16|b"));
});

test("recall is lane-paired: a lane filter excludes every other lane", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const spacing = { ...DEFAULT_SPACING, baseDays: 2 };
  const ai = recallCandidates(c, { today: "2026-07-16", laneId: "ai", probabilistic: false, spacing });
  assert.ok(ai.length >= 2);
  assert.ok(ai.every((r) => r.laneId === "ai"));
  // No other lane has anything touched, so their recall is empty — not borrowed.
  const sts = recallCandidates(c, { today: "2026-07-16", laneId: "sts", probabilistic: false, spacing });
  assert.deepEqual(sts, []);
});

test("recall bundling: same-unit candidates are linked; the packet names the bundle", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const spacing = { ...DEFAULT_SPACING, baseDays: 2 };
  const cands = recallCandidates(c, { today: "2026-07-16", probabilistic: false, spacing });
  const act = cands.find((r) => r.topicId === "ai-nn-foundations-activation")!;
  const bp = cands.find((r) => r.topicId === "ai-nn-foundations-backprop")!;
  assert.deepEqual(act.bundleWith, [bp.topicId]);
  assert.deepEqual(bp.bundleWith, [act.topicId]);
});

test("patcher: recall grades drive the streak; miss demotes unless state overrides", () => {
  // clean → streak grows (backprop starts at 1 in the fixture).
  let paths = scratchCopy();
  const recallPatch = (recall: "clean" | "rusty" | "miss", state?: "comfortable"): SessionPatch => ({
    ...structuredClone(goodPatch),
    curriculum: { topicUpdates: [{ id: "ai-nn-foundations-backprop", recall, ...(state ? { state } : {}) }] },
  });
  applySessionPatch(paths, recallPatch("clean"));
  let bp = loadCurriculum(paths.curriculum).lanes[0].units[0].coreTopics[1];
  assert.deepEqual(bp.recall, {
    streak: 2,
    reviews: 3,
    last: { date: "2026-07-01", result: "clean" },
  });
  assert.equal(bp.state, "comfortable");

  // rusty → streak resets, state stays comfortable.
  paths = scratchCopy();
  applySessionPatch(paths, recallPatch("rusty"));
  bp = loadCurriculum(paths.curriculum).lanes[0].units[0].coreTopics[1];
  assert.equal(bp.recall!.streak, 0);
  assert.equal(bp.state, "comfortable");

  // miss → streak resets AND the topic is demoted to shaky by default...
  paths = scratchCopy();
  applySessionPatch(paths, recallPatch("miss"));
  bp = loadCurriculum(paths.curriculum).lanes[0].units[0].coreTopics[1];
  assert.equal(bp.recall!.streak, 0);
  assert.equal(bp.state, "shaky");

  // ...but an explicit state in the patch wins over the demotion.
  paths = scratchCopy();
  applySessionPatch(paths, recallPatch("miss", "comfortable"));
  bp = loadCurriculum(paths.curriculum).lanes[0].units[0].coreTopics[1];
  assert.equal(bp.state, "comfortable");
});

test("checkPatch rejects a bad recall grade; validator flags malformed recall history", () => {
  const paths = scratchCopy();
  const bad = structuredClone(goodPatch);
  // @ts-expect-error deliberate bad grade
  bad.curriculum!.topicUpdates![0].recall = "perfect";
  assert.ok(checkPatch(paths, bad).some((e) => e.includes("bad recall")));

  const c = loadCurriculum(FIXTURE.curriculum);
  const t = c.lanes[0].units[0].coreTopics[0];
  t.recall = { streak: -1, reviews: 1.5, last: { date: "bad-date", result: "great" as never } };
  const errs = validateCurriculum(c);
  assert.ok(errs.some((e) => e.includes("recall.streak")), errs.join("; "));
  assert.ok(errs.some((e) => e.includes("recall.reviews")), errs.join("; "));
  assert.ok(errs.some((e) => e.includes("recall.last.result")), errs.join("; "));
  assert.ok(errs.some((e) => e.includes("recall.last.date")), errs.join("; "));
});

test("history parses and numbers correctly", () => {
  const { entries } = parseHistory(readFileSync(FIXTURE.history, "utf8"));
  assert.deepEqual(entries.map((e) => e.number), [3, 2, 1]);
  assert.equal(nextLessonNumber(FIXTURE.history), 4);
});

test("condenseEntry keeps header + Lane/Unit/Topic + Performance sketch, drops the rest", () => {
  const { entries } = parseHistory(readFileSync(FIXTURE.history, "utf8"));
  const lesson3 = entries.find((e) => e.number === 3)!;
  const condensed = condenseEntry(lesson3);

  assert.ok(condensed.includes("## Lesson 3 — 2026-07-10"), "header kept");
  assert.ok(condensed.includes("**Lane / Unit / Topic:**"), "Lane/Unit/Topic kept");
  assert.ok(condensed.includes("**Performance sketch:**"), "Performance sketch kept");
  assert.ok(condensed.includes("Strong, as expected for review"), "performance sketch text kept");

  for (const dropped of ["**What happened:**", "**Sources used:**", "**Feedback captured:**", "**Asked about:**"]) {
    assert.ok(!condensed.includes(dropped), `should have dropped: ${dropped}`);
  }
  assert.ok(!condensed.includes("Default lane mix (no override)"), "What happened body text dropped");

  // Falls back to the full body rather than crashing on an unparseable entry.
  const weird = { number: 99, date: "2026-01-01", body: "not a real entry at all" };
  assert.equal(condenseEntry(weird), weird.body);
});

test("confirmed-pattern gate: proposals are surfaced, never written", () => {
  const paths = scratchCopy();
  const res = applyProfilePatch(paths.profile, {
    proposedConfirmedPatterns: ["NEVER-WRITE-ME"],
    workingNotes: { add: ["a harmless test hunch"] },
  });
  const text = readFileSync(paths.profile, "utf8");
  assert.ok(!text.includes("NEVER-WRITE-ME"));
  assert.ok(text.includes("a harmless test hunch"));
  assert.deepEqual(res.proposedConfirmedPatterns, ["NEVER-WRITE-ME"]);
});

const goodPatch: SessionPatch = {
  lesson: {
    date: "2026-07-01",
    laneId: "ai",
    unitId: "ai-nn-foundations",
    topicIds: ["ai-nn-foundations-loss"],
    whatHappened: "Taught loss functions & optimization (test fixture).",
    performanceSketch: "Solid (test fixture).",
    sourcesUsed: "None.",
    feedbackCaptured: "skipped",
    askedAbout: "nothing new",
  },
  curriculum: {
    topicUpdates: [{ id: "ai-nn-foundations-loss", state: "comfortable", notes: "Test note." }],
    unitUpdates: [{ id: "ai-nn-foundations", currentTopic: "ai-nn-foundations-embeddings" }],
    laneUpdates: [
      { id: "ai", nextUp: { topicId: "ai-nn-foundations-embeddings", plan: "One-hot → dense (test)." } },
    ],
  },
  profile: { workingNotes: { add: ["test: end-to-end patch worked"] } },
};

test("checkPatch rejects unknown ids and bad states", () => {
  const paths = scratchCopy();
  const bad = structuredClone(goodPatch);
  bad.curriculum!.topicUpdates![0].id = "no-such-topic";
  assert.ok(checkPatch(paths, bad).some((e) => e.includes("no-such-topic")));

  const bad2 = structuredClone(goodPatch);
  // @ts-expect-error deliberate bad state
  bad2.curriculum!.topicUpdates![0].state = "mastered";
  assert.ok(checkPatch(paths, bad2).length > 0);
});

test("checkPatch validates the profile arm; checkProfilePatch agrees on both sides", () => {
  const paths = scratchCopy();

  const badNeedle = structuredClone(goodPatch);
  badNeedle.profile = { workingNotes: { removeContaining: ["NO-SUCH-NEEDLE-DEFINITELY-NOT-PRESENT"] } };
  const errors = checkPatch(paths, badNeedle);
  assert.ok(
    errors.some((e) => e.startsWith("profile:") && e.includes("no bullet containing")),
    errors.join("; ")
  );
  // checkPatch validates without writing.
  assert.equal(readFileSync(paths.profile, "utf8"), readFileSync(FIXTURE.profile, "utf8"));

  // A needle that DOES match a real bullet passes the pure checker.
  const goodNeedle: ProfilePatch = {
    workingNotes: { removeContaining: ["The learner is a CS education researcher and educator"] },
  };
  assert.deepEqual(checkProfilePatch(paths.profile, goodNeedle), []);
});

test("a rejected patch (bad profile needle) leaves lesson-history.md and curriculum untouched — no partial apply", () => {
  const paths = scratchCopy();
  const historyBefore = readFileSync(paths.history, "utf8");
  const curriculumBefore = readFileSync(paths.curriculum, "utf8");

  const bad = structuredClone(goodPatch);
  bad.profile = { workingNotes: { removeContaining: ["NO-SUCH-NEEDLE-DEFINITELY-NOT-PRESENT"] } };

  assert.throws(() => applySessionPatch(paths, bad));
  assert.equal(readFileSync(paths.history, "utf8"), historyBefore, "history file must be unchanged");
  assert.equal(readFileSync(paths.curriculum, "utf8"), curriculumBefore, "curriculum file must be unchanged");
});

test("end-to-end: apply a session patch, curriculum + history + profile all update", () => {
  const paths = scratchCopy();
  const res = applySessionPatch(paths, goodPatch);
  assert.equal(res.lessonNumber, 4);

  const c = loadCurriculum(paths.curriculum);
  assert.deepEqual(validateCurriculum(c), []);
  const loss = c.lanes[0].units[0].coreTopics.find((t) => t.id === "ai-nn-foundations-loss")!;
  assert.equal(loss.state, "comfortable");
  assert.deepEqual(loss.lastTouched, { date: "2026-07-01", lesson: 4 });
  assert.equal(c.lanes[0].units[0].currentTopic, "ai-nn-foundations-embeddings");
  assert.equal(c.lanes[0].nextUp?.topicId, "ai-nn-foundations-embeddings");

  const hist = readFileSync(paths.history, "utf8");
  assert.ok(hist.includes("## Lesson 4 — 2026-07-01"));
  assert.deepEqual(parseHistory(hist).entries.map((e) => e.number), [4, 3, 2, 1]);

  assert.ok(readFileSync(paths.profile, "utf8").includes("end-to-end patch worked"));
});

test("project arm: checkPatch validates laneId and content", () => {
  const paths = scratchCopy();

  const ok = structuredClone(goodPatch);
  ok.project = { laneId: "ai", content: "# App\n\nSome design." };
  assert.deepEqual(checkPatch(paths, ok), [], "a well-formed project arm passes");

  const badLane = structuredClone(goodPatch);
  badLane.project = { laneId: "no-such-lane", content: "x" };
  assert.ok(checkPatch(paths, badLane).some((e) => e.includes("no-such-lane")));

  const mismatch = structuredClone(goodPatch);
  mismatch.project = { laneId: "sts", content: "x" }; // lesson.laneId is "ai"
  assert.ok(checkPatch(paths, mismatch).some((e) => e.includes("must match lesson.laneId")));

  const empty = structuredClone(goodPatch);
  empty.project = { laneId: "ai", content: "   " };
  assert.ok(checkPatch(paths, empty).some((e) => e.includes("non-empty")));
});

test("project arm: applied whole-file, then injected verbatim into the packet", () => {
  const paths = scratchCopy();
  // No project file yet → packet has no Project section.
  assert.ok(
    !buildSessionPacket(paths, {
      laneId: "ai",
      size: "tight",
      model: "opus",
      historyN: 1,
      spacing: DEFAULT_SPACING,
      today: "2026-07-01",
    }).includes("## Project"),
    "absent project file → no section"
  );

  const doc = "# MyApp\n\n## Problem\n- helps students\n\n## Model\nUse an LLM.";
  const patch = structuredClone(goodPatch);
  patch.project = { laneId: "ai", content: doc };
  applySessionPatch(paths, patch);

  assert.ok(existsSync(join(paths.projectsDir, "ai.md")), "project file written");
  assert.equal(readFileSync(join(paths.projectsDir, "ai.md"), "utf8"), doc, "written whole-file");

  const packet = buildSessionPacket(paths, {
    laneId: "ai",
    size: "tight",
    model: "opus",
    historyN: 1,
    spacing: DEFAULT_SPACING,
    today: "2026-07-01",
  });
  assert.ok(packet.includes("## Project (design artifact"), "packet has the Project section");
  // Verbatim: multi-line markdown structure is preserved (not whitespace-collapsed).
  assert.ok(packet.includes("## Problem\n- helps students"), "project prose injected verbatim");
});

test("session packet builds and contains the essentials", () => {
  const packet = buildSessionPacket(FIXTURE, {
    laneId: "ai",
    size: "standard",
    model: "opus",
    historyN: 2,
    spacing: DEFAULT_SPACING,
    today: "2026-07-16",
  });
  for (const needle of [
    "Session Packet",
    "Loss Functions and Optimization",
    "queued at the last wrap-up",
    "How I learn best",
    "## Lesson 3",
    "Other lanes",
  ]) {
    assert.ok(packet.includes(needle), `packet missing: ${needle}`);
  }
  // Only 2 history entries requested — Lesson 1 must be absent.
  assert.ok(!packet.includes("## Lesson 1"));
});

test("session packet ships the newest history entry in full but condenses older ones", () => {
  const packet = buildSessionPacket(FIXTURE, {
    laneId: "ai",
    size: "standard",
    model: "opus",
    historyN: 2,
    spacing: DEFAULT_SPACING,
    today: "2026-07-16",
  });
  // Newest entry (Lesson 3) is in full — its "What happened" body text is present.
  assert.ok(packet.includes("Default lane mix (no override)"), "newest entry's What happened should be in full");
  // Older included entry (Lesson 2) is condensed — header survives, its
  // "What happened" body text does not.
  assert.ok(packet.includes("## Lesson 2 — 2026-06-15"), "older entry's header should survive condensing");
  assert.ok(
    !packet.includes("Quick tangent into gradient descent intuition"),
    "older entry's What happened should be dropped"
  );
});

test("curated topic assets: normalized, validated, and rendered into the packet", () => {
  // Never edit the real data files — stage the asset on a scratch copy.
  const paths = scratchCopy();
  const c = loadCurriculum(paths.curriculum);
  const unit = c.lanes[0].units[0];
  const t = unit.coreTopics[0];
  assert.deepEqual(t.assets, [], "assets normalized to [] on load");

  t.assets = [
    {
      kind: "image",
      url: "https://upload.wikimedia.org/impression-sunrise.jpg",
      title: "Impression, Sunrise",
      note: "the painting the movement is named after",
    },
    { kind: "link", url: "https://www.gutenberg.org/ebooks/123", title: "Primary text" },
  ];
  assert.deepEqual(validateCurriculum(c), [], "curated assets pass validation");

  const rendered = renderUnitFull(unit);
  assert.ok(rendered.includes("asset [image]: Impression, Sunrise — <https://upload.wikimedia.org/impression-sunrise.jpg> (the painting the movement is named after)"));
  assert.ok(rendered.includes("asset [link]: Primary text — <https://www.gutenberg.org/ebooks/123>"));

  // Round-trips through save/load and shows up in the packet.
  saveCurriculum(paths.curriculum, c);
  const packet = buildSessionPacket(paths, {
    laneId: c.lanes[0].id,
    size: "standard",
    model: "opus",
    historyN: 1,
    spacing: DEFAULT_SPACING,
    today: "2026-07-01",
  });
  assert.ok(packet.includes("asset [image]: Impression, Sunrise"));
});

test("lane-doc export covers every unit and topic and strips the Lane suffix", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const sts = c.lanes.find((l) => l.id === "sts")!;

  // "Lane" suffix stripped for the shareable title.
  assert.equal(buildLaneDoc(sts).title, "Science and Technology Studies (STS)");

  const md = renderLaneMarkdown(sts);
  for (const u of sts.units) {
    assert.ok(md.includes(`## ${u.name}`), `unit heading missing: ${u.name}`);
    for (const t of [...u.coreTopics, ...u.optionalTopics]) {
      assert.ok(md.includes(`**${t.name}**`), `topic missing: ${t.name}`);
    }
    if (u.notes) assert.ok(md.includes(u.notes.replace(/\s+/g, " ").trim()), "unit note not verbatim");
  }
  // No internal topic ids leak (e.g. sts-phil-kuhn).
  assert.ok(!/\bsts-[a-z]+-[a-z]/.test(md), "internal ids leaked into markdown");
});

test("lane-doc drops progress and renders notes, links, and emphasis", () => {
  // A synthetic lane so these detail assertions don't depend on frozen-fixture
  // content: it carries state/lastTouched/prereqs (all must be dropped), an
  // authored note with *italic*/**bold**, and a curated link.
  const lane: Lane = {
    id: "demo",
    name: "Demo Lane",
    weight: 10,
    currentUnit: "u1",
    direction: "A *pointed* direction blurb.",
    nextUp: { topicId: "t1", plan: "SECRET-PLAN" },
    units: [
      {
        id: "u1",
        name: "First Unit",
        state: "in-progress",
        currentTopic: "t1",
        prerequisites: [],
        bridgeTopics: [],
        notes: "Unit note kept **verbatim**.",
        coreTopics: [
          {
            id: "t1",
            name: "Core Topic",
            state: "comfortable",
            lastTouched: { date: "2026-07-04", lesson: 4 },
            prerequisites: ["t0"],
            buildsToward: ["t2"],
            notes: "Reads *Laboratory Life* & <b>all</b> the classics.",
            assets: [
              { kind: "link", url: "https://example.org/x", title: "Ref X", note: "handy *scaffold*" },
            ],
          },
        ],
        optionalTopics: [],
      },
    ],
  };

  const md = renderLaneMarkdown(lane);
  const html = renderLaneHtml(lane);

  // Human content survives, verbatim.
  assert.ok(md.includes("# Demo"), "Lane suffix not stripped");
  assert.ok(md.includes("Reads *Laboratory Life* & <b>all</b> the classics."), "note not verbatim in md");
  assert.ok(md.includes("[Ref X](https://example.org/x) — handy *scaffold*"), "link missing in md");

  // Progress/bookkeeping is gone.
  for (const needle of ["SECRET-PLAN", "in-progress", "comfortable", "lastTouched", "2026-07-04", "buildsToward", "t0"]) {
    assert.ok(!md.includes(needle), `progress field leaked into markdown: ${needle}`);
  }

  // HTML renders inline emphasis and escapes literal markup.
  assert.ok(html.includes("<em>Laboratory Life</em>"), "italic not rendered in html");
  assert.ok(html.includes("<strong>verbatim</strong>"), "bold not rendered in html");
  assert.ok(html.includes("&lt;b&gt;all&lt;/b&gt;"), "literal markup not escaped in html");
});

test("lane-doc --clean drops all authored prose but keeps structure and links", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const sts = c.lanes.find((l) => l.id === "sts")!;
  const md = renderLaneMarkdown(sts, { notes: false });

  // Structure and links survive.
  for (const u of sts.units) {
    assert.ok(md.includes(`## ${u.name}`), `unit heading missing: ${u.name}`);
    for (const t of [...u.coreTopics, ...u.optionalTopics]) {
      assert.ok(md.includes(`**${t.name}**`), `topic missing: ${t.name}`);
      for (const a of t.assets ?? []) {
        assert.ok(md.includes(`(${a.url})`), `link url dropped: ${a.url}`);
      }
    }
  }

  // No authored prose: direction gone, and every unit/topic/link note gone.
  assert.ok(!md.includes(sts.direction.slice(0, 30)), "direction leaked into clean output");
  for (const u of sts.units) {
    if (u.notes) assert.ok(!md.includes(u.notes.slice(0, 30)), "unit note leaked into clean output");
    for (const t of [...u.coreTopics, ...u.optionalTopics]) {
      if (t.notes) assert.ok(!md.includes(t.notes.slice(0, 30)), `topic note leaked: ${t.name}`);
      for (const a of t.assets ?? []) {
        if (a.note) assert.ok(!md.includes(a.note.slice(0, 30)), "link note leaked into clean output");
      }
    }
  }
});

test("validator flags malformed topic assets", () => {
  const c = loadCurriculum(FIXTURE.curriculum);
  const t = c.lanes[0].units[0].coreTopics[0];
  t.assets = [{ kind: "video" as never, url: "", title: "" }];
  const errs = validateCurriculum(c);
  assert.ok(errs.some((e) => e.includes("asset kind 'video'")), errs.join("; "));
  assert.ok(errs.some((e) => e.includes("missing a url")), errs.join("; "));
  assert.ok(errs.some((e) => e.includes("missing a title")), errs.join("; "));
});
