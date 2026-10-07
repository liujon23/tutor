// LessonRunner: one live Agent SDK session per active lesson.
// Streaming-input mode keeps the session alive across turns; the runner owns an
// input queue (user messages in) and a listener set (SSE events out). If the
// server restarts mid-lesson, the manager revives the runner with `resume` on
// the stored SDK session id — the transcript in the store covers the UI side.
import { readFileSync } from "node:fs";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { checkFetchUrl, urlFromWebFetchInput } from "../core/url-guard.js";
import { ROOT } from "../scripts/lib.js";
import { contentTypeForFile, inboundAssetFile, saveInboundImage } from "./assets.js";
import { serverDiag } from "./diag.js";
import { SESSION_EXPIRY_MS } from "./params.js";
import { createTutorServer, COMMIT_TOOL_NAME } from "./tutor-tool.js";
import { appendTranscript, listSessions, loadSession, newMessageId, saveSession, touchSession } from "./store.js";
import { costDelta, usageFromResult } from "./usage.js";
import type {
  CommitResult,
  InboundImage,
  InboundMediaType,
  LessonEvent,
  StoredSession,
  TranscriptEntry,
  Via,
} from "./types.js";

/**
 * SDK user-turn content: image blocks first, then the text. This is the
 * documented SDKUserMessage.message.content shape — pure and unit-tested.
 */
export function buildUserContent(
  text: string,
  images: InboundImage[] = []
): SDKUserMessage["message"]["content"] {
  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = images.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.media_type, data: img.data },
  }));
  if (text) blocks.push({ type: "text" as const, text });
  return blocks;
}

/**
 * PreToolUse gate on WebFetch. Web tools mean third-party text reaches model
 * context, and WebFetch is the one tool that can carry context back out in a
 * URL — see core/url-guard.ts for the reasoning and the limits.
 *
 * A PreToolUse deny is the right hook: it short-circuits ahead of canUseTool and
 * fires regardless of permissionMode, so it holds under `dontAsk`. The denial
 * reason goes back to the model as text so it retries with a plain URL instead
 * of stalling. WebSearch is not matched here — it stays unrestricted.
 */
export function webFetchGate(toolName: string, toolInput: unknown): SyncHookJSONOutput {
  if (toolName !== "WebFetch") return {};
  const url = urlFromWebFetchInput(toolInput);
  // No URL to read means the input shape changed under us. Denying would break
  // fetching wholesale on an SDK bump; the guard is a narrowing, not a seal.
  if (url === null) return {};
  const verdict = checkFetchUrl(url);
  if (verdict.ok) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked by the tutor's outbound URL guard: ${verdict.reason}`,
    },
  };
}

/**
 * Transcript ids for messages that are still streaming.
 *
 * A message's id used to exist only once it finished (appendTranscript), so a
 * client could not tell which entry a `delta` belonged to — and after an SSE
 * gap, a spoken client could not tell how much of a message it had already
 * said. Now the id is minted when the API message starts (`message_start`),
 * rides every `delta`, and is claimed by the finished `assistant` message with
 * the same API message id. If one API message ever yields two text-bearing
 * SDK messages, the second gets a fresh id and `claim` reports the reuse.
 */
export class StreamIds {
  private byApiId = new Map<string, { id: string; claimed: boolean }>();
  private currentId: string | null = null;

  constructor(private mint: () => string = newMessageId) {}

  /** An API message started streaming. */
  start(apiId: string): string {
    const id = this.mint();
    this.byApiId.set(apiId, { id, claimed: false });
    this.currentId = id;
    return id;
  }

  /** The id for deltas arriving now (null before any message_start). */
  get current(): string | null {
    return this.currentId;
  }

  /** The finished message's transcript id. */
  claim(apiId: string | undefined): { id: string; reused: boolean; unknown: boolean } {
    const e = apiId ? this.byApiId.get(apiId) : undefined;
    if (!e) return { id: this.mint(), reused: false, unknown: true };
    if (e.claimed) return { id: this.mint(), reused: true, unknown: false };
    e.claimed = true;
    if (this.currentId === e.id) this.currentId = null;
    return { id: e.id, reused: false, unknown: false };
  }

  /** Forget everything (a turn ended). */
  reset(): void {
    this.byApiId.clear();
    this.currentId = null;
  }
}

