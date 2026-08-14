// Tests for the app server's deterministic pieces — status building and
// lesson-prompt construction. The AI path itself is exercised by
// `npm run echo-test` on a machine with credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../server/report.js";
import { buildStatus, computeAttention } from "../server/status.js";
import { defaultModel, readBuildId } from "../server/params.js";
import { buildLessonSystemPrompt, kickoffMessage } from "../server/prompt.js";
import { renderTranscript, rewriteArchivedImages } from "../server/transcript.js";
import { assetHash, extForContentType, inboundAssetFile, isBlockedHost } from "../server/assets.js";
import { buildUserContent } from "../server/runner.js";
import {
  costDelta,
  summarizeUsage,
  usageFromResult,
  totalTokens,
  usageHeadline,
  type ResultUsageLike,
} from "../server/usage.js";
import {
  analyzeUsage,
  featureStats,
  formatReport,
  parseLedger,
  type LedgerEntry,
} from "../server/usage-report.js";
import {
  MAX_NOTE_LENGTH,
  buildFeedbackLedgerLines,
  checkFeedbackCoverage,
  composeFeedbackHandoff,
  messageSnippet,
  validateFeedbackInput,
} from "../server/feedback.js";
import { appendTranscript, deleteSession } from "../server/store.js";
import { createCommitSessionTool } from "../server/tutor-tool.js";
import type { FeedbackLogEntry, StoredSession, UsageRecord } from "../server/types.js";
import type { SessionPatch } from "../core/types.js";
import { DEFAULT_SPACING } from "../core/spacing.js";

function fakeSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    createdAt: "2026-07-03T08:00:00.000Z",
    lastActivityAt: "2026-07-03T08:30:00.000Z",
    status: "active",
    params: { size: "tight", model: "opus", historyN: 3, spacing: DEFAULT_SPACING },
    title: "Loss Functions",
    systemPrompt: "(sys)",
    sdkSessionId: null,
    transcript: [],
    commit: null,
    ...over,
  };
}

test("buildStatus surfaces lanes, recommendations, topics, and open items", () => {
  const s = buildStatus(DEFAULT_SPACING);
  // Reads the live curriculum, so assert a lower bound, not an exact count
  // (lanes get added — e.g. the design lane).
  assert.ok(s.lanes.length >= 3, "surfaces the lanes");
  const ai = s.lanes.find((l) => l.id === "ai");
  assert.ok(ai, "ai lane present");
  // A well-formed recommendation resolves to either a concrete topic or, at a
  // unit seam (nextUp is a unitId whose topics aren't created yet), a unit.
  assert.ok(
    ai!.recommendation.topicId || ai!.recommendation.unitId,
    "ai lane has a queued/derived target (topic or unit)"
  );
  assert.ok(s.topics.length > 50, "override picker has the full topic list");
  // Live-profile OPEN items come and go as real lessons settle them — assert
  // shape only, not any specific item (same reason the lane count is a bound).
  assert.ok(Array.isArray(s.openSettledItems));
  assert.ok(s.openSettledItems.every((i) => typeof i === "string"));
  // Lane-paired recall: a per-lane map, and every entry belongs to its key lane.
  assert.equal(typeof s.recallCandidatesByLane, "object");
  for (const [laneId, cands] of Object.entries(s.recallCandidatesByLane)) {
    assert.ok(cands.length > 0, "empty lanes are omitted from the map");
    assert.ok(cands.every((r) => r.laneId === laneId), `candidates in ${laneId} match their lane`);
  }
  assert.match(s.today, /^\d{4}-\d{2}-\d{2}$/);
});

test("defaultModel: sonnet for tight without an explicit model, opus for standard/deep", () => {
  assert.equal(defaultModel("tight"), "sonnet");
  assert.equal(defaultModel("standard"), "opus");
  assert.equal(defaultModel("deep"), "opus");
});

test("defaultModel: an explicit model always wins", () => {
  assert.equal(defaultModel("tight", "opus"), "opus");
  assert.equal(defaultModel("tight", "sonnet"), "sonnet");
  assert.equal(defaultModel("standard", "sonnet"), "sonnet");
  assert.equal(defaultModel("deep", "sonnet"), "sonnet");
});

