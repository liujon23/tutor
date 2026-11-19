// Tests for the transcript viewer's substrate: the transcript parser the reader
// and search share, search itself, and the per-lesson details endpoint.
// Fixture-driven; no server, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTranscript, transcriptLinks } from "../web/src/curriculum/transcript-parse.js";
import { docFromMarkdown, plainText, searchDocs, searchTranscripts, snippetAround, termPattern } from "../server/lesson-search.js";
import { buildLessonDetail, parseHistoryFields, type LessonDetailPaths } from "../server/lesson-detail.js";
import { buildLessonIndex } from "../server/lesson-index.js";
import { saveDigests } from "../core/lesson-digests.js";
import { conversationText, missingDigests, parseKeyPoints, readKeyPointsRule } from "../scripts/lesson-digests-prompt.js";

// ---------------------------------------------------------------------------
// A transcript in the shape renderTranscript writes
// ---------------------------------------------------------------------------

const TRANSCRIPT = [
  "# Lesson 9 — 2026-07-09",
  "",
  "- **Lane / Unit:** ai / u-foundations",
  "- **Topics:** t-activation",
  "- **Size / model:** standard / opus",
  "- **Spoken:** 1 of 2 Sam turns spoken (speech recognition)",
  "- **Committed:** 2026-07-09T10:00:00.000Z",
  "",
  "> Built the gatekeeper argument from scratch.",
  "",
  "---",
  "",
  "### Tutor",
  "",
  "Morning. Here is a [primer](https://example.org/primer) to start.",
  "",
  "### A heading inside the tutor's message",
  "",
  "Still the same turn, with ![a chart](assets/lesson-009/chart.png) and",
  "[![archived](assets/lesson-009/pic.jpg)](https://upload.example.org/pic.jpg).",
  "",
  "### Sam (spoken)",
  "",
  "The teacher becomes a gatekeeper, I think. See [my notes](https://notes.example.com).",
  "",
  "### Tutor",
  "",
  "Right — the gatekeeper role. Compare the [primer](https://example.org/primer) and [another](https://other.example.net/x).",
  "",
  "### Sam",
  "",
  "Got it.",
  "",
].join("\n");

test("parser: header fields, summary, and turns", () => {
  const p = parseTranscript(TRANSCRIPT);
  assert.equal(p.lessonNumber, 9);
  assert.equal(p.date, "2026-07-09");
  assert.equal(p.fields["Lane / Unit"], "ai / u-foundations");
  assert.equal(p.fields["Size / model"], "standard / opus");
  assert.equal(p.summary, "Built the gatekeeper argument from scratch.");
  assert.equal(p.learner, "Sam");
  assert.deepEqual(
    p.turns.map((t) => [t.role, t.spoken]),
    [
      ["tutor", false],
      ["learner", true],
      ["tutor", false],
      ["learner", false],
    ]
  );
});