/** The most recent user turn with no assistant reply after it — what a kick re-sends. */
export function lastUnansweredUser(transcript: TranscriptEntry[]): TranscriptEntry | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "assistant") return null;
    if (transcript[i].role === "user") return transcript[i];
  }
  return null;
}

/** What GET /api/lesson/:id/health reports — the client watchdog asks this before acting. */
export interface RunnerHealth {
  alive: boolean;
  turnInFlight: boolean;
  queueLength: number;
  msSinceLastMessage: number;
  listeners: number;
}

export class LessonRunner {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  // A quiet close (a kick) mutes everything the dying query still emits, so a
  // client never hears "closed" about a runner that has already been replaced.
  private muted = false;
  private q: Query;
  readonly startedAt = Date.now();
  // Per-turn accounting, reset on each `result`. `turnModel` is read from the
  // assistant message so a mid-lesson model switch is attributed correctly.
  private turnTools: string[] = [];
  private turnHadImage = false;
  private turnModel = "";
  // How the turn now running was sent; assistant entries and usage inherit it.
  private turnVia: Via = "typed";
  // The SDK's `result.total_cost_usd` is cumulative for the whole SDK session
  // (not per-turn) — this tracks the last cumulative figure seen so each new
  // result can be turned into a per-turn delta (see costDelta in usage.ts).
  private lastCumulativeCost = 0;
  // Epoch ms of the learner's last real message — anchors the commit's "compose" timing
  // (how long the model spent building the patch after the learner's "go ahead").
  private lastUserTurnAt = Date.now();
  // Turn tracking for health and GET's turnInFlight. Sends not yet answered by
  // a `result`. On each result this resets to the messages the SDK hasn't been
  // handed yet: a turn can absorb several queued sends, so counting down one
  // per result could leave it stuck above zero. The SDK's own
  // session_state_changed is logged beside it to check this rule against.
  private pendingTurns = 0;
  private lastSdkMessageAt = Date.now();
  private streamIds = new StreamIds();
  // Turn timing for the diag log.
  private turnSendAt: number | null = null;
  private turnFirstDeltaLogged = false;
  private deltasById = new Map<string, number>();

  constructor(
    private session: StoredSession,
    private emitRaw: (ev: LessonEvent) => void,
    readonly origin: "start" | "revive" | "kick" = "start"
  ) {
    const tutorServer = createTutorServer({
      session: () => this.session,
      onCommitted: (commit) => this.onCommitted(commit),
      composeStartedAt: () => this.lastUserTurnAt,
    });
    // Web tools default ON (kill switch: TUTOR_WEB_TOOLS=0) — sourcing and
    // link verification shouldn't depend on an opt-in flag the learner forgets.
    const webTools = process.env.TUTOR_WEB_TOOLS !== "0";

    const options: Options = {
      model: session.params.model,
      systemPrompt: session.systemPrompt,
      cwd: ROOT,
      // The model must not touch the repo directly — its only tools are
      // commit_session plus web search/fetch for sourcing.
      tools: webTools ? ["WebSearch", "WebFetch"] : [],
      mcpServers: { tutor: tutorServer },
      allowedTools: webTools
        ? [COMMIT_TOOL_NAME, "WebSearch", "WebFetch"]
        : [COMMIT_TOOL_NAME],
      permissionMode: "dontAsk",
      includePartialMessages: true,
      resume: session.sdkSessionId ?? undefined,
      // Narrow WebFetch's outbound URLs (see webFetchGate). Registered even when
      // web tools are off so the gate can't be missed if that default flips.
      hooks: {
        PreToolUse: [
          {
            matcher: "WebFetch",
            hooks: [
              async (input) =>
                webFetchGate(
                  (input as { tool_name?: string }).tool_name ?? "",
                  (input as { tool_input?: unknown }).tool_input
                ),
            ],
          },
        ],
      },
    };

    this.diag("runner-start", { origin, resume: session.sdkSessionId ?? null, model: session.params.model });
    this.q = query({ prompt: this.input(), options });
    void this.consume();
  }

  private diag(kind: string, detail?: unknown, level: "info" | "anomaly" = "info"): void {
    serverDiag(this.session.id, kind, detail, level);
  }

  private emit(ev: LessonEvent): void {
    if (this.muted) {
      if (ev.type !== "delta") this.diag("muted-event", { type: ev.type });
      return;
    }
    this.emitRaw(ev);
  }