test("readBuildId reads and trims the build-id file, null when it's missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-buildid-"));
  try {
    assert.equal(readBuildId(dir), null, "no file yet -> null");
    writeFileSync(join(dir, "build-id.txt"), "abc123\n");
    assert.equal(readBuildId(dir), "abc123", "trimmed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lesson prompt embeds the packet and the commit contract", () => {
  const { systemPrompt, title } = buildLessonSystemPrompt({
    laneId: "ai",
    size: "tight",
    model: "opus",
    historyN: 3,
    spacing: DEFAULT_SPACING,
  });
  assert.ok(systemPrompt.includes("SESSION PACKET"), "packet delimiter present");
  assert.ok(systemPrompt.includes("commit_session"), "commit tool documented");
  assert.ok(systemPrompt.includes("proposedConfirmedPatterns"), "gate documented");
  assert.ok(systemPrompt.includes("## Learner profile"), "profile embedded");
  assert.ok(systemPrompt.includes("AI Lane"), "lane slice embedded");
  assert.ok(title.length > 0, "title derived");
});

test("lesson prompt splices the shared teaching contract", () => {
  const { systemPrompt } = buildLessonSystemPrompt({
    laneId: "ai",
    size: "tight",
    model: "opus",
    historyN: 3,
    spacing: DEFAULT_SPACING,
  });
  // Spot-check one phrase per contract section so drift in prompt.ts's splice
  // (or an emptied contract file) fails loudly.
  assert.ok(systemPrompt.includes("rigid scaffolding, fluid teaching"), "core idea");
  assert.ok(systemPrompt.includes("## Recall warm-up"), "recall warm-up section");
  assert.ok(systemPrompt.includes("## Readiness check"), "readiness section");
  assert.ok(systemPrompt.includes("Session-size anchors"), "size anchors");
  assert.ok(systemPrompt.includes("## Reading the primary source first"), "primary-source rule shared with the app");
  assert.ok(systemPrompt.includes("## Synthesis capstone"), "synthesis capstone");
  assert.ok(systemPrompt.includes("Working-notes hygiene"), "consolidation rule");
  // The contract file's human-readers preamble must NOT ship in the prompt.
  assert.ok(!systemPrompt.includes("Edit here once"), "file preamble stripped");
});

test("topic override redirects the packet to the topic's lane", () => {
  const { systemPrompt, title } = buildLessonSystemPrompt({
    topicOverride: "sts-phil-merton",
    size: "standard",
    model: "sonnet",
    historyN: 2,
    spacing: DEFAULT_SPACING,
  });
  assert.ok(systemPrompt.includes("override picker"), "override note present");
  assert.ok(systemPrompt.includes("sts-phil-merton"));
  assert.ok(title.length > 0);
});

test("unknown override topic throws", () => {
  assert.throws(() =>
    buildLessonSystemPrompt({
      topicOverride: "nope-not-real",
      size: "tight",
      model: "opus",
      historyN: 3,
      spacing: DEFAULT_SPACING,
    })
  );
});

test("computeAttention flags unresolved proposals and ended-uncommitted lessons", () => {
  const sessions: StoredSession[] = [
    // committed with unresolved proposals → pending-approval
    fakeSession({
      id: "s1",
      status: "committed",
      lastActivityAt: "2026-07-03T09:00:00.000Z",
      commit: {
        lessonNumber: 5,
        summary: [],
        proposedConfirmedPatterns: ["recall-first retrieval"],
        gitMessage: "git: committed",
        committedAt: "2026-07-03T09:00:00.000Z",
      },
    }),
    // committed but proposals already resolved → not flagged
    fakeSession({
      id: "s2",
      status: "committed",
      commit: {
        lessonNumber: 6,
        summary: [],
        proposedConfirmedPatterns: ["x"],
        gitMessage: "git",
        committedAt: "2026-07-03T08:00:00.000Z",
        patternsResolved: true,
      },
    }),
    // committed with no proposals → not flagged
    fakeSession({
      id: "s3",
      status: "committed",
      commit: {
        lessonNumber: 7,
        summary: [],
        proposedConfirmedPatterns: [],
        gitMessage: "git",
        committedAt: "2026-07-03T08:00:00.000Z",
      },
    }),
    // active, ended, no commit → uncommitted
    fakeSession({ id: "s4", status: "active", ending: true, commit: null }),
    // active, not ended → not flagged
    fakeSession({ id: "s5", status: "active", ending: false }),
  ];
  const att = computeAttention(sessions);
  assert.deepEqual(
    att.map((a) => `${a.id}:${a.reason}`).sort(),
    ["s1:pending-approval", "s4:uncommitted"]
  );
});

// commit_session's durable idempotency guard (the fix for the double-apply
// bug): once a session's `commit` is set, a retry must bail out before
// touching any data file — this exercises the real tool handler (bypassing
// the MCP transport) on that early-exit branch only. The rest of the handler
// writes to the real `data/` directory and creates git commits via the
// hardcoded DATA_PATHS import, so it isn't safely testable this way — see
// tests/core.test.ts for coverage of the underlying apply/check logic.
test("commit_session's ALREADY-COMMITTED guard blocks a retry before touching data or onCommitted", async () => {
  const committed = fakeSession({
    commit: {
      lessonNumber: 5,
      summary: ["curriculum.yaml written"],
      proposedConfirmedPatterns: [],
      gitMessage: "git: committed",
      committedAt: "2026-07-03T09:00:00.000Z",
    },
  });
  let onCommittedCalls = 0;
  const commitTool = createCommitSessionTool({
    session: () => committed,
    onCommitted: () => {
      onCommittedCalls++;
    },
    composeStartedAt: () => Date.now(),
  });

  // Untyped on purpose: the tool handler's argument type is the zod-inferred
  // shape (from `patchSchema`), not core's `SessionPatch` — and the
  // ALREADY-COMMITTED guard returns before the patch is ever inspected, so
  // any well-formed `lesson` block is enough to exercise it.
  const result = await commitTool.handler(
    {
      patch: {
        lesson: {
          date: "2026-07-03",
          laneId: "ai",
          unitId: "ai-nn-foundations",
          topicIds: ["ai-nn-foundations-loss"],
          whatHappened: "x",
          performanceSketch: "y",
          sourcesUsed: "z",
          feedbackCaptured: "skipped",
          askedAbout: "nothing",
        },
      },
    },
    {}
  );

  assert.equal(onCommittedCalls, 0, "a retry must never fire onCommitted (no second write)");
  assert.equal(result.isError, true);
  const block = result.content[0];
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("expected a text content block");
  assert.match(block.text, /ALREADY COMMITTED as Lesson 5/);
  assert.match(block.text, /do not commit again/);
});

test("renderTranscript archives the human-readable conversation", () => {
  const session = fakeSession({
    transcript: [
      { role: "user", text: "kickoff", at: "t", hidden: true },
      { role: "assistant", text: "Softmax turns logits into probabilities.", at: "t" },
      { role: "user", text: "Got it — why subtract the max?", at: "t" },
    ],
  });
  const patch: SessionPatch = {
    lesson: {
      date: "2026-07-03",
      laneId: "ai",
      unitId: "ai-nn-foundations",
      topicIds: ["ai-nn-foundations-loss"],
      whatHappened: "Covered cross-entropy.",
      performanceSketch: "Solid.",
      sourcesUsed: "None.",
      feedbackCaptured: "skipped",
      askedAbout: "nothing new",
    },
  };
  const md = renderTranscript(session, patch, 4);
  assert.ok(md.startsWith("# Lesson 4 — 2026-07-03"));
  assert.ok(md.includes("ai-nn-foundations-loss"));
  assert.ok(md.includes("### Tutor"));
  assert.ok(md.includes("Softmax turns logits"));
  assert.ok(md.includes("### Learner"));
  assert.ok(!md.includes("kickoff"), "hidden server kickoff is excluded");
  // No timings passed → no timing line.
  assert.ok(!md.includes("Commit timing"), "timing line omitted when absent");
});

test("renderTranscript includes a commit-timing block when given one", () => {
  const session = fakeSession({
    transcript: [{ role: "assistant", text: "Done.", at: "t" }],
  });
  const patch: SessionPatch = {
    lesson: {
      date: "2026-07-03",
      laneId: "ai",
      unitId: "ai-nn-foundations",
      topicIds: ["ai-nn-foundations-loss"],
      whatHappened: "x",
      performanceSketch: "y",
      sourcesUsed: "z",
      feedbackCaptured: "skipped",
      askedAbout: "nothing",
    },
  };
  const md = renderTranscript(session, patch, 4, undefined, undefined, {
    composeMs: 42_100,
    validateMs: 3,
    writeMs: 8,
    archiveMs: 5,
  });
  assert.ok(md.includes("- **Commit timing:**"));
  assert.ok(md.includes("compose 42.1s"), "seconds past 1s");
  assert.ok(md.includes("validate 3ms"), "sub-second in ms");
  assert.ok(md.includes("through archive 42.1s"), "subtotal shown");
});

test("kickoff message carries parameters and recall picks", () => {
  const k = kickoffMessage({
    size: "deep",
    model: "opus",
    discuss: true,
    recallRequested: ["ai-nn-foundations-backprop"],
    historyN: 3,
    spacing: DEFAULT_SPACING,
  });
  assert.ok(k.includes("size=deep"));
  assert.ok(k.includes("discuss-selection"));
  assert.ok(k.includes("ai-nn-foundations-backprop"));
});

test("asset proxy helpers: url hashing, extension mapping, host blocking", () => {
  const url = "https://upload.wikimedia.org/impression-sunrise.jpg";
  assert.match(assetHash(url), /^[0-9a-f]{64}$/);
  assert.equal(assetHash(url), assetHash(url), "hash is stable");
  assert.notEqual(assetHash(url), assetHash(url + "?x=1"));

  assert.equal(extForContentType("image/jpeg"), "jpg");
  assert.equal(extForContentType("image/svg+xml"), "svg");
  assert.equal(extForContentType("image/x-weird"), "img");

  for (const h of ["localhost", "a.localhost", "printer.local", "127.0.0.1", "10.1.2.3",
                   "192.168.1.10", "172.16.0.9", "172.31.255.1", "169.254.0.5", "0.0.0.0", "[::1]"]) {
    assert.ok(isBlockedHost(h), `${h} should be blocked`);
  }
  for (const h of ["upload.wikimedia.org", "www.gutenberg.org", "172.15.0.1", "172.32.0.1", "8.8.8.8"]) {
    assert.ok(!isBlockedHost(h), `${h} should be allowed`);
  }
});

test("rewriteArchivedImages swaps mapped urls and leaves the rest alone", () => {
  const map = new Map([
    ["https://example.org/sunrise.jpg", "assets/lesson-007/abc123.jpg"],
  ]);
  const text =
    "Look: ![Impression, Sunrise](https://example.org/sunrise.jpg) and " +
    "![uncached](https://example.org/other.png), plus a [plain link](https://example.org/sunrise.jpg).";
  const out = rewriteArchivedImages(text, map);
  assert.ok(out.includes("[![Impression, Sunrise](assets/lesson-007/abc123.jpg)](https://example.org/sunrise.jpg)"));
  assert.ok(out.includes("![uncached](https://example.org/other.png)"), "unmapped image untouched");
  assert.ok(out.includes("[plain link](https://example.org/sunrise.jpg)"), "non-image link untouched");
  assert.equal(rewriteArchivedImages(text, new Map()), text, "empty map is a no-op");
});

test("renderTranscript points archived images at their copies", () => {
  const session = fakeSession({
    transcript: [
      { role: "assistant", text: "Here it is: ![Sunrise](https://example.org/sunrise.jpg)", at: "t" },
    ],
  });
  const patch: SessionPatch = {
    lesson: {
      date: "2026-07-03",
      laneId: "art",
      unitId: "art-impressionism",
      topicIds: ["art-impressionism-monet"],
      whatHappened: "Monet.",
      performanceSketch: "Good.",
      sourcesUsed: "Wikimedia.",
      feedbackCaptured: "skipped",
      askedAbout: "nothing",
    },
  };
  const map = new Map([["https://example.org/sunrise.jpg", "assets/lesson-009/deadbeef.jpg"]]);
  const md = renderTranscript(session, patch, 9, map);
  assert.ok(md.includes("[![Sunrise](assets/lesson-009/deadbeef.jpg)](https://example.org/sunrise.jpg)"));
});

test("buildUserContent shapes SDK blocks: images first, then text", () => {
  const blocks = buildUserContent("look at this", [
    { media_type: "image/jpeg", data: "aGVsbG8=" },
    { media_type: "image/png", data: "d29ybGQ=" },
  ]);
  assert.deepEqual(blocks, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "d29ybGQ=" } },
    { type: "text", text: "look at this" },
  ]);
  // Photo-only message: no empty text block.
  const only = buildUserContent("", [{ media_type: "image/jpeg", data: "aGVsbG8=" }]);
  assert.equal(only.length, 1);
  // Plain text stays a single text block.
  assert.deepEqual(buildUserContent("hi"), [{ type: "text", text: "hi" }]);
});