test("parser: a heading inside a tutor message stays in that message", () => {
  const first = parseTranscript(TRANSCRIPT).turns[0];
  assert.match(first.text, /### A heading inside the tutor's message/);
  assert.match(first.text, /Still the same turn/);
});

test("parser: CRLF line endings parse the same", () => {
  const p = parseTranscript(TRANSCRIPT.replace(/\n/g, "\r\n"));
  assert.equal(p.turns.length, 4);
  assert.equal(p.fields["Topics"], "t-activation");
});

test("parser: a file without the header rule still yields its turns", () => {
  const p = parseTranscript("### Tutor\n\nHello.\n\n### Sam\n\nHi.\n");
  assert.equal(p.lessonNumber, null);
  assert.equal(p.turns.length, 2);
});

test("links: the tutor's web links, once each, with the turn that gave them", () => {
  const links = transcriptLinks(parseTranscript(TRANSCRIPT).turns);
  assert.deepEqual(links, [
    { label: "primer", url: "https://example.org/primer", turn: 0 },
    { label: "another", url: "https://other.example.net/x", turn: 2 },
  ]);
  // Not the learner's link, not an image, not an archived image's provenance link.
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("search: plain text drops link targets, images and emphasis", () => {
  assert.equal(
    plainText("**Bold** and [a link](https://x.org) and ![img](a.png) `code`"),
    "Bold and a link and code"
  );
});

test("search: a term matches at the start of a word only", () => {
  const re = termPattern("gate");
  assert.ok(re.test("the gatekeeper"));
  assert.ok(re.test("Gate one"));
  assert.ok(!re.test("delegate"));
});

test("search: every word must be in the same turn; newest lesson first", () => {
  const docs = [
    docFromMarkdown(9, TRANSCRIPT),
    docFromMarkdown(12, "### Tutor\n\nThe gatekeeper role, again.\n\n### Sam\n\nSure.\n"),
  ];
  const r = searchDocs(docs, "gatekeeper role");
  assert.deepEqual(r.terms, ["gatekeeper", "role"]);
  assert.deepEqual(
    r.hits.map((h) => [h.lessonNumber, h.turnsMatched, h.snippets.map((s) => s.turn)]),
    [
      [12, 1, [0]],
      [9, 1, [2]], // turn 1 has "gatekeeper" but not "role"
    ]
  );
  assert.equal(searchDocs(docs, "   ").hits.length, 0);
});

test("search: at most three snippets per lesson, with the full count", () => {
  const md = ["### Tutor", "alpha", "### Sam", "alpha", "### Tutor", "alpha", "### Sam", "alpha"].join("\n\n");
  const [hit] = searchDocs([docFromMarkdown(1, md)], "alpha").hits;
  assert.equal(hit.turnsMatched, 4);
  assert.equal(hit.snippets.length, 3);
});

test("search: snippets are cut around the first match", () => {
  const long = `${"lead ".repeat(40)}needle ${"tail ".repeat(60)}`.trim();
  const s = snippetAround(long, [termPattern("needle")]);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("needle"));
  assert.ok(s.length < 200);
});

// ---------------------------------------------------------------------------
// Lesson details
// ---------------------------------------------------------------------------

function detailFixture(): LessonDetailPaths {
  const dir = mkdtempSync(join(tmpdir(), "tutor-detail-"));
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
      "        state: in-progress",
      "        coreTopics:",
      "          - id: t-activation",
      "            name: Activation Functions",
      "            state: touched",
      "",
    ].join("\n"),
    "utf8"
  );
  const history = join(dir, "lesson-history.md");
  writeFileSync(
    history,
    [
      "# Lesson History",
      "",
      "## Lesson 9 — 2026-07-09",
      "**Lane / Unit / Topic:** AI Lane / Foundations / Activation Functions",
      "**What happened:** Built the gatekeeper argument.",
      "A second line of what happened.",
      "**Performance sketch:** Strong.",
      "**Sources used:** A primer; cost ~$17M, now $13M/yr.",
      "**Feedback captured:** None.",
      "**Asked about:** Agents next.",
      "",
      "## Lesson 3 — 2026-07-03",
      "**Lane / Unit / Topic:** AI Lane / Foundations / Activation Functions",
      "**What happened:** The first one.",
      "",
      "## Lesson 2 — 2026-07-02",
      "**Lane / Unit / Topic:** AI Lane / Foundations / Activation Functions",
      "**What happened:** Before the archive.",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(join(transcriptsDir, "lesson-009.md"), TRANSCRIPT, "utf8");
  // Lesson 3 predates the ledger: its header topics are ids.
  writeFileSync(
    join(transcriptsDir, "lesson-003.md"),
    "# Lesson 3 — 2026-07-03\n\n- **Lane / Unit:** ai / u-foundations\n- **Topics:** t-activation\n\n---\n\n### Tutor\n\nHi.\n",
    "utf8"
  );
  const usageLedger = join(transcriptsDir, "usage.jsonl");
  const turn = (costUsd: number) => ({ costUsd, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } });
  writeFileSync(
    usageLedger,
    JSON.stringify({
      lessonNumber: 9,
      date: "2026-07-09",
      laneId: "ai",
      unitId: "u-foundations",
      topicIds: ["t-activation"],
      usage: { tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }, costUsd: 0.5, turns: 1, wallClockMs: 60000 },
      turns: [turn(0.5)],
    }) + "\n",
    "utf8"
  );
  const feedbackLedger = join(transcriptsDir, "feedback.jsonl");
  writeFileSync(
    feedbackLedger,
    [
      JSON.stringify({ lessonNumber: 9, level: 1, context: "ctx", takeaway: "Keep doing this." }),
      JSON.stringify({ lessonNumber: 3, level: -1, context: "other lesson", takeaway: "no" }),
      "{ corrupt",
    ].join("\n"),
    "utf8"
  );
  const lessonDigests = join(dir, "lesson-digests.json");
  saveDigests(lessonDigests, {
    version: 1,
    lessons: {
      "9": {
        keyPoints: ["The teacher becomes a gatekeeper.", "Second.", "Third."],
        sources: [{ title: "A primer", url: "https://example.org/primer", checked: true }],
        origin: "commit",
      },
    },
  });
  return { curriculum, history, transcriptsDir, usageLedger, feedbackLedger, lessonDigests };
}

