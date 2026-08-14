// Tests for the curriculum viewer's deterministic substrate: the unit-graph
// layering, the summary cache's staleness rule, and the three-source lesson
// index. Everything here is pure or fixture-driven — no server, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layerUnits } from "../core/layout.js";
import {
  emptySummaries,
  fallbackSummary,
  loadUnitSummaries,
  saveUnitSummaries,
  staleUnits,
  unitSourceHash,
} from "../core/unit-summaries.js";
import {
  buildLessonIndex,
  parseHistoryLutLine,
  parseTranscriptHead,
  type LessonIndexPaths,
} from "../server/lesson-index.js";
import type { Curriculum, Lane, Unit } from "../core/types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function unit(id: string, prerequisites: string[] = [], extra: Partial<Unit> = {}): Unit {
  return {
    id,
    name: id,
    state: "not-started",
    currentTopic: null,
    prerequisites,
    bridgeTopics: [],
    notes: "",
    coreTopics: [],
    optionalTopics: [],
    completedAt: null,
    ...extra,
  };
}

function lane(id: string, units: Unit[], direction = "go forth"): Lane {
  return { id, name: id, weight: 10, currentUnit: null, direction, nextUp: null, units };
}

// ---------------------------------------------------------------------------
// layerUnits
// ---------------------------------------------------------------------------

test("layerUnits: a plain chain becomes one unit per row", () => {
  const us = [unit("a"), unit("b", ["a"]), unit("c", ["b"])];
  assert.deepEqual(layerUnits(us), [["a"], ["b"], ["c"]]);
});

test("layerUnits: fan-out and diamond merge (the real STS/design shapes)", () => {
  // a → {b, c, d}; b and c → e; e → f. `d` is a sibling that never merges.
  const us = [
    unit("a"),
    unit("b", ["a"]),
    unit("c", ["a"]),
    unit("d", ["a"]),
    unit("e", ["b", "c"]),
    unit("f", ["e"]),
  ];
  assert.deepEqual(layerUnits(us), [["a"], ["b", "c", "d"], ["e"], ["f"]]);
});

test("layerUnits: longest path wins, so an edge never points sideways", () => {
  // `c` depends on both `a` (row 0) and `b` (row 1) — it must land at row 2,
  // not row 1, or the a→c arrow would run within a row.
  const us = [unit("a"), unit("b", ["a"]), unit("c", ["a", "b"])];
  assert.deepEqual(layerUnits(us), [["a"], ["b"], ["c"]]);
});

test("layerUnits: every prerequisite sits strictly above its dependent", () => {
  const us = [
    unit("framing"),
    unit("users", ["framing"]),
    unit("ethics", ["users"]),
    unit("capabilities", ["users"]),
    unit("io", ["capabilities"]),
    unit("review1", ["ethics", "io"]),
    unit("trust", ["io"]),
    unit("a11y", ["io"]),
    unit("eval", ["trust", "a11y"]),
    unit("capstone", ["eval"]),
  ];
  const rows = layerUnits(us);
  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => r.forEach((id) => rowOf.set(id, i)));
  for (const u of us) {
    for (const p of u.prerequisites) {
      assert.ok(rowOf.get(p)! < rowOf.get(u.id)!, `${p} must sit above ${u.id}`);
    }
  }
  assert.equal(rows.flat().length, us.length, "every unit is placed exactly once");
});

test("layerUnits: preserves curriculum order within a row", () => {
  const us = [unit("a"), unit("z", ["a"]), unit("m", ["a"]), unit("b", ["a"])];
  assert.deepEqual(layerUnits(us)[1], ["z", "m", "b"]);
});

test("layerUnits: ignores prerequisites outside the lane", () => {
  // The validator reports cross-lane edges; layout just draws what it's handed.
  const us = [unit("a", ["somewhere-else"]), unit("b", ["a"])];
  assert.deepEqual(layerUnits(us), [["a"], ["b"]]);
});

test("layerUnits: a cycle terminates instead of hanging", () => {
  // Unreachable through the validator, but a hand-edited file must not hang the
  // server before `npm run validate` is run.
  const us = [unit("a", ["b"]), unit("b", ["a"]), unit("c", ["a"])];
  const rows = layerUnits(us);
  assert.equal(rows.flat().length, 3);
  assert.deepEqual([...rows.flat()].sort(), ["a", "b", "c"]);
});

test("layerUnits: empty lane yields no rows", () => {
  assert.deepEqual(layerUnits([]), []);
});

// ---------------------------------------------------------------------------
// unitSourceHash — what counts as "this unit changed"
// ---------------------------------------------------------------------------

