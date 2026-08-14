// Static "demo mode" replay of a real recorded lesson — no server, no API
// token. Implements the same `Api` surface as the live client (see
// ../api.ts) against web/public/demo/lesson.json instead of fetch/SSE, so
// every screen/module works unmodified against whichever one the build
// picked. Only reachable when built with `--mode demo` (__DEMO__ === true);
// otherwise this whole module is unreferenced and Rollup drops it.
import { transcriptName } from "../api.js";
import type {
  Api,
  CommitResult,
  CurriculumView,
  LessonEvent,
  LessonModel,
  LessonState,
  RatingLevel,
  Report,
  SessionSize,
  Status,
  TranscriptEntry,
  VersionInfo,
} from "../api.js";

// ---------------------------------------------------------------------------
// The recording
// ---------------------------------------------------------------------------

interface RecordedTurn {
  role: "tutor" | "learner";
  text: string;
}

interface Recording {
  title: string;
  params: { size: SessionSize; model: LessonModel; laneName: string };
  note: string;
  turns: RecordedTurn[];
  commit: CommitResult;
}

const DEMO_ID = "demo-lesson";

let recording: Recording | null = null;
let recordingPromise: Promise<Recording> | null = null;

function loadRecording(): Promise<Recording> {
  recordingPromise ??= fetch(`${import.meta.env.BASE_URL}demo/lesson.json`)
    .then((r) => r.json() as Promise<Recording>)
    .then((rec) => (recording = rec));
  return recordingPromise;
}

// ---------------------------------------------------------------------------
// Replay state — one lesson's worth. `generation` guards against a stray
// setTimeout chain from a previous lesson (rare: only reachable by starting
// a second demo lesson while the first's stream was still mid-turn) still
// mutating state after a reset.
// ---------------------------------------------------------------------------

let cursor = 0; // index into recording.turns of the next turn to reveal
let transcript: TranscriptEntry[] = [];
let commit: CommitResult | null = null;
let msgSeq = 0;
let generation = 0;

const nextId = (): string => `demo-${++msgSeq}`;

function reset(): void {
  generation++;
  cursor = 0;
  transcript = [];
  commit = null;
  msgSeq = 0;
}

// The live SSE subscriber; sendMessage/playForward push events through it.
let listener: ((ev: LessonEvent) => void) | null = null;
// composer.ts's hook: called whenever the replay is idle and waiting on the
// next learner line, so the composer can refresh its pre-fill.
let idleCallback: (() => void) | null = null;

/** The next learner line queued up, or null if the script is at a tutor turn
 *  (still streaming) or has ended. Read by composer.ts to pre-fill the box. */
export function nextLearnerLine(): string | null {
  const t = recording?.turns[cursor];
  return t && t.role === "learner" ? t.text : null;
}

/** composer.ts registers a callback here (demo-mode only) to be notified
 *  whenever the replay is ready for the next send. */