test("history fields: labelled lines, with unlabelled lines continuing the field above", () => {
  const f = parseHistoryFields(
    "## Lesson 9 — 2026-07-09\n**What happened:** One.\nTwo.\n**Asked about:** Three."
  );
  assert.equal(f.whatHappened, "One.\nTwo.");
  assert.equal(f.askedAbout, "Three.");
  assert.equal(f.sourcesUsed, "");
});

test("lesson detail: names, history, this lesson's ratings, usage and neighbours", () => {
  const paths = detailFixture();
  const d = buildLessonDetail(9, paths)!;
  assert.equal(d.laneName, "AI Lane");
  assert.equal(d.unitName, "Foundations");
  assert.equal(d.topics, "Activation Functions");
  assert.equal(d.history?.whatHappened, "Built the gatekeeper argument.\nA second line of what happened.");
  assert.equal(d.history?.sourcesUsed, "A primer; cost ~$17M, now $13M/yr.");
  assert.deepEqual(d.ratings, [{ level: 1, context: "ctx", takeaway: "Keep doing this." }]);
  assert.match(d.usage ?? "", /\$0\.50/);
  // Lesson 2 has no transcript, so it isn't anyone's neighbour.
  assert.equal(d.prev, 3);
  assert.equal(d.next, null);
  assert.equal(buildLessonDetail(3, paths)!.prev, null);
  assert.equal(buildLessonDetail(42, paths), null);
});

test("lesson detail: carries the digest when there is one, null otherwise", () => {
  const paths = detailFixture();
  const d = buildLessonDetail(9, paths)!;
  assert.equal(d.digest?.keyPoints[0], "The teacher becomes a gatekeeper.");
  assert.deepEqual(d.digest?.sources, [{ title: "A primer", url: "https://example.org/primer", checked: true }]);
  assert.equal(buildLessonDetail(3, paths)!.digest, null);
});

test("lesson index: a transcript-only lesson's topic ids show as names", () => {
  const three = buildLessonIndex(detailFixture()).find((e) => e.lessonNumber === 3)!;
  assert.equal(three.source, "transcript");
  assert.deepEqual(three.topicIds, ["t-activation"]);
  assert.equal(three.topicsFull, "Activation Functions");
});

test("search over files: reads the transcripts directory", () => {
  const { transcriptsDir } = detailFixture();
  const r = searchTranscripts("gatekeeper", transcriptsDir);
  assert.deepEqual(r.hits.map((h) => h.lessonNumber), [9]);
});

// ---------------------------------------------------------------------------
// Key-points backfill (the pure half; no model)
// ---------------------------------------------------------------------------

test("backfill: only transcript lessons without a digest, ascending", () => {
  const file = { version: 1 as const, lessons: { "9": { keyPoints: ["a", "b", "c"], sources: [], origin: "commit" as const } } };
  assert.deepEqual(missingDigests([12, 9, 4, 12], file), [4, 12]);
});

test("backfill: the rule is read from the teaching contract itself", () => {
  const rule = readKeyPointsRule(join(import.meta.dirname, ".."));
  assert.ok(rule.startsWith("- **keyPoints**"));
  assert.match(rule, /3–6 lines/);
  assert.ok(!rule.includes("**sources**"), "stops before the next bullet");
});

test("backfill: the conversation drops images but keeps every turn", () => {
  const text = conversationText(TRANSCRIPT);
  assert.equal((text.match(/^### (Tutor|Learner)/gm) ?? []).length, 4);
  assert.match(text, /### Learner \(spoken\)/);
  assert.ok(!text.includes("assets/"));
  assert.match(text, /\[primer\]\(https:\/\/example\.org\/primer\)/);
});

test("backfill: the model's lines are read and held to the commit limits", () => {
  const ok = parseKeyPoints("- One.\n- Two.\n\n* Three.\n");
  assert.deepEqual(ok.keyPoints, ["One.", "Two.", "Three."]);
  assert.deepEqual(ok.errors, []);
  assert.ok(parseKeyPoints("Here are the points:\n- Only one.").errors.length > 0);
});
