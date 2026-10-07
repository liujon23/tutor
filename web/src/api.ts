// Typed client for the app server's API.
import { demoApi } from "./demo/replay.js";
import type { DiagBatch } from "./lesson/audio/diag.js";

export type SessionSize = "tight" | "standard" | "deep";
export type LessonModel = "opus" | "sonnet";
/** How a learner turn was sent — mirrors server/types.ts. Absent means typed. */
export type Via = "typed" | "spoken";

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

export interface RecallCandidate {
  topicId: string;
  name: string;
  laneId: string;
  unitId: string;
  lastTouched: string;
  daysStale: number;
  streak: number;
  stabilityDays: number;
  overdueDays: number;
  offerProbability: number;
  bundleWith: string[];
}

export interface TopicRow {
  id: string;
  name: string;
  laneId: string;
  unitId: string;
  unitName: string;
  state: string;
  group: "core" | "optional";
}

export interface ActiveSession {
  id: string;
  title: string;
  params: { laneId?: string; size: SessionSize; model: LessonModel };
  createdAt: string;
  lastActivityAt: string;
  /** When it will be auto-abandoned for inactivity (absent from older servers). */
  expiresAt?: string;
}

export interface AttentionItem {
  id: string;
  title: string;
  reason: "pending-approval" | "uncommitted";
  at: string;
}

export interface SpacingConfig {
  baseDays: number;
  growth: number;
  maxDays: number;
}

export interface Status {
  today: string;
  spacing: SpacingConfig;
  lanes: StatusLane[];
  /** Recall candidates due per lane, same seeded draw the session packet uses.
   *  Lanes with nothing due are absent. */
  recallCandidatesByLane: Record<string, RecallCandidate[]>;
  openSettledItems: string[];
  topics: TopicRow[];
  activeSessions: ActiveSession[];
  attention: AttentionItem[];
}

export interface VersionInfo {
  buildId: string | null;
}

// --- Usage / progress / feedback report (Stats screen) ----------------------

export interface GroupStats {
  key: string;
  lessons: number;
  turns: number;
  tokens: TokenCounts;
  totalTokens: number;
  costUsd: number;
  wallClockMs: number;
}

export interface ModelStats {
  model: string;
  lessons: number;
  turns: number;
  totalTokens: number;
  costUsd: number;
}

export interface FeatureStat {
  feature: string;
  turnsWith: number;
  turnsWithout: number;
  avgTokensWith: number;
  avgTokensWithout: number;
  avgCostWith: number;
  avgCostWithout: number;
  totalTokensWith: number;
  totalCostWith: number;
}

export interface TimelineRow {
  lessonNumber: number;
  date: string;
  laneId: string;
  size: string;
  turns: number;
  totalTokens: number;
  costUsd: number;
  wallClockMs: number;
}

export interface UsageAnalysis {
  overall: GroupStats;
  byLane: GroupStats[];
  bySize: GroupStats[];
  byModel: ModelStats[];
  features: FeatureStat[];
  timeline: TimelineRow[];
}

export interface PacketTrendPoint {
  lessonNumber: number;
  date: string;
  packetTokens: number;
}

export interface LaneProgress {
  laneId: string;
  name: string;
  weight: number;
  unitsTotal: number;
  unitsComplete: number;
  currentUnitName: string | null;
  coreTopicsTotal: number;
  coreTopicsComfortable: number;
  staleTopics: number;
  lessonsTaken: number;
}

export interface FeedbackCounts {
  "2": number;
  "1": number;
  "-1": number;
  "-2": number;
}

export interface FeedbackTrendEntry {
  lessonNumber: number;
  counts: FeedbackCounts;
}

export interface FeedbackTrend {
  entries: FeedbackTrendEntry[];
  totals: FeedbackCounts;
}

export interface Report {
  usage: UsageAnalysis;
  packetTrend: PacketTrendPoint[];
  progress: LaneProgress[];
  feedbackTrend: FeedbackTrend;
}

// --- Curriculum viewer -------------------------------------------------------
// Mirrors server/curriculum-view.ts. Kept as a hand-written mirror (like Report
// above) rather than a shared import — web/ compiles on its own tsconfig.

