// Shared types for the app server.
import type { SessionSize, SpacingConfig } from "../core/types.js";

export type LessonModel = "opus" | "sonnet";
export type LessonStatus = "active" | "committed" | "abandoned";

export interface LessonParams {
  laneId?: string;
  topicOverride?: string; // topic id from the picker — the learner's explicit override
  discuss?: boolean; // selection moved into the chat
  recallRequested?: string[]; // recall-candidate topic ids the learner tapped on the select screen
  size: SessionSize;
  model: LessonModel;
  historyN: number;
  spacing: SpacingConfig; // recall interval growth (from env, see server/index.ts)
}

export interface TranscriptEntry {
  /** Stable per-message handle, assigned at append time. Ratings, badges, and
   *  flag notes all key on it. Optional only for sessions stored before the
   *  per-message-feedback feature. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  at: string; // ISO timestamp
  hidden?: boolean; // server-generated kickoff — not shown as the learner's words
  /** Inbound photo filenames under .app/assets/ (served via /api/assets/local/).
   *  Never base64 — the session JSON stays small; the commit archives copies. */
  images?: string[];
}

// --- Per-message feedback ----------------------------------------------------

/** Rating as a signed magnitude: ⏫ +2 · 👍 +1 · 👎 -1 · ⏬ -2. Only -2 acts on
 *  the live lesson; everything else is siloed until wrap-up. No rating = no
 *  signal, ever. */
export type RatingLevel = 2 | 1 | -1 | -2;
export const RATING_LEVELS: RatingLevel[] = [2, 1, -1, -2];

/** One rating on one tutor message. One item per message (re-rating upserts). */
export interface MessageFeedback {
  messageId: string;
  level: RatingLevel;
  note: string; // required — the learner always explains a rating
  at: string; // ISO — last set/updated
  /** A -2 was surfaced to the tutor live (set when the flag fires; survives a
   *  later downgrade, which can't unsend the flag). */
  flagged?: boolean;
}

/** A distilled feedback entry in the commit patch — the "smart log" line the
 *  tutor writes at wrap-up (summary + context, not a raw dump). */
export interface FeedbackLogEntry {
  messageId: string;
  level: RatingLevel;
  context: string; // one line: what the rated message was doing
  takeaway: string; // what to learn from the learner's note
}

/** An image the learner attached to a message, as received from the client. */
export interface InboundImage {
  media_type: InboundMediaType;
  data: string; // bare base64
}

export type InboundMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export const INBOUND_MEDIA_TYPES: InboundMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** Token counts for one turn (or summed across a lesson). Per-request semantics:
 *  the SDK's per-result `usage` is that turn's tokens, never cumulative. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** One assistant turn's resource use, tagged with what drove it — the raw
 *  material for later "which features cost the most?" analysis. */
export interface UsageRecord {
  at: string; // ISO — when the turn finished
  model: string; // the model that actually produced this turn
  tokens: TokenCounts;
  costUsd: number; // equivalent cost at API rates (NOT a Pro charge)
  durationMs: number; // wall-clock for the turn (SDK result.duration_ms)
  tools: string[]; // tool names that fired this turn (WebSearch, WebFetch, commit_session…)
  hadImage: boolean; // the user turn that triggered this carried a photo
  isError: boolean;
}

/** Per-lesson roll-up of usage — what the wrap-up shows and the ledger stores. */
export interface LessonUsage {
  turns: number;
  tokens: TokenCounts; // summed across turns
  costUsd: number; // summed equivalent cost
  durationMs: number; // summed turn durations (model "thinking" time)
  // Real elapsed (last activity − created). A ROUGH proxy for effort: it counts
  // idle time too, so a lesson the learner stepped away from mid-flight reads as "long"
  // without actually using more of the subscription. Worth knowing, not trusting.
  wallClockMs: number;
  byModel: Record<string, { turns: number; tokens: TokenCounts; costUsd: number }>;
  features: {
    webSearch: number; // turns in which each feature appeared
    webFetch: number;
    photos: number;
  };
}

export interface CommitResult {
  lessonNumber: number;
  summary: string[];
  proposedConfirmedPatterns: string[];
  gitMessage: string;
  committedAt: string;
  patternsResolved?: boolean; // the learner approved/rejected the proposals
  /** Resource use for this lesson — undefined for lessons committed before the
   *  usage feature existed, or if no turns were recorded. */
  usage?: LessonUsage;
}

export interface StoredSession {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  status: LessonStatus;
  params: LessonParams;
  title: string;
  systemPrompt: string;
  sdkSessionId: string | null;
  transcript: TranscriptEntry[];
  commit: CommitResult | null;
  /** The learner tapped "End lesson" — the wrap-up was requested. Used to flag a lesson
   *  that ended without a commit so it isn't silently lost at expiry. */
  ending?: boolean;
  /** Last fatal runner error, persisted so a reconnecting client (or one that
   *  connected after the error fired) can still surface it. Cleared on progress. */
  lastError?: string;
  /** Per-turn resource use, appended as each turn's SDK result arrives. The
   *  durable ledger and the wrap-up summary are both derived from this. */
  usage?: UsageRecord[];
  /** Per-message ratings, upserted as the learner rates tutor messages. Siloed from the
   *  model (except -2 flags) until wrap-up; distilled into the feedback ledger
   *  at commit. Raw items live only here — they die with the session file. */
  feedback?: MessageFeedback[];
}

/** Events broadcast to SSE subscribers. */
export type LessonEvent =
  | { type: "ready"; model: string }
  | { type: "user"; id?: string; text: string; images?: string[] }
  | { type: "delta"; text: string }
  | { type: "assistant"; id?: string; text: string }
  | { type: "tool_use"; name: string }
  | { type: "feedback_flag"; messageId: string; note: string }
  | { type: "committed"; commit: CommitResult }
  // costUsd here is the lesson-so-far total (sum of turns recorded this
  // session so far), not the cost of this one turn.
  | { type: "turn_done"; costUsd: number; isError: boolean; errors?: string[]; tokens?: TokenCounts }
  | { type: "rate_limit"; status: string; resetsAt?: number }
  | { type: "api_error"; error: string }
  | { type: "error"; message: string }
  | { type: "closed" };
