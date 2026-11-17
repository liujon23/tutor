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
  STATIC_PROMPT,
  lastVia,
  turnTag,
  withTurnTag,
} from "../server/prompt.js";
import { StreamIds, endAlreadyPending, isFailedRequest, lastUnansweredUser, unexpectedAtInit } from "../server/runner.js";
import { appendUsageFollowUp, countLearnerTurns, summarizeUsage, usageFromResult } from "../server/usage.js";
import { readLedger } from "../server/usage-report.js";
import { analyzeDrive, dist, formatDriveReport, parseDiag } from "../server/drive-report.js";
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
import { CLEANUP_SYSTEM, acceptCleanup, cleanTranscript, cleanupPrompt, replyText, tidyCleanup, withHeard } from "../server/cleanup.js";
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
  // The static part only: the full prompt appends a session packet built from
  // the data root, which a fresh checkout (CI) doesn't have.
  const systemPrompt = STATIC_PROMPT;
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
  assert.match(chatty.rejected ?? "", /^Great question!/, "what the model wrote instead is kept for the log");
  assert.equal(ok.rejected, undefined);
});

test("a failed cleanup request is an error, never the learner's words", () => {
  // 2026-11-08: the login had expired and the "reply" was the error text. Its
  // eleven words pass the word-count check for any answer of 7 to 15 words.
  const failed = {
    type: "assistant",
    error: "authentication_failed",
    message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
  };
  assert.equal(acceptCleanup("I think it is because the gradient vanishes over many steps", failed.message.content[0].text), true, "the old guard alone lets it through");
  assert.throws(() => replyText(failed), /authentication_failed/);
  assert.equal(replyText({ type: "assistant", message: { content: [{ type: "text", text: "The attention heads." }] } }), "The attention heads.");
  assert.equal(replyText({ type: "system" }), null);
  assert.equal(replyText({ type: "assistant", message: { content: [{ type: "tool_use" }] } }), "");
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

// --- The session's tool list ---------------------------------------------------

test("a lesson's init is pinned to the web tools, commit_session and the tutor server", () => {
  const pinned = unexpectedAtInit(
    ["WebFetch", "WebSearch", "mcp__tutor__commit_session"],
    [{ name: "tutor", status: "connected" }]
  );
  assert.deepEqual(pinned, { tools: [], servers: [] });
  // What Lessons 41–44 logged on a runner's second call: an account connector had joined.
  const leaked = unexpectedAtInit(
    ["WebFetch", "WebSearch", "mcp__claude_ai_Claude_Docs__create", "mcp__tutor__commit_session"],
    [
      { name: "claude.ai Claude Docs", status: "connected" },
      { name: "claude.ai Gmail", status: "needs-auth" },
      { name: "tutor", status: "connected" },
    ]
  );
  assert.deepEqual(leaked.tools, ["mcp__claude_ai_Claude_Docs__create"]);
  assert.deepEqual(leaked.servers, ["claude.ai Claude Docs=connected", "claude.ai Gmail=needs-auth"]);
  assert.deepEqual(unexpectedAtInit(undefined, undefined), { tools: [], servers: [] });
});

// --- The commit turn in the usage ledger --------------------------------------------

test("a turn that finishes after the commit is folded into its lesson's ledger entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "tutor-ledger-"));
  const ledger = join(dir, "usage.jsonl");
  const turn = (costUsd: number, tools: string[] = []) =>
    usageFromResult({ usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000 }, duration_ms: 5000 }, { model: "claude-opus-4-8", tools, hadImage: false, via: "spoken" }, costUsd);
  const line = (lessonNumber: number, turns: ReturnType<typeof turn>[]) =>
    JSON.stringify({ lessonNumber, date: "2026-11-12", laneId: "ai", unitId: "u", topicIds: ["t"], size: "standard", committedAt: "2026-11-12T00:00:00Z", costModel: "delta", usage: summarizeUsage(turns, 60_000), turns }) + "\n";
  writeFileSync(ledger, line(49, [turn(1)]) + line(50, [turn(0.25), turn(0.5)]), "utf8");

  appendUsageFollowUp(50, turn(0.41, ["mcp__tutor__commit_session"]), ledger);

  const entries = readLedger(ledger);
  assert.equal(entries.length, 2, "the follow-up is not a lesson of its own");
  const l50 = entries.find((e) => e.lessonNumber === 50)!;
  assert.equal(l50.turns.length, 3);
  assert.equal(l50.usage.turns, 3);
  assert.ok(Math.abs(l50.usage.costUsd - 1.16) < 1e-9);
  assert.equal(l50.usage.wallClockMs, 60_000, "the lesson's wall clock is kept");
  assert.equal(entries.find((e) => e.lessonNumber === 49)!.usage.turns, 1, "other lessons untouched");

  // A follow-up for a lesson the ledger doesn't hold is dropped, not invented.
  appendUsageFollowUp(77, turn(9), ledger);
  assert.equal(readLedger(ledger).length, 2);
});