test("inbound asset names are strictly validated", () => {
  assert.equal(inboundAssetFile("../../etc/passwd"), null);
  assert.equal(inboundAssetFile("inbound-notauuid.jpg"), null);
  assert.equal(inboundAssetFile("inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.exe"), null);
  // Well-formed but absent → null (existence-checked), never a throw.
  assert.equal(inboundAssetFile("inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg"), null);
});

test("renderTranscript rides inbound photos above the message text", () => {
  const session = fakeSession({
    transcript: [
      {
        role: "user",
        text: "my derivation",
        at: "t",
        images: ["inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg"],
      },
    ],
  });
  const patch: SessionPatch = {
    lesson: {
      date: "2026-07-03",
      laneId: "ai",
      unitId: "ai-nn-foundations",
      topicIds: ["ai-nn-foundations-backprop"],
      whatHappened: "Backprop by hand.",
      performanceSketch: "Solid.",
      sourcesUsed: "None.",
      feedbackCaptured: "skipped",
      askedAbout: "nothing",
    },
  };
  // Archived copy known → relative path used.
  const map = new Map([
    ["inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg", "assets/lesson-011/inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg"],
  ]);
  const md = renderTranscript(session, patch, 11, map);
  assert.ok(md.includes("![photo from Learner](assets/lesson-011/inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg)"));
  assert.ok(md.indexOf("![photo from Learner]") < md.indexOf("my derivation"), "photo rides above the text");
  // No archived copy → falls back to the live asset route.
  const md2 = renderTranscript(session, patch, 11);
  assert.ok(md2.includes("![photo from Learner](/api/assets/local/inbound-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg)"));
});