function sample(): { lane: Lane; unit: Unit } {
  const u = unit("u1", ["u0"], {
    name: "Sequence Modeling",
    coreTopics: [
      { id: "t1", name: "RNNs", state: "not-started", lastTouched: null, prerequisites: [], buildsToward: [], notes: "", assets: [] },
      { id: "t2", name: "LSTMs", state: "not-started", lastTouched: null, prerequisites: [], buildsToward: [], notes: "", assets: [] },
    ],
    optionalTopics: [
      { id: "t3", name: "Attention preview", state: "not-started", lastTouched: null, prerequisites: [], buildsToward: [], notes: "", assets: [] },
    ],
  });
  return { lane: lane("ai", [u]), unit: u };
}

/** The volatile fields — every one of these moves after an ordinary lesson. */
test("unitSourceHash: unchanged by progress, notes, and dates", () => {
  const { lane: l, unit: u } = sample();
  const before = unitSourceHash(l, u);

  u.state = "core-complete";
  u.notes = "rewritten at every wrap-up";
  u.currentTopic = "t2";
  u.completedAt = "2026-07-18";
  u.coreTopics[0].state = "comfortable";
  u.coreTopics[0].notes = "a long performance note";
  u.coreTopics[0].lastTouched = { date: "2026-07-09", lesson: 16 };
  u.optionalTopics[0].state = "touched";

  assert.equal(unitSourceHash(l, u), before, "a lesson must not invalidate the summary");
});

test("unitSourceHash: changes when the structure or lane direction changes", () => {
  const base = () => sample();
  const h0 = unitSourceHash(base().lane, base().unit);

  const rename = base();
  rename.unit.name = "Sequence Models";
  assert.notEqual(unitSourceHash(rename.lane, rename.unit), h0, "unit rename");

  const topicRename = base();
  topicRename.unit.coreTopics[0].name = "Recurrent Neural Networks";
  assert.notEqual(unitSourceHash(topicRename.lane, topicRename.unit), h0, "topic rename");

  const reorder = base();
  reorder.unit.coreTopics.reverse();
  assert.notEqual(unitSourceHash(reorder.lane, reorder.unit), h0, "topic reorder");

  const added = base();
  added.unit.coreTopics.push({
    id: "t9", name: "GRUs", state: "not-started", lastTouched: null,
    prerequisites: [], buildsToward: [], notes: "", assets: [],
  });
  assert.notEqual(unitSourceHash(added.lane, added.unit), h0, "topic added");

  const prereq = base();
  prereq.unit.prerequisites = ["u0", "uX"];
  assert.notEqual(unitSourceHash(prereq.lane, prereq.unit), h0, "prerequisite added");

  const direction = base();
  direction.lane.direction = "a completely re-framed lane";
  assert.notEqual(unitSourceHash(direction.lane, direction.unit), h0, "lane direction");
});

test("unitSourceHash: prerequisite ORDER doesn't matter, topic order does", () => {
  const a = sample();
  a.unit.prerequisites = ["x", "y"];
  const b = sample();
  b.unit.prerequisites = ["y", "x"];
  assert.equal(unitSourceHash(a.lane, a.unit), unitSourceHash(b.lane, b.unit));
});

test("staleUnits: reports missing, then changed, then nothing", () => {
  const { lane: l, unit: u } = sample();
  const c: Curriculum = { lanes: [l] };

  let file = emptySummaries();
  assert.deepEqual(
    staleUnits(c, file).map((s) => [s.unit.id, s.reason]),
    [["u1", "missing"]]
  );

  file.units[u.id] = {
    summary: "Two sentences.",
    sourceHash: unitSourceHash(l, u),
    generatedAt: "2026-08-01T00:00:00.000Z",
    model: "opus",
  };
  assert.deepEqual(staleUnits(c, file), [], "a fresh entry is not stale");

  // A lesson happens — still not stale.
  u.coreTopics[0].state = "comfortable";
  assert.deepEqual(staleUnits(c, file), [], "progress must not invalidate");

  // The curriculum is restructured — now it is.
  u.coreTopics[0].name = "Recurrent Networks";
  assert.deepEqual(
    staleUnits(c, file).map((s) => [s.unit.id, s.reason]),
    [["u1", "changed"]]
  );
});