export interface CurriculumTopic {
  id: string;
  name: string;
  state: string;
  lastTouchedDate: string | null;
  lastLesson: number | null;
  /** False when that lesson predates the transcript archive — render text, not a link. */
  lastLessonHasTranscript: boolean;
}

export interface CurriculumUnitLesson {
  lessonNumber: number;
  date: string;
  topicsLabel: string;
  topicsFull: string;
  hasTranscript: boolean;
  /** Learner turns spoken in drive mode; absent for lessons before it. */
  spokenTurns?: number;
  typedTurns?: number;
}

export interface CurriculumUnit {
  id: string;
  name: string;
  state: string;
  completedAt: string | null;
  prerequisites: string[];
  summary: string | null;
  summaryStale: boolean;
  progress: { coreComfortable: number; coreTotal: number };
  optionalRemaining: number;
  lastLessonDate: string | null;
  coreTopics: CurriculumTopic[];
  optionalTopics: CurriculumTopic[];
  bridgesInLane: { topicId: string; topicName: string; unitId: string; unitName: string }[];
  bridgesCrossLane: { topicId: string; topicName: string; unitName: string; laneName: string }[];
  lessons: CurriculumUnitLesson[];
}

export interface CurriculumLane {
  id: string;
  name: string;
  weight: number;
  direction: string;
  currentUnitId: string | null;
  layers: string[][];
  units: CurriculumUnit[];
}

export interface CurriculumView {
  today: string;
  lanes: CurriculumLane[];
}

export interface TranscriptEntry {
  id?: string; // stable per-message handle (absent only on pre-feature sessions)
  role: "user" | "assistant";
  text: string;
  at: string;
  images?: string[]; // inbound photo filenames — served via /api/assets/local/<name>
  via?: Via; // spoken turns came through speech recognition
}

/** Per-message rating: ⏫ +2 · 👍 +1 · 👎 -1 · ⏬ -2. Only -2 acts live. */
export type RatingLevel = 2 | 1 | -1 | -2;

export interface MessageFeedback {
  messageId: string;
  level: RatingLevel;
  note: string;
  at: string;
  flagged?: boolean; // a -2 that was surfaced to the tutor live
}