// --- Usage accounting -------------------------------------------------------

function fakeResult(over: Partial<ResultUsageLike> = {}): ResultUsageLike {
  return {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 10,
    },
    total_cost_usd: 0.12,
    duration_ms: 4000,
    is_error: false,
    ...over,
  };
}

test("usageFromResult maps SDK fields and dedups tools", () => {
  const rec = usageFromResult(
    fakeResult(),
    {
      model: "claude-opus-4-8",
      tools: ["WebSearch", "WebSearch", "WebFetch"],
      hadImage: true,
    },
    0.12
  );
  assert.deepEqual(rec.tokens, { input: 100, output: 50, cacheRead: 2000, cacheCreation: 10 });
  assert.equal(rec.costUsd, 0.12);
  assert.equal(rec.durationMs, 4000);
  assert.equal(rec.model, "claude-opus-4-8");
  assert.deepEqual(rec.tools, ["WebSearch", "WebFetch"], "tool names deduped, order kept");
  assert.equal(rec.hadImage, true);
  assert.equal(totalTokens(rec.tokens), 2160);
});

test("usageFromResult tolerates a missing usage block", () => {
  const rec = usageFromResult({ total_cost_usd: 0 }, { model: "x", tools: [], hadImage: false }, 0);
  assert.deepEqual(rec.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.equal(rec.costUsd, 0);
});

test("usageFromResult records the cost it is given, not msg.total_cost_usd", () => {
  // fakeResult()'s total_cost_usd is 0.12 (the SDK's cumulative figure) — the
  // function must ignore it and use the explicit per-turn cost instead.
  const rec = usageFromResult(fakeResult({ total_cost_usd: 999 }), { model: "x", tools: [], hadImage: false }, 0.07);
  assert.equal(rec.costUsd, 0.07);
});

test("costDelta converts a cumulative running total into a per-turn delta", () => {
  assert.equal(costDelta(0.1, 0.25), 0.15, "increase: delta is the difference");
  assert.equal(costDelta(0, 0.12), 0.12, "starting from zero: delta is the full current value");
  assert.equal(costDelta(0.25, 0.2), 0.2, "decrease mid-stream: treated as a counter reset");
});

test("summarizeUsage sums tokens/cost and attributes features per model", () => {
  const records: UsageRecord[] = [
    usageFromResult(fakeResult(), { model: "opus", tools: ["WebSearch"], hadImage: false }, 0.12),
    usageFromResult(
      fakeResult({ total_cost_usd: 0.03 }),
      {
        model: "sonnet",
        tools: ["WebFetch"],
        hadImage: true,
      },
      0.03
    ),
    usageFromResult(
      fakeResult({ total_cost_usd: 0.05 }),
      {
        model: "opus",
        tools: [],
        hadImage: false,
      },
      0.05
    ),
  ];
  const u = summarizeUsage(records, 90_000);
  assert.equal(u.turns, 3);
  assert.equal(totalTokens(u.tokens), 2160 * 3, "tokens summed across turns");
  assert.ok(Math.abs(u.costUsd - 0.2) < 1e-9, "cost summed");
  assert.equal(u.wallClockMs, 90_000);
  assert.equal(u.features.webSearch, 1);
  assert.equal(u.features.webFetch, 1);
  assert.equal(u.features.photos, 1);
  assert.equal(u.byModel.opus.turns, 2);
  assert.equal(u.byModel.sonnet.turns, 1);
  assert.equal(totalTokens(u.byModel.opus.tokens), 2160 * 2);
});

test("cumulative SDK costs convert to correct per-turn deltas and lesson total", () => {
  // Simulates three `result` messages reporting a running cumulative total.
  const cumulatives = [0.1, 0.25, 0.2]; // last one drops -> a session reset
  let prev = 0;
  const deltas: number[] = [];
  const records: UsageRecord[] = cumulatives.map((cumulative) => {
    const delta = costDelta(prev, cumulative);
    prev = cumulative;
    deltas.push(delta);
    return usageFromResult(fakeResult(), { model: "opus", tools: [], hadImage: false }, delta);
  });
  assert.deepEqual(deltas.map((d) => Math.round(d * 100) / 100), [0.1, 0.15, 0.2]);
  const u = summarizeUsage(records, 1000);
  assert.ok(Math.abs(u.costUsd - 0.45) < 1e-9, `expected 0.45, got ${u.costUsd}`);
});

test("summarizeUsage on an empty lesson is all-zero, not NaN", () => {
  const u = summarizeUsage([], -5); // negative elapsed clamps to 0
  assert.equal(u.turns, 0);
  assert.equal(totalTokens(u.tokens), 0);
  assert.equal(u.costUsd, 0);
  assert.equal(u.wallClockMs, 0);
});

test("usageHeadline renders a compact, grep-friendly line", () => {
  const u = summarizeUsage(
    [usageFromResult(fakeResult(), { model: "opus", tools: [], hadImage: false }, 0.12)],
    65_000
  );
  const line = usageHeadline(u);
  assert.match(line, /2,160 tokens/);
  assert.match(line, /API-equiv/);
  assert.match(line, /1 turns/);
  assert.match(line, /1m 5s/);
});

// --- Usage report / analysis ------------------------------------------------

function ledgerEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  const records: UsageRecord[] = over.turns ?? [
    usageFromResult(fakeResult(), { model: "opus", tools: ["WebSearch"], hadImage: false }, 0.12),
  ];
  const usage = summarizeUsage(records, 15 * 60 * 1000);
  return {
    lessonNumber: 1,
    date: "2026-07-05",
    laneId: "ai",
    unitId: "ai-nn",
    topicIds: ["ai-nn-loss"],
    size: "standard",
    committedAt: "2026-07-05T09:00:00Z",
    usage,
    turns: records,
    ...over,
    ...(over.turns ? { usage: summarizeUsage(over.turns, over.usage?.wallClockMs ?? 15 * 60 * 1000) } : {}),
  };
}