test("unit summaries file: round-trips, sorts keys, and survives corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-sum-"));
  const path = join(dir, "unit-summaries.json");

  assert.deepEqual(loadUnitSummaries(path), emptySummaries(), "missing file → empty");

  const file = emptySummaries();
  for (const id of ["zeta", "alpha"]) {
    file.units[id] = { summary: id, sourceHash: "h", generatedAt: "t", model: "opus" };
  }
  saveUnitSummaries(path, file);
  assert.deepEqual(Object.keys(loadUnitSummaries(path).units), ["alpha", "zeta"], "sorted for clean diffs");

  writeFileSync(path, "{ not json", "utf8");
  assert.deepEqual(loadUnitSummaries(path), emptySummaries(), "corrupt file → empty, not a crash");

  writeFileSync(path, JSON.stringify({ version: 99, units: { a: {} } }), "utf8");
  assert.deepEqual(loadUnitSummaries(path), emptySummaries(), "a version bump forces regeneration");
});

test("fallbackSummary: core topic names, or empty for a bare unit", () => {
  const { unit: u } = sample();
  assert.equal(fallbackSummary(u), "RNNs · LSTMs");
  assert.equal(fallbackSummary(unit("bare")), "");
});

// ---------------------------------------------------------------------------
// Lesson index — the three-source merge
// ---------------------------------------------------------------------------

test("parseTranscriptHead: reads structured ids, tolerates a missing Topics line", () => {
  const head = parseTranscriptHead(
    [
      "# Lesson 18 — 2026-07-10",
      "",
      "- **Lane / Unit:** art / art-impressionism",
      "- **Topics:** art-imp-reading, ai-nn-foundations-activation",
      "- **Size / model:** standard / opus",
    ].join("\n")
  );
  assert.deepEqual(head, {
    lessonNumber: 18,
    date: "2026-07-10",
    laneId: "art",
    unitId: "art-impressionism",
    topicsLine: "art-imp-reading, ai-nn-foundations-activation",
  });

  assert.equal(
    parseTranscriptHead("# Lesson 4 — 2026-07-04\n\n- **Lane / Unit:** sts / sts-phil\n")?.topicsLine,
    ""
  );
  assert.equal(parseTranscriptHead("# Not a transcript\n"), null);
});

test("parseHistoryLutLine: splits on the unit, keeping slashes in the topic text", () => {
  assert.deepEqual(parseHistoryLutLine("AI Lane / Neural Network Foundations Refresher / Backprop"), {
    unitName: "Neural Network Foundations Refresher",
    topics: "Backprop",
  });
  // The topic half legitimately contains " / ".
  assert.deepEqual(parseHistoryLutLine("STS / Philosophy and Sociology of Science / Kuhn / Popper"), {
    unitName: "Philosophy and Sociology of Science",
    topics: "Kuhn / Popper",
  });
  assert.equal(parseHistoryLutLine("only one part"), null);
});

/** A data root with all three record types, mirroring the real repo's history. */
function indexFixture(opts: { duplicateUnitName?: boolean } = {}): LessonIndexPaths {
  const dir = mkdtempSync(join(tmpdir(), "tutor-index-"));
  const transcriptsDir = join(dir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });

  const curriculum = join(dir, "curriculum.yaml");
  writeFileSync(
    curriculum,
    [
      "lanes:",
      "  - id: ai",
      "    name: AI Lane",
      "    weight: 50",
      "    currentUnit: u-foundations",
      "    direction: onward",
      "    units:",
      "      - id: u-foundations",
      "        name: Foundations",
      "        state: core-complete",
      "        coreTopics:",
      "          - id: t-activation",
      "            name: Activation Functions",
      "            state: comfortable",
      `      - id: u-second`,
      `        name: ${opts.duplicateUnitName ? "Foundations" : "Second Unit"}`,
      "        state: not-started",
      "        prerequisites: [u-foundations]",
      "",
    ].join("\n"),
    "utf8"
  );

  // History carries every lesson; only 1 and 2 exist nowhere else. Note the
  // deliberate lane-name inconsistency ("AI Lane" vs "AI") the real file has.
  writeFileSync(
    join(dir, "lesson-history.md"),
    [
      "# Lesson History",
      "",
      "## Lesson 5 — 2026-07-05",
      "**Lane / Unit / Topic:** AI Lane / Foundations / Activation Functions",
      "",
      "## Lesson 3 — 2026-07-03",
      "**Lane / Unit / Topic:** AI Lane / Foundations / From the transcript",
      "",
      "## Lesson 2 — 2026-06-29",
      "**Lane / Unit / Topic:** AI / Foundations / History only, no transcript",
      "",
      "## Lesson 1 — 2026-06-26",
      "**Lane / Unit / Topic:** AI Lane / Nonexistent Unit / Unresolvable",
      "",
    ].join("\n"),
    "utf8"
  );

  // Lesson 3 has a transcript but no ledger line; lesson 5 has both.
  writeFileSync(
    join(transcriptsDir, "lesson-003.md"),
    "# Lesson 3 — 2026-07-03\n\n- **Lane / Unit:** ai / u-foundations\n- **Topics:** freeform prose from the header\n",
    "utf8"
  );
  writeFileSync(
    join(transcriptsDir, "lesson-005.md"),
    "# Lesson 5 — 2026-07-05\n\n- **Lane / Unit:** ai / u-foundations\n- **Topics:** Activation Functions\n",
    "utf8"
  );
  // Lesson 7: in the ledger with NO topic ids, and a long freeform header line
  // — the case that would otherwise render a blank label.
  writeFileSync(
    join(transcriptsDir, "lesson-007.md"),
    `# Lesson 7 — 2026-07-07\n\n- **Lane / Unit:** ai / u-foundations\n- **Topics:** ${"x".repeat(300)}\n`,
    "utf8"
  );

  const usageLedger = join(transcriptsDir, "usage.jsonl");
  writeFileSync(
    usageLedger,
    [
      JSON.stringify({ lessonNumber: 5, date: "2026-07-05", laneId: "ai", unitId: "u-foundations", topicIds: ["t-activation"] }),
      JSON.stringify({ lessonNumber: 7, date: "2026-07-07", laneId: "ai", unitId: "u-foundations", topicIds: [] }),
      "{ corrupt line",
      "",
    ].join("\n"),
    "utf8"
  );

  return { curriculum, history: join(dir, "lesson-history.md"), transcriptsDir, usageLedger };
}