/** An image attachment for sendMessage: bare-base64 JPEG/PNG/GIF/WebP. */
export interface OutgoingImage {
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface LessonUsage {
  turns: number;
  tokens: TokenCounts;
  costUsd: number;
  durationMs: number;
  wallClockMs: number;
  byModel: Record<string, { turns: number; tokens: TokenCounts; costUsd: number }>;
  features: { webSearch: number; webFetch: number; photos: number };
}

export interface CommitResult {
  lessonNumber: number;
  summary: string[];
  proposedConfirmedPatterns: string[];
  gitMessage: string;
  committedAt: string;
  patternsResolved?: boolean;
  usage?: LessonUsage;
}

export interface LessonState {
  id: string;
  status: "active" | "committed" | "abandoned";
  title: string;
  params: { laneId?: string; size: SessionSize; model: LessonModel; discuss?: boolean };
  transcript: TranscriptEntry[];
  commit: CommitResult | null;
  createdAt: string;
  ending?: boolean;
  lastError?: string;
  feedback?: MessageFeedback[];
  /** A live runner is working on a turn right now. */
  turnInFlight?: boolean;
  /** Demo mode only: the recording's blurb, shown as a dismissible banner. */
  note?: string;
}

/** GET /api/lesson/:id/health — mirrors RunnerHealth in server/runner.ts. */
export interface RunnerHealth {
  alive: boolean;
  turnInFlight: boolean;
  queueLength: number;
  /** -1 when there is no live runner. */
  msSinceLastMessage: number;
  listeners: number;
}

export type LessonEvent =
  | { type: "ready"; model: string }
  | { type: "user"; id?: string; text: string; images?: string[] }
  // `id` is the transcript id the finished message will carry.
  | { type: "delta"; id?: string; text: string }
  | { type: "assistant"; id?: string; text: string }
  | { type: "tool_use"; name: string }
  | { type: "feedback_flag"; messageId: string; note: string }
  | { type: "committed"; commit: CommitResult }
  // costUsd here is the lesson-so-far total, not the cost of this one turn.
  | { type: "turn_done"; costUsd: number; isError: boolean; errors?: string[]; tokens?: TokenCounts }
  | { type: "rate_limit"; status: string; resetsAt?: number; info?: Record<string, unknown> }
  | { type: "api_error"; error: string }
  | { type: "error"; message: string }
  | { type: "closed" }
  // Every ~15s on each stream, so a dead stream can be told from a thinking model.
  | { type: "heartbeat" };

/** lesson-007.md — mirrors transcriptRelPath() in server/transcript.ts. */
export function transcriptName(lessonNumber: number): string {
  return `lesson-${String(lessonNumber).padStart(3, "0")}.md`;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// The full surface every screen/module calls through `api.*`. Both the live
// (fetch-based) and demo (static-replay) implementations satisfy this shape;
// see the seam at the bottom of this file.
export interface Api {
  status(): Promise<Status>;
  version(): Promise<VersionInfo>;
  report(): Promise<Report>;
  curriculum(): Promise<CurriculumView>;
  /** Raw markdown of an archived lesson transcript. */
  transcript(lessonNumber: number): Promise<string>;
  createLesson(body: {
    laneId?: string;
    topicOverride?: string;
    discuss?: boolean;
    size: SessionSize;
    model: LessonModel;
    via?: Via;
  }): Promise<{ sessionId: string; title: string }>;
  lesson(id: string): Promise<LessonState>;
  sendMessage(id: string, text: string, images?: OutgoingImage[], via?: Via): Promise<{ ok: boolean }>;
  endLesson(id: string, via?: Via): Promise<{ ok: boolean; alreadyCommitted?: boolean }>;
  /** Undo a tapped End: `ending` is otherwise sticky until the commit. */
  keepGoing(id: string): Promise<{ ok: boolean }>;
  health(id: string): Promise<RunnerHealth>;
  /** Replace a runner that stopped making progress (drive-mode watchdog). */
  kick(id: string): Promise<{ ok: boolean; requeued: string | null }>;
  /** Upload a drive-mode diagnostics batch. */
  sendDiag(id: string, batch: DiagBatch): Promise<{ ok: boolean; id: string }>;
  setModel(id: string, model: LessonModel): Promise<{ ok: boolean }>;
  setFeedback(
    id: string,
    body: { messageId: string; level: RatingLevel; note: string }
  ): Promise<{ ok: boolean; flagged: boolean }>;
  clearFeedback(id: string, messageId: string): Promise<{ ok: boolean }>;
  approvePatterns(id: string, approve: string[]): Promise<{ ok: boolean; applied: number }>;
  abandon(id: string): Promise<{ ok: boolean }>;
  events(
    id: string,
    onEvent: (ev: LessonEvent) => void,
    onReopen?: () => void,
    onStatus?: (status: StreamStatus, detail?: { retryInMs?: number }) => void
  ): () => void;
}

/** What the event stream is doing, for drive mode's diagnostics. */
export type StreamStatus = "open" | "error" | "retrying";

const liveApi: Api = {
  status: (): Promise<Status> => fetch("/api/status").then((r) => j<Status>(r)),

  version: (): Promise<VersionInfo> => fetch("/api/version").then((r) => j<VersionInfo>(r)),

  report: (): Promise<Report> => fetch("/api/report").then((r) => j<Report>(r)),

  curriculum: (): Promise<CurriculumView> =>
    fetch("/api/curriculum").then((r) => j<CurriculumView>(r)),

  // Archived transcripts are plain files on the static /transcripts/ route the
  // server already exposes — no API endpoint, so this reads text, not JSON.
  transcript: async (lessonNumber: number): Promise<string> => {
    const res = await fetch(`/transcripts/${transcriptName(lessonNumber)}`);
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `No archived transcript for lesson ${lessonNumber}.`
          : `Couldn't load the transcript (${res.status}).`
      );
    }
    return res.text();
  },

