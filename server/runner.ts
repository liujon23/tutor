// LessonRunner: one live Agent SDK session per active lesson.
// Streaming-input mode keeps the session alive across turns; the runner owns an
// input queue (user messages in) and a listener set (SSE events out). If the
// server restarts mid-lesson, the manager revives the runner with `resume` on
// the stored SDK session id — the transcript in the store covers the UI side.
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { checkFetchUrl, urlFromWebFetchInput } from "../core/url-guard.js";
import { ROOT } from "../scripts/lib.js";
import { saveInboundImage } from "./assets.js";
import { createTutorServer, COMMIT_TOOL_NAME } from "./tutor-tool.js";
import { appendTranscript, listSessions, loadSession, saveSession, touchSession } from "./store.js";
import { costDelta, usageFromResult } from "./usage.js";
import type { CommitResult, InboundImage, LessonEvent, StoredSession, TranscriptEntry } from "./types.js";

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

export class LessonRunner {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private q: Query;
  readonly startedAt = Date.now();
  // Per-turn accounting, reset on each `result`. `turnModel` is read from the
  // assistant message so a mid-lesson model switch is attributed correctly.
  private turnTools: string[] = [];
  private turnHadImage = false;
  private turnModel = "";
  // The SDK's `result.total_cost_usd` is cumulative for the whole SDK session
  // (not per-turn) — this tracks the last cumulative figure seen so each new
  // result can be turned into a per-turn delta (see costDelta in usage.ts).
  private lastCumulativeCost = 0;
  // Epoch ms of the learner's last real message — anchors the commit's "compose" timing
  // (how long the model spent building the patch after the learner's "go ahead").
  private lastUserTurnAt = Date.now();

  constructor(
    private session: StoredSession,
    private emit: (ev: LessonEvent) => void
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

    this.q = query({ prompt: this.input(), options });
    void this.consume();
  }

  /** Enqueue a user turn. `hidden` marks server-generated kickoff text.
   *  `modelText`, when given, is what the model receives — the transcript
   *  still persists `text` (used to ride machinery like the feedback hand-off
   *  along a short human-readable message). */
  send(text: string, hidden = false, images: InboundImage[] = [], modelText?: string): void {
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
    };
    appendTranscript(this.session, entry);
    if (!hidden) {
      // A real user turn (not the kickoff or the hidden feedback-flag handoff)
      // resets the compose clock, so it measures "go ahead" → commit.
      this.lastUserTurnAt = Date.now();
      this.emit({ type: "user", id: entry.id, text, ...(names.length ? { images: names } : {}) });
    }
    this.queue.push({
      type: "user",
      message: { role: "user", content: buildUserContent(modelText ?? text, images) },
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

  /** Stop the SDK session (input stream ends; query winds down after current work). */
  close(): void {
    if (this.closed) return;
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
      this.recordError((e as Error).message);
    } finally {
      this.closed = true;
      this.emit({ type: "closed" });
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          if (this.session.sdkSessionId !== msg.session_id) {
            this.session.sdkSessionId = msg.session_id;
            saveSession(this.session);
          }
          this.emit({ type: "ready", model: msg.model });
        }
        break;
      }
      case "stream_event": {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.emit({ type: "delta", text: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        if (msg.error) this.emit({ type: "api_error", error: msg.error });
        else this.clearError(); // a clean assistant turn means we recovered
        // The model that actually produced this turn (survives a mid-lesson switch).
        const model = (msg.message as { model?: string }).model;
        if (model) this.turnModel = model;
        const text = msg.message.content
          .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
          .join("");
        if (text.trim()) {
          const entry: TranscriptEntry = {
            role: "assistant",
            text,
            at: new Date().toISOString(),
          };
          appendTranscript(this.session, entry);
          this.emit({ type: "assistant", id: entry.id, text });
        }
        for (const b of msg.message.content) {
          if (b.type === "tool_use") {
            this.turnTools.push(b.name);
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
          },
          turnCost
        );
        const usage = (this.session.usage ??= []);
        usage.push(record);
        saveSession(this.session);
        // Reset per-turn accumulators for the next exchange.
        this.turnTools = [];
        this.turnHadImage = false;
        this.turnModel = "";
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
        this.emit({
          type: "rate_limit",
          status: msg.rate_limit_info.status,
          resetsAt: msg.rate_limit_info.resetsAt,
        });
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Manager: session records + live runners, with 24h auto-expiry.
// ---------------------------------------------------------------------------

const EXPIRY_MS = 24 * 60 * 60 * 1000;

export class LessonManager {
  private runners = new Map<string, LessonRunner>();
  // Listeners are keyed by session id and OUTLIVE runner instances, so an SSE
  // client that connected while the session was dormant still receives events
  // after a revival.
  private listeners = new Map<string, Set<(ev: LessonEvent) => void>>();

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

  private dispatch(id: string, ev: LessonEvent): void {
    for (const fn of this.listeners.get(id) ?? []) {
      try {
        fn(ev);
      } catch {
        /* a broken subscriber must not kill the lesson */
      }
    }
  }

  start(session: StoredSession, kickoff: string): LessonRunner {
    saveSession(session);
    const runner = new LessonRunner(session, (ev) => this.dispatch(session.id, ev));
    this.runners.set(session.id, runner);
    runner.send(kickoff, true);
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
    const runner = new LessonRunner(session, (ev) => this.dispatch(id, ev));
    this.runners.set(id, runner);
    return runner;
  }

  abandon(id: string): void {
    const session = loadSession(id);
    this.runners.get(id)?.close();
    this.runners.delete(id);
    if (session && session.status === "active") {
      session.status = "abandoned";
      saveSession(session);
    }
  }

  closeAll(): void {
    for (const r of this.runners.values()) r.close();
    this.runners.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, runner] of this.runners) {
      if (runner.isClosed) this.runners.delete(id);
    }
    const expired = listSessions().filter(
      (s) => s.status === "active" && now - Date.parse(s.lastActivityAt) > EXPIRY_MS
    );
    for (const s of expired) {
      this.abandon(s.id);
    }
  }
}