  /** Enqueue a user turn. `hidden` marks server-generated kickoff text.
   *  `modelText`, when given, is what the model receives — the transcript
   *  still persists `text` (used to ride machinery like the feedback hand-off
   *  along a short human-readable message). `via` records how the learner
   *  sent it; omitted for server-made turns that don't change the channel. */
  send(text: string, hidden = false, images: InboundImage[] = [], modelText?: string, via?: Via): void {
    if (this.closed) throw new Error("lesson session is closed");
    // Image bytes go to .app/assets/, never into the session JSON — the
    // transcript entry carries only the filenames.
    const names = images.map((img) => saveInboundImage(img));
    if (images.length) this.turnHadImage = true; // attributed to the turn this drives
    const entry: TranscriptEntry = {
      role: "user",
      text,
      at: new Date().toISOString(),
      hidden,
      ...(names.length ? { images: names } : {}),
      ...(via ? { via } : {}),
      // Kept so a kick can re-send exactly what the model was given.
      ...(modelText !== undefined && modelText !== text ? { modelText } : {}),
    };
    appendTranscript(this.session, entry);
    if (via) this.turnVia = via;
    if (!hidden) {
      // A real user turn (not the kickoff or the hidden feedback-flag handoff)
      // resets the compose clock, so it measures "go ahead" → commit.
      this.lastUserTurnAt = Date.now();
      this.emit({ type: "user", id: entry.id, text, ...(names.length ? { images: names } : {}) });
    }
    this.enqueue(modelText ?? text, images);
    this.diag("send", {
      id: entry.id,
      hidden,
      via: via ?? null,
      chars: text.length,
      modelChars: (modelText ?? text).length,
      images: names.length,
      pendingTurns: this.pendingTurns,
    });
  }

  /**
   * Re-send a turn the transcript already holds, to the model only — no new
   * transcript entry, no `user` event. Used after a kick, when the previous
   * runner hung on this turn. If the hung SDK session had already recorded
   * it, the model sees it twice; the diag log notes every requeue so that
   * case can be spotted.
   */
  requeue(entry: TranscriptEntry): void {
    if (this.closed) throw new Error("lesson session is closed");
    const images: InboundImage[] = [];
    for (const name of entry.images ?? []) {
      const file = inboundAssetFile(name);
      if (!file) {
        this.diag("requeue-image-missing", { name }, "anomaly");
        continue;
      }
      images.push({
        media_type: contentTypeForFile(file) as InboundMediaType,
        data: readFileSync(file).toString("base64"),
      });
    }
    if (entry.via) this.turnVia = entry.via;
    if (images.length) this.turnHadImage = true;
    this.enqueue(entry.modelText ?? entry.text, images);
    this.diag("requeue", { id: entry.id, hidden: !!entry.hidden, via: entry.via ?? null, images: images.length });
  }

  private enqueue(text: string, images: InboundImage[]): void {
    this.pendingTurns++;
    this.turnSendAt ??= Date.now();
    this.queue.push({
      type: "user",
      message: { role: "user", content: buildUserContent(text, images) },
      parent_tool_use_id: null,
    });
    this.wake?.();
    this.wake = null;
  }

