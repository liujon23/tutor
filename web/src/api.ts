// Typed client for the app server's API.

export type SessionSize = "tight" | "standard" | "deep";
export type LessonModel = "opus" | "sonnet";

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
}

export interface AttentionItem {
  id: string;
  title: string;
  reason: "pending-approval" | "uncommitted";
  at: string;
}

export interface Status {
  today: string;
  staleDays: number;
  lanes: StatusLane[];
  recallCandidates: RecallCandidate[];
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

export interface TranscriptEntry {
  id?: string; // stable per-message handle (absent only on pre-feature sessions)
  role: "user" | "assistant";
  text: string;
  at: string;
  images?: string[]; // inbound photo filenames — served via /api/assets/local/<name>
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
}

export type LessonEvent =
  | { type: "ready"; model: string }
  | { type: "user"; id?: string; text: string; images?: string[] }
  | { type: "delta"; text: string }
  | { type: "assistant"; id?: string; text: string }
  | { type: "tool_use"; name: string }
  | { type: "feedback_flag"; messageId: string; note: string }
  | { type: "committed"; commit: CommitResult }
  // costUsd here is the lesson-so-far total, not the cost of this one turn.
  | { type: "turn_done"; costUsd: number; isError: boolean; errors?: string[]; tokens?: TokenCounts }
  | { type: "rate_limit"; status: string; resetsAt?: number }
  | { type: "api_error"; error: string }
  | { type: "error"; message: string }
  | { type: "closed" };

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

export const api = {
  status: (): Promise<Status> => fetch("/api/status").then((r) => j<Status>(r)),

  version: (): Promise<VersionInfo> => fetch("/api/version").then((r) => j<VersionInfo>(r)),

  report: (): Promise<Report> => fetch("/api/report").then((r) => j<Report>(r)),

  createLesson: (body: {
    laneId?: string;
    topicOverride?: string;
    discuss?: boolean;
    recallRequested?: string[];
    size: SessionSize;
    model: LessonModel;
  }): Promise<{ sessionId: string; title: string }> =>
    fetch("/api/lesson", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j(r)),

  lesson: (id: string): Promise<LessonState> =>
    fetch(`/api/lesson/${id}`).then((r) => j<LessonState>(r)),

  sendMessage: (id: string, text: string, images?: OutgoingImage[]): Promise<{ ok: boolean }> =>
    fetch(`/api/lesson/${id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(images?.length ? { text, images } : { text }),
    }).then((r) => j(r)),

  endLesson: (id: string): Promise<{ ok: boolean; alreadyCommitted?: boolean }> =>
    fetch(`/api/lesson/${id}/end`, { method: "POST" }).then((r) => j(r)),

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
    onReopen?: () => void
  ): (() => void) => {
    const es = new EventSource(`/api/lesson/${id}/events`);
    let hadError = false;
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as LessonEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    // SSE has no replay: after any drop, the reconnect starts from "now" and any
    // events emitted in the gap are lost. Signal reopen-after-error so the caller
    // can refetch and reconcile the full lesson state.
    es.onerror = () => {
      hadError = true;
    };
    es.onopen = () => {
      if (hadError) {
        hadError = false;
        onReopen?.();
      }
    };
    return () => es.close();
  },
};
