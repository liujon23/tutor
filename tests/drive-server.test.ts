// Tests for the server half of drive mode: spoken/typed turn tags, streaming
// message ids, the kick's choice of turn, turn counts in the records, the
// diagnostics sink, atomic session writes and the longer expiry. Pure pieces
// only, run against temp dirs — nothing here touches the real data root or
// starts an SDK session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SPACING } from "../core/spacing.js";
import type { SessionPatch } from "../core/types.js";
import {
  KICK_NUDGE,
  SPOKEN_TAG,
  TYPED_TAG,
  buildLessonSystemPrompt,
  lastVia,
  turnTag,
  withTurnTag,
} from "../server/prompt.js";
import { StreamIds, endAlreadyPending, isFailedRequest, lastUnansweredUser } from "../server/runner.js";
import { countLearnerTurns, usageFromResult } from "../server/usage.js";
import { renderTranscript } from "../server/transcript.js";
import {
  createClientBatchWriter,
  createDiagSink,
  isSessionId,
  parseClientBatch,
} from "../server/diag.js";
import { readSessionFiles, writeJsonAtomic } from "../server/store.js";
import { END_TURN_TEXT, SESSION_EXPIRY_MS, sessionExpiresAt } from "../server/params.js";
import { buildLessonIndex } from "../server/lesson-index.js";
import { CLEANUP_SYSTEM, acceptCleanup, cleanTranscript, cleanupPrompt, tidyCleanup, withHeard } from "../server/cleanup.js";
import type { StoredSession, TranscriptEntry } from "../server/types.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function session(transcript: TranscriptEntry[] = []): StoredSession {
  return {
    id: SID,
    createdAt: "2026-10-01T08:00:00.000Z",
    lastActivityAt: "2026-10-01T08:30:00.000Z",
    status: "active",
    params: { size: "standard", model: "opus", historyN: 3, spacing: DEFAULT_SPACING },
    title: "Attention",
    systemPrompt: "(sys)",
    sdkSessionId: null,
    transcript,
    commit: null,
  };
}

const u = (text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  role: "user",
  text,
  at: "t",
  ...extra,
});
const a = (text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  role: "assistant",
  text,
  at: "t",
  ...extra,
});

// ---------------------------------------------------------------------------
// Turn tags
// ---------------------------------------------------------------------------

test("a spoken turn is always tagged, with the rule in the tag", () => {
  assert.equal(turnTag("spoken", "typed"), SPOKEN_TAG);
  assert.equal(turnTag("spoken", "spoken"), SPOKEN_TAG);
  assert.match(SPOKEN_TAG, /no markdown/);
  assert.match(SPOKEN_TAG, /no URLs read aloud/);
});

test("a typed turn is tagged only right after a spoken one (J's rule)", () => {
  assert.equal(turnTag("typed", "spoken"), TYPED_TAG);
  // A text-only lesson sends exactly what it always did.
  assert.equal(turnTag("typed", "typed"), null);
});

test("lastVia reads the most recent channel-bearing turn", () => {
  assert.equal(lastVia([]), "typed");
  assert.equal(lastVia([u("hi")]), "typed", "untagged history is typed");
  assert.equal(lastVia([u("kickoff", { hidden: true, via: "spoken" }), a("Hello.")]), "spoken");
  // The -2 flag hand-off is hidden and carries no via — it doesn't reset the channel.
  assert.equal(
    lastVia([u("answer", { via: "spoken" }), a("ok"), u("[flag]", { hidden: true })]),
    "spoken"
  );
  assert.equal(lastVia([u("a", { via: "spoken" }), u("b", { via: "typed" })]), "typed");
});

test("withTurnTag prefixes the body, or leaves it alone", () => {
  assert.equal(withTurnTag("the answer", SPOKEN_TAG), `${SPOKEN_TAG}\n\nthe answer`);
  assert.equal(withTurnTag("the answer", null), "the answer");
});