// --- drive-report --------------------------------------------------------------

test("drive-report reads a log: duplicates dropped, waits split, cache and stream counted", () => {
  const sv = (at: string, kind: string, detail: unknown, level = "info") => JSON.stringify({ src: "server", at, kind, level, detail });
  let seq = 0;
  const cl = (at: string, kind: string, detail: unknown, level = "info", batch = "b1") =>
    JSON.stringify({ src: "client", batch, build: "x", seq: ++seq, t: 0, at, kind, level, state: "", detail });
  const tokens = (cacheRead: number, cacheCreation: number) => ({ input: 2, output: 500, cacheRead, cacheCreation });
  const T = (s: number) => new Date(Date.UTC(2026, 10, 12, 18, 0, s)).toISOString();
  const submit = cl(T(100), "ep-submit", { reason: "silence", silenceMs: 4000, heardMs: 20_000, midSentence: false });
  const text = [
    // Turn 0: the kickoff writes the prompt.
    sv(T(0), "sdk-init", { tools: ["WebFetch", "WebSearch", "mcp__tutor__commit_session"], mcpServers: [{ name: "tutor", status: "connected" }] }),
    sv(T(10), "result", { msSinceSend: 9000, isError: false, via: "spoken", tools: [], tokens: tokens(1600, 25_000), costUsd: 0.26 }),
    // The learner answers; the stream is down for the reply.
    submit,
    submit, // the same record again: a batch re-sent after a lost ack
    cl(T(102), "send-ok", {}),
    sv(T(102), "send", { via: "spoken" }),
    sv(T(102), "sdk-init", { tools: ["WebFetch", "WebSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__tutor__commit_session"], mcpServers: [{ name: "claude.ai Claude Docs", status: "connected" }, { name: "tutor", status: "connected" }] }),
    sv(T(117), "first-delta", { msSinceSend: 15_000 }),
    cl(T(119), "speak", { gen: 3, kind: "tutor" }),
    cl(T(120), "tts-start", { gen: 3 }),
    sv(T(125), "dispatch", { type: "assistant", listeners: 0 }, "anomaly"),
    sv(T(125), "result", { msSinceSend: 23_000, isError: false, via: "spoken", tools: [], tokens: tokens(0, 30_000), costUsd: 0.4 }),
    sv(T(125), "dispatch", { type: "turn_done", listeners: 1 }),
    cl(T(126), "fill-gap", { id: "m1" }),
    cl(T(127), "rec-watchdog", { rec: "running", quietMs: 30_000, silent: true }, "anomaly"),
    cl(T(128), "listen-while-speaking", {}, "invariant"),
    "{ not json",
    "",
  ].join("\n");

  const lines = parseDiag(text);
  assert.equal(lines.filter((l) => l.kind === "ep-submit").length, 1, "re-sent client records are counted once");
  const a = analyzeDrive([{ id: SID, lines }]);
  assert.equal(a.records, lines.length);
  assert.deepEqual(a.invariants, { "listen-while-speaking": 1 });
  assert.equal(a.anomalies["client:rec-watchdog"], 1);
  assert.equal(a.anomalies["server:dispatch"], undefined, "lost dispatches are the stream's table, not an anomaly row");
  assert.deepEqual([a.turns.spoken, a.turns.typed], [2, 0]);
  assert.equal(a.wait.silenceMs.p50, 4000);
  assert.equal(a.wait.cleanupAndSendMs.p50, 2000);
  assert.equal(a.wait.firstDeltaMs.p50, 15_000);
  assert.equal(a.wait.deltaToSpeechMs.p50, 3000);
  assert.equal(a.wait.submitToSpeechMs.p50, 20_000);
  assert.equal(a.cache.misses, 1, "the first turn writing the prompt is not a miss; the second re-writing it is");
  assert.equal(a.cache.shortGap.length, 1);
  assert.ok(a.cache.shortGap[0].gapMin < 2);
  assert.deepEqual([a.cache.unpinnedInits, a.cache.inits], [1, 2]);
  assert.deepEqual([a.stream.dispatched, a.stream.lostTotal, a.stream.lost.assistant, a.stream.filled], [2, 1, 1, 1]);
  assert.deepEqual([a.recognizer.watchdog, a.recognizer.watchdogSilent], [1, 1]);

  const report = formatDriveReport(a);
  assert.match(report, /Broken rules: 1/);
  assert.match(report, /within an hour of the last turn: 1/);
  assert.match(report, /1 of 2 inits listed a tool or server a lesson shouldn't have/);
  assert.match(formatDriveReport(analyzeDrive([])), /No drive-mode diagnostics/);
  assert.deepEqual(dist([]), { n: 0, p50: null, p90: null, max: null });
  assert.deepEqual(dist([3, 1, 2]), { n: 3, p50: 2, p90: 3, max: 3 });
});