  createLesson: (body: {
    laneId?: string;
    topicOverride?: string;
    discuss?: boolean;
    size: SessionSize;
    model: LessonModel;
    via?: Via;
  }): Promise<{ sessionId: string; title: string }> =>
    fetch("/api/lesson", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j(r)),

  lesson: (id: string): Promise<LessonState> =>
    fetch(`/api/lesson/${id}`).then((r) => j<LessonState>(r)),

  sendMessage: (id: string, text: string, images?: OutgoingImage[], via?: Via): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(images?.length ? { images } : {}), ...(via ? { via } : {}) }),
    }).then((r) => j(r)),

  endLesson: (id: string, via?: Via): Promise<{ ok: boolean; alreadyCommitted?: boolean }> =>
    fetch(
      `/api/lesson/${id}/end`,
      via
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ via }) }
        : { method: "POST" }
    ).then((r) => j(r)),

  keepGoing: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}/keep-going`, { method: "POST" }).then((r) => j(r)),

  health: (id: string): Promise<RunnerHealth> =>
    fetch(`/api/lesson/${id}/health`).then((r) => j<RunnerHealth>(r)),

  kick: (id: string): Promise<{ ok: boolean; requeued: string | null }> =>
    fetch(`/api/lesson/${id}/kick`, { method: "POST" }).then((r) => j(r)),

  sendDiag: (id: string, batch: DiagBatch): Promise<{ ok: boolean; id: string }> =>
    fetch(`/api/diag/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    }).then((r) => j(r)),

  setModel: (id: string, model: LessonModel): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).then((r) => j(r)),

  setFeedback: (
    id: string,
    body: { messageId: string; level: RatingLevel; note: string }
  ): Promise<{ ok: boolean; flagged: boolean }> =>
    fetch(`/api/lesson/${id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j(r)),

  clearFeedback: (id: string, messageId: string): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}/feedback/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    }).then((r) => j(r)),

  approvePatterns: (id: string, approve: string[]): Promise<{ ok: boolean; applied: number }> =>
    fetch(`/api/lesson/${id}/approve-patterns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    }).then((r) => j(r)),

  abandon: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}`, { method: "DELETE" }).then((r) => j(r)),

  events: (
    id: string,
    onEvent: (ev: LessonEvent) => void,
    onReopen?: () => void,
    onStatus?: (status: StreamStatus, detail?: { retryInMs?: number }) => void
  ): (() => void) => {
    let es: EventSource | null = null;
    let stopped = false;
    let hadError = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1000;
    const open = () => {
      const source = new EventSource(`/api/lesson/${id}/events`);
      es = source;
      source.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data) as LessonEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      // SSE has no replay: after any drop, the reconnect starts from "now" and any
      // events emitted in the gap are lost. Signal reopen-after-error so the caller
      // can refetch and reconcile the full lesson state.
      source.onerror = () => {
        hadError = true;
        onStatus?.("error");
        // While CONNECTING the browser retries by itself. CLOSED means it gave
        // up for good — any non-200 reconnect does that, e.g. a 502 from
        // `tailscale serve` while the PC restarts — and the screen would
        // otherwise stay silently dead. Recreate it, backing off.
        if (source.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          onStatus?.("retrying", { retryInMs: backoffMs });
          retryTimer = setTimeout(open, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      };
      source.onopen = () => {
        backoffMs = 1000;
        onStatus?.("open");
        if (hadError) {
          hadError = false;
          onReopen?.();
        }
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  },
};

// --- demo/live seam -----------------------------------------------------
// `__DEMO__` is a build-time constant (see vite.config.ts): in a
// `--mode demo` build it's `true` and this collapses to `demoApi` alone —
// `liveApi`'s fetch/EventSource calls are unreachable and Rollup tree-shakes
// them out entirely. In every other build it's `false` and the reverse
// happens, so demoApi (and the whole recording/replay module it pulls in)
// never reaches the live bundle.
export const api: Api = __DEMO__ ? demoApi : liveApi;