test("parseLedger skips blank and malformed lines", () => {
  const good = JSON.stringify(ledgerEntry());
  const text = `${good}\n\n{ not json\n${good}\n`;
  const entries = parseLedger(text);
  assert.equal(entries.length, 2, "two valid lines survive; blank + garbage dropped");
});

test("analyzeUsage rolls up overall, by-lane, by-size and by-model", () => {
  const entries: LedgerEntry[] = [
    ledgerEntry({ lessonNumber: 1, laneId: "ai", size: "tight" }),
    ledgerEntry({ lessonNumber: 2, laneId: "sts", size: "deep" }),
    ledgerEntry({ lessonNumber: 3, laneId: "ai", size: "deep" }),
  ];
  const a = analyzeUsage(entries);
  assert.equal(a.overall.lessons, 3);
  assert.equal(a.byLane.find((g) => g.key === "ai")!.lessons, 2);
  assert.equal(a.byLane.find((g) => g.key === "sts")!.lessons, 1);
  assert.deepEqual(a.bySize.map((g) => g.key), ["tight", "deep"], "sizes in canonical order");
  assert.equal(a.byModel[0].model, "opus");
  assert.equal(a.byModel[0].lessons, 3);
  assert.deepEqual(a.timeline.map((r) => r.lessonNumber), [1, 2, 3], "timeline sorted by lesson");
});