export function onDemoIdle(cb: (() => void) | null): void {
  idleCallback = cb;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// Streaming a tutor turn: ~1,000 wpm — 2-4 words every 150-210ms, with longer
// pauses at paragraph breaks. Deliberately slower than the raw event replay
// could go: fast enough to feel alive, slow enough to read along with.
// Mirrors the live server's delta/assistant event pair.
// ---------------------------------------------------------------------------

async function streamTutorTurn(text: string, myGen: number): Promise<void> {
  const id = nextId();
  const paragraphs = text.split(/(\n\n+)/); // keep the blank-line separators as their own pieces
  for (const part of paragraphs) {
    if (myGen !== generation) return;
    if (/^\n\n+$/.test(part)) {
      listener?.({ type: "delta", text: part });
      await sleep(350 + Math.random() * 150);
      continue;
    }
    const tokens = part.split(/(\s+)/); // words interleaved with whitespace runs
    let i = 0;
    while (i < tokens.length) {
      if (myGen !== generation) return;
      const wordsThisChunk = 2 + Math.floor(Math.random() * 3); // 2-4 words
      const slice = tokens.slice(i, i + wordsThisChunk * 2); // *2: each word has a trailing whitespace token
      i += wordsThisChunk * 2;
      const chunk = slice.join("");
      if (!chunk) continue;
      listener?.({ type: "delta", text: chunk });
      await sleep(150 + Math.random() * 60);
    }
  }
  if (myGen !== generation) return;
  listener?.({ type: "assistant", id, text });
  transcript.push({ id, role: "assistant", text, at: new Date().toISOString() });
}

/** Stream every consecutive tutor turn starting at `cursor`, then either
 *  surface the committed wrap-up (script exhausted) or go idle waiting for
 *  the next learner send. */
async function playForward(): Promise<void> {
  const rec = await loadRecording();
  const myGen = generation;
  while (rec.turns[cursor]?.role === "tutor") {
    await streamTutorTurn(rec.turns[cursor].text, myGen);
    if (myGen !== generation) return;
    cursor++;
  }
  listener?.({ type: "turn_done", costUsd: 0, isError: false });
  if (cursor >= rec.turns.length) {
    commit = rec.commit;
    listener?.({ type: "committed", commit: rec.commit });
  } else {
    idleCallback?.();
  }
}

// ---------------------------------------------------------------------------
// The Api surface
// ---------------------------------------------------------------------------

async function status(): Promise<Status> {
  const rec = await loadRecording();
  // The three example lanes, to show the multi-track select screen — but only
  // the art lane carries a recording. The others are marked "demo-locked"
  // (a kind the select screen renders dimmed and non-selectable in demo mode).
  const locked = (id: string, name: string, weight: number) => ({
    id,
    name,
    weight,
    currentUnit: null,
    recommendation: {
      kind: "demo-locked",
      note: "No recorded lesson in this demo — the art-history replay is the sample.",
    },
  });
  return {
    today: new Date().toISOString().slice(0, 10),
    staleDays: 10,
    lanes: [
      {
        id: "art",
        name: rec.params.laneName,
        weight: 20,
        currentUnit: null,
        recommendation: {
          kind: "topic",
          topicName: rec.title,
          reason: "A real recorded lesson, replayed for the demo.",
          plan: "The recorded sample lesson — a real session from the author's course, replayed.",
        },
      },
      locked("ai", "AI Lane", 50),
      locked("sts", "Science and Technology Studies (STS) Lane", 30),
    ],
    recallCandidates: [],
    openSettledItems: [],
    topics: [],
    activeSessions: [],
    attention: [],
  };
}

async function version(): Promise<VersionInfo> {
  return { buildId: null }; // never triggers the "update available" toast
}

async function report(): Promise<Report> {
  // Unreachable in demo mode — the select screen hides the Stats link — but
  // typed out fully so a stray call degrades to an empty report, not a crash.
  const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const zeroGroup = { key: "all", lessons: 0, turns: 0, tokens: zeroTokens, totalTokens: 0, costUsd: 0, wallClockMs: 0 };
  return {
    usage: { overall: zeroGroup, byLane: [], bySize: [], byModel: [], features: [], timeline: [] },
    packetTrend: [],
    progress: [],
    feedbackTrend: { entries: [], totals: { "2": 0, "1": 0, "-1": 0, "-2": 0 } },
  };
}

async function createLesson(): Promise<{ sessionId: string; title: string }> {
  const rec = await loadRecording();
  reset();
  return { sessionId: DEMO_ID, title: rec.title };
}

async function lesson(id: string): Promise<LessonState> {
  const rec = await loadRecording();
  return {
    id,
    status: commit ? "committed" : "active",
    title: rec.title,
    params: { size: rec.params.size, model: rec.params.model },
    transcript: transcript.map((t) => ({ ...t })),
    commit,
    createdAt: new Date().toISOString(),
    note: rec.note,
  };
}

async function sendMessage(_id: string, text: string): Promise<{ ok: boolean }> {
  await loadRecording();
  const mid = nextId();
  transcript.push({ id: mid, role: "user", text, at: new Date().toISOString() });
  listener?.({ type: "user", id: mid, text });
  // The visitor may have edited the pre-filled line — the script still
  // advances on the canned line underneath, which is the whole point of a
  // fixed replay. Only advance past a genuine learner slot (guards against a
  // stray send once the script has already ended).
  if (recording && recording.turns[cursor]?.role === "learner") cursor++;
  void playForward();
  return { ok: true };
}

async function endLesson(): Promise<{ ok: boolean; alreadyCommitted?: boolean }> {
  const rec = await loadRecording();
  if (commit) return { ok: true, alreadyCommitted: true };
  // No real wrap-up turn to run — jump straight to the recording's commit so
  // "End lesson" still does something sensible mid-replay. Bump `generation`
  // first so any in-flight playForward stream stops emitting once its next
  // await resolves, instead of racing past the commit.
  generation++;
  commit = rec.commit;
  listener?.({ type: "turn_done", costUsd: 0, isError: false });
  listener?.({ type: "committed", commit: rec.commit });
  return { ok: true };
}

async function setModel(): Promise<{ ok: boolean }> {
  return { ok: true }; // no-op — the recording's model is fixed
}

async function setFeedback(
  _id: string,
  body: { messageId: string; level: RatingLevel; note: string }
): Promise<{ ok: boolean; flagged: boolean }> {
  return { ok: true, flagged: body.level === -2 }; // accepted locally, never persisted
}

async function clearFeedback(): Promise<{ ok: boolean }> {
  return { ok: true };
}

async function approvePatterns(): Promise<{ ok: boolean; applied: number }> {
  return { ok: true, applied: 0 }; // the recording has none anyway
}

async function abandon(): Promise<{ ok: boolean }> {
  return { ok: true };
}

function events(_id: string, onEvent: (ev: LessonEvent) => void): () => void {
  listener = onEvent;
  void playForward();
  return () => {
    if (listener === onEvent) listener = null;
  };
}

// --- Curriculum viewer -------------------------------------------------------
// Unlike the rest of the demo these read committed static files rather than the
// recording: web/public/demo/curriculum.json is a snapshot of the art lane
// (written by `npm run demo:snapshot`), and only the lesson this demo replays
// has its transcript bundled alongside it. Every other lesson row arrives with
// hasTranscript:false and renders inert.

let curriculumPromise: Promise<CurriculumView> | null = null;

async function curriculum(): Promise<CurriculumView> {
  curriculumPromise ??= fetch(`${import.meta.env.BASE_URL}demo/curriculum.json`).then(
    (r) => r.json() as Promise<CurriculumView>
  );
  return curriculumPromise;
}

// Named *Text to avoid colliding with the replay's own `transcript` state.
async function transcriptText(lessonNumber: number): Promise<string> {
  const res = await fetch(
    `${import.meta.env.BASE_URL}demo/transcripts/${transcriptName(lessonNumber)}`
  );
  if (!res.ok) throw new Error(`Lesson ${lessonNumber}'s transcript isn't part of this demo.`);
  return res.text();
}

export const demoApi: Api = {
  status,
  version,
  report,
  curriculum,
  transcript: transcriptText,
  createLesson,
  lesson,
  sendMessage,
  endLesson,
  setModel,
  setFeedback,
  clearFeedback,
  approvePatterns,
  abandon,
  events,
};