  /**
   * The learner double-thumbed-down a tutor message: surface it in the chat (SSE flag)
   * and queue a hidden course-correct turn. Queued, never an interrupt — the
   * tutor addresses it on its next turn, after any in-flight reply finishes.
   */
  flagDoubleDown(messageId: string, ratedSnippet: string, note: string): void {
    this.emit({ type: "feedback_flag", messageId, note });
    this.send(
      `[The learner flagged one of your messages with a strong double thumbs-down. ` +
        `The message began: "${ratedSnippet}". Their explanation: "${note}". ` +
        `Acknowledge briefly, course-correct now, and don't over-apologize. ` +
        `This is the only rating that reaches you mid-lesson; draw no conclusions ` +
        `about unrated messages.]`,
      true
    );
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  /** Stop the SDK session (input stream ends; query winds down after current work).
   *  A `quiet` close mutes the runner first: nothing it emits afterwards —
   *  including `closed` — reaches clients. */
  close(reason = "close", quiet = false): void {
    if (this.closed) return;
    this.diag("runner-close", { reason, quiet, pendingTurns: this.pendingTurns });
    if (quiet) this.muted = true;
    this.closed = true;
    this.wake?.();
    this.wake = null;
    try {
      this.q.close();
    } catch {
      /* already gone */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get turnInFlight(): boolean {
    return !this.closed && this.pendingTurns > 0;
  }

  health(listeners: number): RunnerHealth {
    return {
      alive: !this.closed,
      turnInFlight: this.turnInFlight,
      queueLength: this.queue.length,
      msSinceLastMessage: Date.now() - this.lastSdkMessageAt,
      listeners,
    };
  }

  /** The live in-memory session record. While a runner is alive it re-saves
   *  this object on every transcript append, so endpoint writes must mutate
   *  THIS record (via manager.sessionFor) — a separately loaded copy would
   *  clobber, or be clobbered by, the runner's saves. */
  get sessionRecord(): StoredSession {
    return this.session;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private onCommitted(commit: CommitResult): void {
    this.session.commit = commit;
    this.session.status = "committed";
    this.clearError();
    touchSession(this.session);
    this.diag("committed", { lessonNumber: commit.lessonNumber });
    this.emit({ type: "committed", commit });
  }

  private clearError(): void {
    if (this.session.lastError) {
      this.session.lastError = undefined;
      saveSession(this.session);
    }
  }

  private recordError(message: string): void {
    this.session.lastError = message;
    saveSession(this.session);
    this.emit({ type: "error", message });
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.handle(msg);
      }
    } catch (e) {
      const message = (e as Error).message;
      this.diag("consume-error", { message, muted: this.muted }, "anomaly");
      // A kicked runner's death is expected; don't surface it as the lesson's error.
      if (!this.muted) this.recordError(message);
    } finally {
      this.closed = true;
      this.diag("runner-ended", { muted: this.muted, pendingTurns: this.pendingTurns });
      this.emit({ type: "closed" });
    }
  }

  private handle(msg: SDKMessage): void {
    this.lastSdkMessageAt = Date.now();
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          if (this.session.sdkSessionId !== msg.session_id) {
            this.session.sdkSessionId = msg.session_id;
            saveSession(this.session);
          }
          this.diag("sdk-init", { model: msg.model, sdkSessionId: msg.session_id });
          this.emit({ type: "ready", model: msg.model });
        } else if (msg.subtype === "api_retry") {
          // The SDK is retrying an API call: progress, not a hang (health's
          // msSinceLastMessage resets above), but worth knowing about.
          this.diag(
            "api-retry",
            { attempt: msg.attempt, of: msg.max_retries, delayMs: msg.retry_delay_ms, status: msg.error_status, error: msg.error },
            "anomaly"
          );
        } else if (msg.subtype === "session_state_changed") {
          // Logged beside our own pendingTurns, to check that rule against the SDK's view.
          this.diag("sdk-state", { state: msg.state, pendingTurns: this.pendingTurns });
        }
        break;
      }
      case "stream_event": {
        const ev = msg.event;
        if (ev.type === "message_start") {
          const id = this.streamIds.start(ev.message.id);
          this.deltasById.set(id, 0);
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          const id = this.streamIds.current ?? undefined;
          if (!this.turnFirstDeltaLogged) {
            this.turnFirstDeltaLogged = true;
            this.diag("first-delta", {
              id,
              msSinceSend: this.turnSendAt === null ? null : Date.now() - this.turnSendAt,
              ttftMs: msg.ttft_ms ?? null,
            });
          }
          if (id) this.deltasById.set(id, (this.deltasById.get(id) ?? 0) + 1);
          this.emit({ type: "delta", ...(id ? { id } : {}), text: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        if (msg.error) {
          this.diag("api-error", { error: msg.error }, "anomaly");
          this.emit({ type: "api_error", error: msg.error });
        } else this.clearError(); // a clean assistant turn means we recovered
        // The model that actually produced this turn (survives a mid-lesson switch).
        const model = (msg.message as { model?: string }).model;
        if (model) this.turnModel = model;
        const text = msg.message.content
          .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
          .join("");
        if (text.trim()) {
          const claim = this.streamIds.claim((msg.message as { id?: string }).id);
          if (claim.reused || claim.unknown) {
            // The client saw this message's deltas under another id (or none):
            // it will reconcile by text, but the mismatch must be visible.
            this.diag("stream-id-mismatch", { id: claim.id, reused: claim.reused, unknown: claim.unknown }, "anomaly");
          }
          const entry: TranscriptEntry = {
            id: claim.id,
            role: "assistant",
            text,
            at: new Date().toISOString(),
            ...(this.turnVia === "spoken" ? { via: this.turnVia } : {}),
          };
          appendTranscript(this.session, entry);
          this.diag("assistant", {
            id: entry.id,
            chars: text.length,
            deltas: this.deltasById.get(claim.id) ?? 0,
            msSinceSend: this.turnSendAt === null ? null : Date.now() - this.turnSendAt,
          });
          this.emit({ type: "assistant", id: entry.id, text });
        }
        for (const b of msg.message.content) {
          if (b.type === "tool_use") {
            this.turnTools.push(b.name);
            this.diag("tool-use", { name: b.name });
            this.emit({ type: "tool_use", name: b.name });
          }
        }
        break;
      }
      case "result": {
        const cumulative = msg.total_cost_usd ?? 0;
        const turnCost = costDelta(this.lastCumulativeCost, cumulative);
        this.lastCumulativeCost = cumulative;
        const record = usageFromResult(
          msg,
          {
            model: this.turnModel || this.session.params.model,
            tools: this.turnTools,
            hadImage: this.turnHadImage,
            via: this.turnVia,
          },
          turnCost
        );
        const usage = (this.session.usage ??= []);
        usage.push(record);
        saveSession(this.session);
        // Sends the SDK hasn't been handed yet are still owed a turn; every
        // send it has seen is answered by this result.
        const before = this.pendingTurns;
        this.pendingTurns = this.queue.length;
        this.diag("result", {
          msSinceSend: this.turnSendAt === null ? null : Date.now() - this.turnSendAt,
          durationMs: record.durationMs,
          isError: msg.is_error,
          subtype: msg.subtype,
          via: this.turnVia,
          tools: record.tools,
          tokens: record.tokens,
          costUsd: record.costUsd,
          pendingTurns: { before, after: this.pendingTurns },
        });
        // Reset per-turn accumulators for the next exchange.
        this.turnTools = [];
        this.turnHadImage = false;
        this.turnModel = "";
        this.turnSendAt = this.pendingTurns > 0 ? Date.now() : null;
        this.turnFirstDeltaLogged = false;
        this.deltasById.clear();
        this.streamIds.reset();
        // Lesson-so-far total (not this turn alone) — sums the persisted
        // records, so it stays correct across a runner revival too.
        const lessonCostUsd = usage.reduce((sum, r) => sum + r.costUsd, 0);
        this.emit({
          type: "turn_done",
          costUsd: lessonCostUsd,
          isError: msg.is_error,
          errors: msg.subtype === "success" ? undefined : msg.errors,
          tokens: record.tokens,
        });
        break;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        this.diag("rate-limit", info, info.status === "allowed" ? "info" : "anomaly");
        this.emit({
          type: "rate_limit",
          status: info.status,
          resetsAt: info.resetsAt,
          info: { ...info },
        });
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Manager: session records + live runners, with auto-expiry.
// ---------------------------------------------------------------------------

export class LessonManager {
  private runners = new Map<string, LessonRunner>();
  // Listeners are keyed by session id and OUTLIVE runner instances, so an SSE
  // client that connected while the session was dormant still receives events
  // after a revival.
  private listeners = new Map<string, Set<(ev: LessonEvent) => void>>();
  // Deltas dispatched to nobody since the last logged event, per session —
  // summarised rather than logged one by one.
  private lostDeltas = new Map<string, number>();

  constructor() {
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  subscribe(id: string, fn: (ev: LessonEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  listenerCount(id: string): number {
    return this.listeners.get(id)?.size ?? 0;
  }

  private dispatch(id: string, ev: LessonEvent): void {
    const listeners = this.listeners.get(id);
    const count = listeners?.size ?? 0;
    // Every event with its listener count: 0 means it was lost to an SSE gap,
    // which measures the problem drive mode most needs to survive. Deltas are
    // too many to log singly, so only lost ones are counted, and the count
    // rides on the next logged event.
    if (ev.type === "delta") {
      if (count === 0) this.lostDeltas.set(id, (this.lostDeltas.get(id) ?? 0) + 1);
    } else {
      const lost = this.lostDeltas.get(id) ?? 0;
      this.lostDeltas.delete(id);
      serverDiag(
        id,
        "dispatch",
        { type: ev.type, listeners: count, ...(lost ? { lostDeltas: lost } : {}) },
        count === 0 ? "anomaly" : "info"
      );
    }
    for (const fn of listeners ?? []) {
      try {
        fn(ev);
      } catch {
        /* a broken subscriber must not kill the lesson */
      }
    }
  }

  start(session: StoredSession, kickoff: string, kickoffModelText?: string, via?: Via): LessonRunner {
    saveSession(session);
    const runner = new LessonRunner(session, (ev) => this.dispatch(session.id, ev), "start");
    this.runners.set(session.id, runner);
    runner.send(kickoff, true, [], kickoffModelText, via);
    return runner;
  }

  /**
   * The authoritative session record: the live runner's in-memory object when
   * one exists, else a fresh read from disk. Route handlers that mutate
   * session state must go through this — mutating a separately loaded copy
   * while a runner is alive loses writes in both directions.
   */
  sessionFor(id: string): StoredSession | null {
    const r = this.runners.get(id);
    if (r && !r.isClosed) return r.sessionRecord;
    return loadSession(id);
  }

  /**
   * Live runner for an active session, reviving via SDK resume if needed.
   * Revival is deliberately NOT done on SSE subscribe — only here, on explicit
   * user action — so a reconnecting EventSource can never respawn a failing
   * SDK subprocess in a loop.
   */
  runnerFor(id: string): LessonRunner {
    const existing = this.runners.get(id);
    if (existing && !existing.isClosed) return existing;

    const session = loadSession(id);
    if (!session) throw new Error(`no such lesson session '${id}'`);
    if (session.status === "abandoned") throw new Error("lesson was abandoned");
    const runner = new LessonRunner(session, (ev) => this.dispatch(id, ev), "revive");
    this.runners.set(id, runner);
    return runner;
  }

  /** Whether a live runner is working on a turn. No runner means nothing is. */
  turnInFlight(id: string): boolean {
    const r = this.runners.get(id);
    return !!r && r.turnInFlight;
  }

  health(id: string): RunnerHealth {
    const r = this.runners.get(id);
    const listeners = this.listenerCount(id);
    if (!r || r.isClosed) {
      return { alive: false, turnInFlight: false, queueLength: 0, msSinceLastMessage: -1, listeners };
    }
    return r.health(listeners);
  }

  /**
   * Replace a runner that has stopped making progress: close the old one
   * quietly (nothing it emits afterwards reaches clients), start a fresh one
   * on the same SDK session, and re-send the turn it was stuck on — to the
   * model only, so the transcript doesn't gain a duplicate.
   */
  kick(id: string): { requeued: string | null } {
    const old = this.runners.get(id);
    const before = old?.health(this.listenerCount(id)) ?? null;
    old?.close("kick", true);
    this.runners.delete(id);
    const session = loadSession(id);
    if (!session) throw new Error(`no such lesson session '${id}'`);
    if (session.status === "abandoned") throw new Error("lesson was abandoned");
    const runner = new LessonRunner(session, (ev) => this.dispatch(id, ev), "kick");
    this.runners.set(id, runner);
    const pending = lastUnansweredUser(session.transcript);
    if (pending) runner.requeue(pending);
    serverDiag(id, "kick", { before, requeued: pending?.id ?? null }, "anomaly");
    return { requeued: pending?.id ?? null };
  }

  abandon(id: string, reason = "learner"): void {
    const session = loadSession(id);
    this.runners.get(id)?.close(`abandon:${reason}`);
    this.runners.delete(id);
    if (session && session.status === "active") {
      session.status = "abandoned";
      saveSession(session);
      serverDiag(id, "abandoned", { reason, lastActivityAt: session.lastActivityAt }, reason === "learner" ? "info" : "anomaly");
    }
  }

  closeAll(): void {
    for (const r of this.runners.values()) r.close("shutdown");
    this.runners.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, runner] of this.runners) {
      if (runner.isClosed) this.runners.delete(id);
    }
    const expired = listSessions().filter(
      (s) => s.status === "active" && now - Date.parse(s.lastActivityAt) > SESSION_EXPIRY_MS
    );
    for (const s of expired) {
      serverDiag(null, "auto-abandon", { id: s.id, title: s.title, lastActivityAt: s.lastActivityAt }, "anomaly");
      this.abandon(s.id, "expired");
    }
  }
}