test("featureStats contrasts turns that used a feature against those that didn't", () => {
  const heavy = usageFromResult(
    fakeResult({ usage: { input_tokens: 5000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    { model: "opus", tools: ["WebSearch"], hadImage: false },
    0.2
  );
  const light = usageFromResult(
    fakeResult({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    { model: "opus", tools: [], hadImage: false },
    0.05
  );
  const stats = featureStats([ledgerEntry({ turns: [heavy, light, light] })]);
  const search = stats.find((s) => s.feature === "web search")!;
  assert.equal(search.turnsWith, 1);
  assert.equal(search.turnsWithout, 2);
  assert.equal(search.avgTokensWith, 5400);
  assert.equal(search.avgTokensWithout, 150);
  assert.ok(search.avgTokensWith > search.avgTokensWithout, "web-search turns are heavier");
});

test("formatReport handles an empty ledger gracefully", () => {
  const report = formatReport(analyzeUsage([]));
  assert.match(report, /No usage recorded yet/);
});

test("formatReport renders sections when data is present", () => {
  const report = formatReport(analyzeUsage([ledgerEntry()]));
  assert.match(report, /USAGE REPORT/);
  assert.match(report, /By lesson/);
  assert.match(report, /By feature/);
  assert.match(report, /rough/, "wall-clock caveat surfaced");
});

// --- Per-message feedback -----------------------------------------------------

function feedbackSession(over: Partial<StoredSession> = {}): StoredSession {
  return fakeSession({
    transcript: [
      { id: "m-kick", role: "user", text: "kickoff", at: "t", hidden: true },
      { id: "m-aaa", role: "assistant", text: "Softmax turns logits into probabilities.", at: "t" },
      { id: "m-bbb", role: "user", text: "Got it.", at: "t" },
      { id: "m-ccc", role: "assistant", text: "Now, cross-entropy: a long derivation follows…", at: "t" },
    ],
    ...over,
  });
}

test("validateFeedbackInput accepts a well-formed rating on a tutor message", () => {
  const s = feedbackSession();
  assert.equal(validateFeedbackInput({ messageId: "m-aaa", level: -2, note: "too fast" }, s), null);
  assert.equal(validateFeedbackInput({ messageId: "m-ccc", level: 2, note: "great hook" }, s), null);
});

test("validateFeedbackInput rejects bad levels, empty notes, and wrong targets", () => {
  const s = feedbackSession();
  assert.match(validateFeedbackInput({ messageId: "m-aaa", level: 0, note: "x" }, s)!, /level/);
  assert.match(validateFeedbackInput({ messageId: "m-aaa", level: 3, note: "x" }, s)!, /level/);
  assert.match(validateFeedbackInput({ messageId: "m-aaa", level: 1, note: "   " }, s)!, /explanation/);
  assert.match(
    validateFeedbackInput({ messageId: "m-aaa", level: 1, note: "x".repeat(MAX_NOTE_LENGTH + 1) }, s)!,
    /too long/
  );
  assert.match(validateFeedbackInput({ messageId: "m-nope", level: 1, note: "x" }, s)!, /no message/);
  assert.match(
    validateFeedbackInput({ messageId: "m-bbb", level: 1, note: "x" }, s)!,
    /only tutor messages/,
    "the learner's own messages are not rateable"
  );
  assert.match(
    validateFeedbackInput({ messageId: "m-kick", level: 1, note: "x" }, s)!,
    /only tutor messages/,
    "hidden server kickoff is not rateable"
  );
});

test("validateFeedbackInput closes after commit or abandon", () => {
  const committed = feedbackSession({
    status: "committed",
    commit: {
      lessonNumber: 9,
      summary: [],
      proposedConfirmedPatterns: [],
      gitMessage: "git",
      committedAt: "t",
    },
  });
  assert.match(validateFeedbackInput({ messageId: "m-aaa", level: 1, note: "x" }, committed)!, /committed/);
  const abandoned = feedbackSession({ status: "abandoned" });
  assert.match(validateFeedbackInput({ messageId: "m-aaa", level: 1, note: "x" }, abandoned)!, /abandoned/);
});

test("composeFeedbackHandoff is empty without feedback, ordered and annotated with it", () => {
  assert.equal(composeFeedbackHandoff(feedbackSession()), "");
  const s = feedbackSession({
    feedback: [
      // Stored out of transcript order on purpose — the hand-off re-orders.
      { messageId: "m-ccc", level: 1, note: "good pacing here", at: "t2" },
      { messageId: "m-aaa", level: -2, note: "too fast", at: "t1", flagged: true },
    ],
  });
  const out = composeFeedbackHandoff(s);
  assert.ok(out.indexOf("m-aaa") < out.indexOf("m-ccc"), "transcript order, not rating order");
  assert.match(out, /too fast/);
  assert.match(out, /already surfaced live/, "fired -2 marked as handled");
  assert.match(out, /Unrated messages carry no signal/, "absence-is-not-a-signal stated");
  assert.match(out, /Softmax turns logits/, "rated message snippet included for context");
});

test("checkFeedbackCoverage enforces exact coverage both ways", () => {
  const s = feedbackSession({
    feedback: [
      { messageId: "m-aaa", level: -1, note: "meh", at: "t" },
      { messageId: "m-ccc", level: 2, note: "yes", at: "t" },
    ],
  });
  const entry = (messageId: string): FeedbackLogEntry => ({
    messageId,
    level: -1,
    context: "c",
    takeaway: "t",
  });
  assert.equal(checkFeedbackCoverage(s, [entry("m-aaa"), entry("m-ccc")]), null);
  assert.match(checkFeedbackCoverage(s, [entry("m-aaa")])!, /missing.*m-ccc/);
  assert.match(checkFeedbackCoverage(s, [entry("m-aaa"), entry("m-ccc"), entry("m-xxx")])!, /never rated.*m-xxx/);
  assert.equal(checkFeedbackCoverage(feedbackSession(), []), null, "no feedback, no entries — fine");
});

test("feedback ledger lines are one self-contained JSON object per rating", () => {
  const meta = {
    lessonNumber: 7,
    date: "2026-07-05",
    laneId: "ai",
    unitId: "ai-nn",
    topicIds: ["ai-nn-loss"],
    committedAt: "2026-07-05T10:00:00Z",
  };
  const lines = buildFeedbackLedgerLines(meta, [
    { messageId: "m-aaa", level: -2, context: "long derivation", takeaway: "build up slower" },
    { messageId: "m-ccc", level: 2, context: "history aside", takeaway: "more of these" },
  ]);
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.lessonNumber, 7);
  assert.equal(first.messageId, "m-aaa");
  assert.equal(first.level, -2);
  assert.equal(first.takeaway, "build up slower");
  const second = JSON.parse(lines[1]);
  assert.equal(second.messageId, "m-ccc");
  assert.equal(second.laneId, "ai", "each line carries the lesson metadata");
});

test("messageSnippet flattens and truncates", () => {
  assert.equal(messageSnippet("short line"), "short line");
  const long = messageSnippet("word ".repeat(100), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
  assert.equal(messageSnippet("a\n\nb\tc"), "a b c");
});

test("appendTranscript assigns stable unique message ids", () => {
  const s = fakeSession();
  try {
    appendTranscript(s, { role: "assistant", text: "one", at: "t" });
    appendTranscript(s, { role: "assistant", text: "two", at: "t" });
    const [a, b] = s.transcript;
    assert.match(a.id!, /^m-[0-9a-f]{8}$/);
    assert.match(b.id!, /^m-[0-9a-f]{8}$/);
    assert.notEqual(a.id, b.id);
    // A pre-assigned id (e.g. reloaded session) is preserved, not re-stamped.
    appendTranscript(s, { id: "m-keepme", role: "user", text: "three", at: "t" });
    assert.equal(s.transcript[2].id, "m-keepme");
  } finally {
    deleteSession(s.id); // appendTranscript persists — don't leave test files behind
  }
});

test("renderTranscript marks fired -2 flags and nothing else", () => {
  const session = feedbackSession({
    feedback: [
      { messageId: "m-aaa", level: -2, note: "too fast, no build-up", at: "t", flagged: true },
      { messageId: "m-ccc", level: 2, note: "loved this", at: "t" }, // no transcript trace
    ],
  });
  const patch: SessionPatch = {
    lesson: {
      date: "2026-07-05",
      laneId: "ai",
      unitId: "ai-nn-foundations",
      topicIds: ["ai-nn-foundations-loss"],
      whatHappened: "Loss functions.",
      performanceSketch: "Solid.",
      sourcesUsed: "None.",
      feedbackCaptured: "per-message",
      askedAbout: "nothing",
    },
  };
  const md = renderTranscript(session, patch, 12);
  assert.match(md, /> \*⏬ Learner flagged this: "too fast, no build-up"\*/);
  assert.ok(md.indexOf("Softmax turns logits") < md.indexOf("⏬ Learner flagged this"), "marker rides under the flagged message");
  assert.ok(!md.includes("loved this"), "non-flag ratings leave no transcript trace");
});

// --- /api/report (Stats screen) ---------------------------------------------
// buildReport() reads the real repo data (ledger + curriculum + feedback log),
// same as buildStatus above — assert shape invariants, not exact figures.

test("buildReport assembles usage, packet trend, lane progress, and feedback trend", () => {
  const r = buildReport();

  // Shape only: on a fresh checkout (empty ledgers, no lessons yet) every
  // aggregate must still come back well-formed with zero counts, not throw.
  assert.ok(r.usage.overall, "usage.overall present");
  assert.ok(r.usage.overall.lessons >= 0, "lesson count is a number");

  // Structural only — the lane count differs across checkouts of this repo.
  assert.ok(r.progress.length >= 1, "at least one lane");
  for (const lane of r.progress) {
    assert.ok(lane.unitsTotal > 0, `${lane.laneId} has units`);
  }

  for (const p of r.packetTrend) {
    assert.ok(p.packetTokens > 0, `lesson ${p.lessonNumber} has a positive packet size`);
  }

  for (const entry of r.feedbackTrend.entries) {
    assert.deepEqual(Object.keys(entry.counts).sort(), ["-1", "-2", "1", "2"], "the four count keys");
  }
  assert.deepEqual(Object.keys(r.feedbackTrend.totals).sort(), ["-1", "-2", "1", "2"]);
});

test("lesson prompt documents the per-message feedback protocol", () => {
  const { systemPrompt } = buildLessonSystemPrompt({
    laneId: "ai",
    size: "tight",
    model: "opus",
    historyN: 3,
    spacing: DEFAULT_SPACING,
  });
  assert.ok(systemPrompt.includes("ABSENCE IS NOT A SIGNAL"), "no-signal-from-silence rule");
  assert.ok(systemPrompt.includes("double thumbs-down"), "only -2 acts live");
  assert.ok(systemPrompt.includes("patch.feedback.entries"), "distillation documented");
  assert.ok(systemPrompt.includes("PREFERENCE GUESSES"), "guesses convention documented");
  assert.ok(systemPrompt.includes("Preference guess:"), "working-notes prefix stated");
});