test("lesson index: merges ledger, transcript headers, and history", () => {
  const ix = buildLessonIndex(indexFixture());
  assert.deepEqual(
    ix.map((e) => [e.lessonNumber, e.source, e.hasTranscript]),
    [
      [2, "history", false], // history only — predates the archive
      [3, "transcript", true], // transcript only — predates the ledger
      [5, "ledger", true], // both; the ledger wins
      [7, "ledger", true],
    ]
  );
  // Lesson 1 named a unit that doesn't exist — skipped, never guessed at.
  assert.ok(!ix.some((e) => e.lessonNumber === 1));
});

test("lesson index: no phantom entries for numbering gaps", () => {
  // The real data has no lesson 6; the fixture has no 4 or 6.
  const numbers = buildLessonIndex(indexFixture()).map((e) => e.lessonNumber);
  assert.ok(!numbers.includes(4) && !numbers.includes(6));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "ascending");
});

test("lesson index: an ambiguous unit name is skipped, not mis-attributed", () => {
  // Two units share a name, so the history-only lesson 2 can't be placed.
  const ix = buildLessonIndex(indexFixture({ duplicateUnitName: true }));
  assert.ok(!ix.some((e) => e.source === "history"), "no history rows resolve");
  assert.ok(ix.some((e) => e.lessonNumber === 5), "structured sources still work");
});

test("lesson index: topic labels resolve ids, fall back to freeform, and truncate", () => {
  const ix = buildLessonIndex(indexFixture());
  const byN = new Map(ix.map((e) => [e.lessonNumber, e]));

  // Structured ids → real topic names.
  assert.equal(byN.get(5)!.topicsLabel, "Activation Functions");
  // History-only → the prose from the history line.
  assert.equal(byN.get(2)!.topicsLabel, "History only, no transcript");
  // Transcript-only → the prose from the transcript header.
  assert.equal(byN.get(3)!.topicsLabel, "freeform prose from the header");

  // In the ledger but with no topic ids: recovered from the transcript header
  // (the ledger drops topicsFreeform) and truncated for display.
  const l7 = byN.get(7)!;
  assert.ok(l7.topicsLabel.length > 0, "must not be blank");
  assert.equal(l7.topicsLabel.length, 120);
  assert.ok(l7.topicsLabel.endsWith("…"));
  assert.equal(l7.topicsFull.length, 300, "full text kept for the tooltip");
});

test("lesson index: an empty data root yields an empty index, not a throw", () => {
  const fixture = indexFixture();
  const dir = mkdtempSync(join(tmpdir(), "tutor-index-empty-"));
  writeFileSync(join(dir, "lesson-history.md"), "# Lesson History\n", "utf8");
  const ix = buildLessonIndex({
    curriculum: fixture.curriculum,
    history: join(dir, "lesson-history.md"),
    transcriptsDir: join(dir, "does-not-exist"),
    usageLedger: join(dir, "missing.jsonl"),
  });
  assert.deepEqual(ix, []);
});