test("the system prompt explains spoken turns and no longer claims math always renders", () => {
  const { systemPrompt } = buildLessonSystemPrompt({
    size: "standard",
    model: "opus",
    historyN: 3,
    spacing: DEFAULT_SPACING,
  });
  assert.match(systemPrompt, /## Spoken turns/);
  assert.match(systemPrompt, /mode holds until the next tag/);
  assert.match(systemPrompt, /Never grade\s+a transcription artifact/);
  assert.match(systemPrompt, /no display equations/);
  assert.doesNotMatch(systemPrompt, /it renders properly here/, "the categorical claim is gone");
  // The word "medium" already means CLI-vs-app here; the spoken rules avoid it.
  const spoken = systemPrompt.slice(systemPrompt.indexOf("## Spoken turns"), systemPrompt.indexOf("## Stopping"));
  assert.doesNotMatch(spoken, /medium/i);
});

// ---------------------------------------------------------------------------
// Streaming message ids
// ---------------------------------------------------------------------------

function counterMint() {
  let n = 0;
  return () => `m-${++n}`;
}

test("a streaming message's deltas and its finished entry share one id", () => {
  const ids = new StreamIds(counterMint());
  assert.equal(ids.current, null);
  const id = ids.start("msg_api_1");
  assert.equal(ids.current, id, "deltas now carry it");
  assert.deepEqual(ids.claim("msg_api_1"), { id, reused: false, unknown: false });
  assert.equal(ids.current, null);
});

test("consecutive messages in a turn get distinct ids", () => {
  const ids = new StreamIds(counterMint());
  const first = ids.start("api_1");
  ids.claim("api_1");
  const second = ids.start("api_2");
  assert.notEqual(first, second);
  assert.equal(ids.claim("api_2").id, second);
});

test("a second text message for one API id, or an unknown one, gets a fresh id and says so", () => {
  const ids = new StreamIds(counterMint());
  const id = ids.start("api_1");
  ids.claim("api_1");
  const again = ids.claim("api_1");
  assert.notEqual(again.id, id);
  assert.equal(again.reused, true);
  const stray = ids.claim("never_started");
  assert.equal(stray.unknown, true);
  assert.equal(ids.claim(undefined).unknown, true);
});

test("a failed request is not a tutor turn; a reply cut short by max tokens still is", () => {
  // Seen live (2026-10-06): an expired login made every turn come back as a
  // synthetic assistant message reading "Failed to authenticate: …".
  assert.equal(isFailedRequest("authentication_failed"), true);
  assert.equal(isFailedRequest("rate_limit"), true);
  assert.equal(isFailedRequest("unknown"), true);
  assert.equal(isFailedRequest("max_output_tokens"), false);
  assert.equal(isFailedRequest(undefined), false);
});

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

test("a second End before the tutor answers the first is a duplicate; after a reply it is not", () => {
  const t = [u("q1"), a("r1"), u(END_TURN_TEXT, { via: "spoken" })];
  assert.equal(endAlreadyPending(t), true, "double tap: drop the second");
  assert.equal(endAlreadyPending([...t, a("recap — any last questions?")]), false, "a real second End");
  assert.equal(endAlreadyPending([u("q1"), a("r1")]), false);
  assert.equal(endAlreadyPending([]), false);
});

// ---------------------------------------------------------------------------
// Kick
// ---------------------------------------------------------------------------

test("a kick re-sends the last unanswered user turn, and nothing when the tutor had the last word", () => {
  const t = [u("q1", { id: "u1" }), a("r1"), u("q2", { id: "u2", via: "spoken", modelText: "[tag] q2" })];
  assert.equal(lastUnansweredUser(t)?.id, "u2");
  assert.equal(lastUnansweredUser([...t, a("r2")]), null);
  assert.equal(lastUnansweredUser([u("kickoff", { hidden: true, id: "k" })])?.id, "k", "a hung kickoff counts");
  assert.equal(lastUnansweredUser([]), null);
});

test("a kick's nudge keeps the spoken channel, even after an earlier nudge", () => {
  // resumeAfterKick takes the channel from lastVia: a hidden nudge carries no
  // via, so a second kick still finds the learner's spoken turn.
  const t = [
    u("why does that matter", { via: "spoken" }),
    u(KICK_NUDGE, { hidden: true, modelText: `${SPOKEN_TAG}\n\n${KICK_NUDGE}` }),
  ];
  assert.equal(lastVia(t), "spoken");
  assert.equal(lastUnansweredUser(t)?.text, KICK_NUDGE, "the second kick answers the same turn");
  assert.doesNotMatch(KICK_NUDGE, /why does that matter/, "the learner's words are not re-sent");
});

// ---------------------------------------------------------------------------
// Recording that a lesson was spoken
// ---------------------------------------------------------------------------

test("learner turns are counted by channel; hidden turns and the tutor don't count", () => {
  const t = [
    u("kickoff", { hidden: true, via: "spoken" }),
    a("Hello."),
    u("spoken one", { via: "spoken" }),
    u("typed one"),
    u("spoken two", { via: "spoken" }),
    a("Reply.", { via: "spoken" }),
  ];
  assert.deepEqual(countLearnerTurns(t), { spokenTurns: 2, typedTurns: 1 });
});

test("usage records carry the channel of the turn that drove them", () => {
  const r = usageFromResult({}, { model: "opus", tools: [], hadImage: false, via: "spoken" }, 0);
  assert.equal(r.via, "spoken");
  const old = usageFromResult({}, { model: "opus", tools: [], hadImage: false }, 0);
  assert.equal("via" in old, false);
});

const PATCH = {
  lesson: {
    date: "2026-10-01",
    laneId: "ai",
    unitId: "u",
    topicIds: ["t"],
    whatHappened: "Covered attention.",
    performanceSketch: "",
    sourcesUsed: "",
    feedbackCaptured: "",
    askedAbout: "",
  },
} as unknown as SessionPatch;

test("the archived transcript marks spoken turns and counts them in the header", () => {
  const s = session([u("typed q"), a("r1"), u("spoken q", { via: "spoken" }), a("r2", { via: "spoken" })]);
  const md = renderTranscript(s, PATCH, 30, new Map(), undefined, undefined, "J");
  assert.match(md, /- \*\*Spoken:\*\* 1 of 2 J turns spoken \(speech recognition\)/);
  assert.match(md, /### J \(spoken\)\n\nspoken q/);
  assert.match(md, /### J\n\ntyped q/);
});

test("a text-only lesson's transcript is unchanged", () => {
  const md = renderTranscript(session([u("q"), a("r")]), PATCH, 30, new Map(), undefined, undefined, "J");
  assert.doesNotMatch(md, /Spoken/);
  assert.doesNotMatch(md, /\(spoken\)/);
});

test("the lesson index carries ledger turn counts to the viewer", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-drive-index-"));
  const transcriptsDir = join(dir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const curriculum = join(dir, "curriculum.yaml");
  writeFileSync(
    curriculum,
    [
      "lanes:",
      "  - id: ai",
      "    name: AI",
      "    weight: 50",
      "    currentUnit: u1",
      "    direction: onward",
      "    units:",
      "      - id: u1",
      "        name: Unit One",
      "        state: in-progress",
      "        coreTopics:",
      "          - id: t1",
      "            name: Topic One",
      "            state: touched",
      "",
    ].join("\n"),
    "utf8"
  );
  const history = join(dir, "lesson-history.md");
  writeFileSync(history, "# Lesson History\n", "utf8");
  const usageLedger = join(transcriptsDir, "usage.jsonl");
  const base = { date: "2026-10-01", laneId: "ai", unitId: "u1", topicIds: ["t1"], size: "standard", committedAt: "x", usage: {}, turns: [] };
  writeFileSync(
    usageLedger,
    JSON.stringify({ ...base, lessonNumber: 1 }) + "\n" + JSON.stringify({ ...base, lessonNumber: 2, spokenTurns: 9, typedTurns: 3 }) + "\n",
    "utf8"
  );
  const index = buildLessonIndex({ curriculum, history, transcriptsDir, usageLedger });
  const byNum = new Map(index.map((e) => [e.lessonNumber, e]));
  assert.equal(byNum.get(1)?.spokenTurns, undefined, "older lines stay as they were");
  assert.equal(byNum.get(2)?.spokenTurns, 9);
  assert.equal(byNum.get(2)?.typedTurns, 3);
});

// ---------------------------------------------------------------------------
// Diagnostics sink
// ---------------------------------------------------------------------------

test("only session ids become diag filenames", () => {
  assert.equal(isSessionId(SID), true);
  assert.equal(isSessionId("../../etc/passwd"), false);
  assert.equal(isSessionId("_server"), false);
});

test("the diag sink appends JSONL per session and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-diag-"));
  const sink = createDiagSink(dir);
  sink.write(SID, { kind: "one" });
  sink.write(SID, { kind: "two" });
  sink.write(null, { kind: "server-wide" });
  const lines = readFileSync(join(dir, `${SID}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["one", "two"]);
  assert.ok(existsSync(join(dir, "_server.jsonl")));
  // A hostile id is swallowed, not thrown and not written.
  assert.doesNotThrow(() => sink.write("../escape", { kind: "x" }));
  assert.equal(existsSync(join(dir, "..", "escape.jsonl")), false);
});

test("a diag file stops growing at its cap, with one marker line", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-diag-cap-"));
  const sink = createDiagSink(dir, 200);
  for (let i = 0; i < 50; i++) sink.write(SID, { kind: "spam", i });
  const lines = readFileSync(join(dir, `${SID}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[lines.length - 1].kind, "diag-cap-reached");
  assert.equal(lines.filter((l) => l.kind === "diag-cap-reached").length, 1);
});

test("client batches are validated and written once, even if re-sent", () => {
  assert.equal(typeof parseClientBatch(null, SID), "string");
  assert.equal(typeof parseClientBatch({ id: "b", session: "other", records: [] }, SID), "string");
  assert.equal(typeof parseClientBatch({ id: "b", session: SID, records: [{}] }, SID), "string");
  const ok = parseClientBatch(
    { id: "b1", session: SID, build: "x", dropped: 2, records: [{ seq: 1, t: 0, at: "a", kind: "rec-end", level: "info", state: "listening" }] },
    SID
  );
  assert.equal(typeof ok, "object");

  const dir = mkdtempSync(join(tmpdir(), "tutor-diag-client-"));
  const write = createClientBatchWriter(createDiagSink(dir));
  if (typeof ok === "string") throw new Error(ok);
  assert.deepEqual(write(SID, ok), { written: 1, duplicate: false });
  assert.deepEqual(write(SID, ok), { written: 0, duplicate: true }, "a re-sent batch (lost ack) is skipped");
  const lines = readFileSync(join(dir, `${SID}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["diag-dropped", "rec-end"]);
  assert.ok(lines.every((l) => l.src === "client" && l.batch === "b1"));
});

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

test("session writes are atomic and leave no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-atomic-"));
  const file = join(dir, `${SID}.json`);
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
  assert.equal(existsSync(`${file}.tmp`), false);
});

test("one torn session file no longer hides every other lesson", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-sessions-"));
  writeJsonAtomic(join(dir, "good.json"), session());
  writeFileSync(join(dir, "torn.json"), '{"id": "half', "utf8");
  writeFileSync(join(dir, "leftover.json.tmp"), "{", "utf8");
  const all = readSessionFiles(dir);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, SID);
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("an idle lesson expires after seven days, not one", () => {
  assert.equal(SESSION_EXPIRY_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(sessionExpiresAt("2026-10-02T17:00:00.000Z"), "2026-10-09T17:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Spoken-answer cleanup
// ---------------------------------------------------------------------------

test("a repair of about the same length is accepted; an answer or a summary is not", () => {
  const raw = "the tension mechanism lets each token look at the other tokens and wait them by relevance";
  assert.equal(acceptCleanup(raw, "The attention mechanism lets each token look at the other tokens and weight them by relevance."), true);
  // Haiku answering the learner instead of transcribing them.
  assert.equal(
    acceptCleanup("Oh God I don't know gradient descent", "That's okay! BERT is trained with masked language modelling, which predicts hidden words from both sides of the context."),
    false
  );
  // Summarising a long ramble.
  const ramble = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  assert.equal(acceptCleanup(ramble, "The learner thinks embeddings come from co-occurrence."), false);
  // Short answers get slack for a merged or split word.
  assert.equal(acceptCleanup("no go ahead", "No, go ahead."), true);
  assert.equal(acceptCleanup("anything", ""), false);
  assert.equal(acceptCleanup("hi there", "<transcript>hi there</transcript>"), false);
  assert.equal(tidyCleanup('Repaired transcript: "No, go ahead."'), "No, go ahead.");
});

test("cleanup falls back to the raw text on a timeout, an error, or a rejected repair", async () => {
  const raw = "  the tension heads  ";
  const ok = await cleanTranscript(raw, "Transformers lesson.", async () => ({ text: "The attention heads." }));
  assert.deepEqual([ok.text, ok.cleaned], ["The attention heads.", true]);

  const slow = await cleanTranscript(raw, "", (_p, abort) => new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("aborted")))), 20);
  assert.deepEqual([slow.text, slow.cleaned, slow.fallback], ["the tension heads", false, "timeout"]);

  const broken = await cleanTranscript(raw, "", async () => {
    throw new Error("login expired");
  });
  assert.deepEqual([broken.text, broken.fallback], ["the tension heads", "error"]);

  const chatty = await cleanTranscript(raw, "", async () => ({ text: "Great question! Attention heads are parallel attention computations, each with its own projections." }));
  assert.deepEqual([chatty.text, chatty.fallback], ["the tension heads", "rejected"]);
});

test("the cleanup prompt carries the tutor's message and the transcript, and stays bounded", () => {
  const p = cleanupPrompt("the tension heads", "x".repeat(5000) + " What do the attention heads do?");
  assert.match(p, /<transcript>\nthe tension heads\n<\/transcript>/);
  assert.match(p, /What do the attention heads do\?/, "the end of a long message is kept");
  assert.ok(p.length < 2_300);
  assert.match(CLEANUP_SYSTEM, /Never answer/);
});

test("the tutor gets the repaired text with the raw recognition beside it", () => {
  assert.equal(withHeard("The attention heads.", "the tension heads"), 'The attention heads.\n\n[raw speech recognition, before cleanup: "the tension heads"]');
  assert.equal(withHeard("Yes.", undefined), "Yes.");
  assert.equal(withHeard("yes", " yes "), "yes", "nothing to add when cleanup changed nothing");
});
