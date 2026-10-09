// ---------------------------------------------------------------------------
// The drive-mode state machine: turn-taking for a spoken lesson.
//
// Everything in here is a rule about WHEN — when to speak, when to open the
// mic, when an answer is finished, when something has gone quiet for too
// long. Those rules are where this feature breaks, so they live in one
// deterministic machine that tests can drive event by event. Inputs are
// lesson SSE events, reconcile results, recogniser/synthesiser callbacks,
// taps and clock ticks, each stamped with `now`; outputs are actions for the
// adapter (speak, start the recogniser, submit, …). No browser API is touched
// and no clock is read.
//
// The rules (docs/drive-mode-plan.md, Turn-taking / Speaking / Controls):
// - Half-duplex. The mic opens only when the speech queue has drained AND the
//   turn is over (`turn_done`). Draining alone is not enough: a web-tool turn
//   drains after "Let me check that." and resumes after the tool runs.
// - The chunker is per message: flushed on that message's `assistant` event
//   (never fed `ev.text`), dropped at `turn_done`.
// - Skip drops everything received so far this turn, including the rest of a
//   message still streaming; later messages in the turn still speak.
// - Taps within `tapGuardMs` of a phase change are ignored: a Skip that lands
//   as speaking flips to listening must not become Done.
// - Every assistant entry after audio-on is spoken or explicitly skipped,
//   including ones that only arrive through a reconcile after an SSE gap.
// - Recoveries are spoken; everything else goes to the diag log (actions of
//   type "diag") and is read afterwards.
//
// IMPORTANT: may import only the other pure audio modules (text.ts,
// endpoint.ts) — never anything else under web/src/. See reconcile.ts for why.
// ---------------------------------------------------------------------------

import { createChunker, findSigils, type Chunk, type Chunker } from "./text.js";
import {
  DEFAULT_ENDPOINT,
  initialEndpoint,
  onDone,
  onFinal,
  onInterim,
  onRecognizerEnd,
  onTick,
  type EndpointConfig,
  type EndpointState,
  type EndpointStep,
  type SubmitTrace,
} from "./endpoint.js";

// --- config -----------------------------------------------------------------

export interface DriveConfig {
  endpoint: EndpointConfig;
  /** Ignore taps this soon after the tap target changed meaning. */
  tapGuardMs: number;
  /** Listening with no recogniser event at all for this long → restart it. */
  recWatchdogMs: number;
  /** Cold starts took 3.65s; a start that never reaches audiostart is stuck. */
  recStartTimeoutMs: number;
  /** Silence during a turn in flight before each "still working" cue. */
  stillWorkingMs: number;
  /** No turn progress for this long → ask the server for health (turns run to ~104s). */
  replyWatchdogMs: number;
  /** A submitted answer should be echoed as a `user` event within this. */
  echoTimeoutMs: number;
  /** Once heartbeats have been seen: no server event for this long → the stream is dead. */
  sseSilenceMs: number;
  /** Silence after which the audio route has gone to sleep and speech needs a lead-in tone. */
  leadInAfterMs: number;
  /** Speaking-rate estimate for utterance timeouts. */
  wordsPerSecond: number;
  /** An utterance gets 2× its estimate plus this before it's declared stalled. */
  utteranceSlackMs: number;
  /** Backoff for recogniser `network`/`audio-capture` errors. */
  recBackoffMs: number[];
}

export const DEFAULT_DRIVE: DriveConfig = {
  endpoint: DEFAULT_ENDPOINT,
  tapGuardMs: 400,
  recWatchdogMs: 30_000,
  recStartTimeoutMs: 8_000,
  stillWorkingMs: 20_000,
  replyWatchdogMs: 120_000,
  echoTimeoutMs: 10_000,
  sseSilenceMs: 60_000,
  leadInAfterMs: 1_500,
  wordsPerSecond: 2.6,
  utteranceSlackMs: 5_000,
  recBackoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
};

// --- spoken lines -------------------------------------------------------------

export const LINES = {
  starting: "Starting.",
  resuming: "Resuming.",
  micStalled: "The mic stalled. Listening again.",
  micUnavailable: "The microphone isn't available. Drive mode needs Safari, with microphone access allowed.",
  sendFailed: "That answer didn't reach the tutor. Please say it again.",
  kicking: "The tutor seems stuck. Restarting it.",
  stuck: "The tutor seems stuck. Tap to retry.",
  connectionLost: "Lost the connection. Reconnecting.",
  reconnected: "Reconnected.",
  closed: "The tutor's session closed. It will restart with your next answer.",
  committed: "The lesson is committed.",
  listeningSoon: "Listening in a moment.",
} as const;

export function stillWorkingLine(seconds: number): string {
  const s = Math.max(10, Math.round(seconds / 10) * 10);
  return `Still working, about ${s} seconds so far.`;
}

// --- inputs and actions --------------------------------------------------------

/** The slice of the server's LessonEvent this machine consumes (declared, not imported). */
export type LessonEventIn =
  | { type: "user"; id?: string; text: string }
  | { type: "delta"; id?: string; text: string }
  | { type: "assistant"; id?: string; text: string }
  | { type: "tool_use"; name: string }
  | { type: "turn_done"; isError: boolean; errors?: string[] }
  | { type: "committed" }
  | { type: "rate_limit"; status: string }
  | { type: "api_error"; error: string }
  | { type: "error"; message: string }
  | { type: "closed" }
  | { type: "heartbeat" }
  | { type: "ready" }
  | { type: "feedback_flag" };

export interface ReconcileEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface HealthReport {
  alive: boolean;
  turnInFlight: boolean;
  msSinceLastMessage: number;
}

export type DriveInput =
  | {
      type: "enable";
      now: number;
      /** Audio is unlocked (a tap is on the stack, or already unlocked one): go live. */
      fromGesture: boolean;
      knownIds: string[];
      turnInFlight: boolean;
      /** Say "Starting." (default). False when the tap that unlocked audio already said it. */
      announce?: boolean;
    }
  /** Stop and wait for a tap — e.g. while the pre-drive check uses the mic and speaker. */
  | { type: "pause"; now: number; reason: string }
  /** The server's word on whether a turn is running (asked when drive mode starts). */
  | { type: "turn_state"; now: number; turnInFlight: boolean; source: string }
  | { type: "disable"; now: number }
  | { type: "tap"; now: number }
  | { type: "again"; now: number }
  | { type: "visibility"; now: number; hidden: boolean }
  | { type: "event"; now: number; event: LessonEventIn }
  | { type: "reconcile"; now: number; entries: ReconcileEntry[]; turnInFlight?: boolean }
  | { type: "utterance_end"; now: number; gen: number }
  | { type: "utterance_error"; now: number; gen: number; error: string }
  | { type: "rec_audiostart"; now: number }
  | { type: "rec_interim"; now: number; text: string }
  | { type: "rec_final"; now: number; text: string; confidence?: number }
  | { type: "rec_end"; now: number }
  | { type: "rec_error"; now: number; error: string; message?: string }
  | { type: "send_result"; now: number; ok: boolean; error?: string }
  | { type: "health"; now: number; report: HealthReport | null }
  | { type: "tick"; now: number };

export type Cue = "turn-start" | "still-working" | "listening";
export type UtteranceKind = "tutor" | "system" | "replay";

export type DriveAction =
  | {
      type: "speak";
      gen: number;
      text: string;
      kind: UtteranceKind;
      /** Play the lead-in tone first: the output route has been idle. */
      leadIn: boolean;
      msgId?: string;
      md?: string;
    }
  | { type: "cancelSpeech" }
  | { type: "startRecognizer" }
  | { type: "stopRecognizer" }
  | { type: "abortRecognizer" }
  | { type: "cue"; cue: Cue }
  | { type: "submit"; text: string; trace: SubmitTrace }
  | { type: "checkHealth" }
  | { type: "kick" }
  | { type: "reconcile" }
  | { type: "reconnect" }
  | { type: "finished" }
  | { type: "diag"; level: "info" | "anomaly" | "invariant"; kind: string; detail?: unknown };

export type Mode = "off" | "paused" | "live" | "stuck" | "done";
export type Phase = "off" | "paused" | "speaking" | "listening" | "waiting" | "stuck" | "done";
export type RecState = "stopped" | "starting" | "running" | "stopping";

interface Utterance {
  text: string;
  kind: UtteranceKind;
  msgId?: string;
  md?: string;
}

interface Speaking extends Utterance {
  gen: number;
  startedAt: number;
  estMs: number;
}

interface Track {
  chunker: Chunker;
  /** Markdown characters of this message fed to the chunker so far. */
  consumed: number;
}

/** Deltas that arrive without a message id stream into this track. */
const NO_ID = "~stream";

export interface DriveSnapshot {
  mode: Mode;
  phase: Phase;
  turnInFlight: boolean;
  rec: RecState;
  listening: boolean;
  endpoint: EndpointState["phase"];
  heard: string;
  queued: number;
  speaking: string | null;
  committed: boolean;
}

// --- the machine ---------------------------------------------------------------

export class DriveMachine {
  private readonly cfg: DriveConfig;
  private out: DriveAction[] = [];

  private mode: Mode = "off";
  private phase: Phase = "off";
  private phaseChangedAt = 0;

  // Turn
  private turnInFlight = false;
  private turnStartedAt: number | null = null;
  private lastProgressAt = 0;
  private lastStillWorkingAt: number | null = null;
  private kickedThisTurn = false;
  /** An api_error was already spoken this turn — its turn_done needn't say it again. */
  private errorSaidThisTurn = false;
  private healthPending = false;
  private committed = false;
  private finishedSent = false;
  private pendingEcho: { text: string; at: number; warned: boolean } | null = null;

  // Speech
  private queue: Utterance[] = [];
  private speaking: Speaking | null = null;
  private gen = 0;
  private lastSpeechEndAt: number | null = null;

  // Streaming bookkeeping
  private tracks = new Map<string, Track>();
  private doneIds = new Set<string>();
  private skippedIds = new Set<string>();
  /** Assistant markdown since the learner's last turn — what Again replays. */
  private sinceUser: string[] = [];

  // Recogniser
  private rec: RecState = "stopped";
  private listening = false;
  private listenCued = false;
  private ep: EndpointState = initialEndpoint();
  private recStartAt = 0;
  private lastRecEventAt = 0;
  private recRetryAt: number | null = null;
  private recBackoffIdx = 0;
  private recStoppingSince: number | null = null;
  /** A half-said answer kept across an interruption (system line, stall, backgrounding). */
  private resumeBuffer: EndpointState | null = null;

  // Server stream
  private lastServerEventAt = 0;
  private sawHeartbeat = false;
  private saidConnectionLost = false;
  private lastRateStatus = "";

  constructor(cfg: Partial<DriveConfig> = {}) {
    this.cfg = { ...DEFAULT_DRIVE, ...cfg, endpoint: { ...DEFAULT_ENDPOINT, ...cfg.endpoint } };
  }

  get snapshot(): DriveSnapshot {
    return {
      mode: this.mode,
      phase: this.phase,
      turnInFlight: this.turnInFlight,
      rec: this.rec,
      listening: this.listening,
      endpoint: this.ep.phase,
      heard: [...this.ep.finals, this.ep.interim].filter(Boolean).join(" "),
      queued: this.queue.length,
      speaking: this.speaking?.text ?? null,
      committed: this.committed,
    };
  }

  dispatch(input: DriveInput): DriveAction[] {
    this.out = [];
    const now = input.now;
    switch (input.type) {
      case "enable":
        this.enable(input.fromGesture, input.knownIds, input.turnInFlight, input.announce ?? true, now);
        break;
      case "pause":
        this.pause(input.reason);
        break;
      case "turn_state":
        // Not an anomaly when it disagrees: drive mode starts out assuming a
        // turn is running (safer than opening the mic mid-turn) and this is
        // the answer to that assumption.
        this.diag("turn-state", { source: input.source, server: input.turnInFlight, assumed: this.turnInFlight });
        if (input.turnInFlight) {
          this.turnInFlight = true;
          this.startTurnClock(now);
        } else if (this.turnInFlight) {
          this.onTurnDone(false, undefined, now);
        }
        break;
      case "disable":
        this.disable(now);
        break;
      case "tap":
        this.tap(now);
        break;
      case "again":
        this.again(now);
        break;
      case "visibility":
        this.visibility(input.hidden, now);
        break;
      case "event":
        if (this.mode !== "off") this.event(input.event, now);
        break;
      case "reconcile":
        if (this.mode !== "off") this.reconcile(input.entries, input.turnInFlight, now);
        break;
      case "utterance_end":
        this.utteranceEnd(input.gen, now, null);
        break;
      case "utterance_error":
        this.utteranceEnd(input.gen, now, input.error);
        break;
      case "rec_audiostart":
        this.recAudioStart(now);
        break;
      case "rec_interim":
        this.lastRecEventAt = now;
        if (this.listening) this.applyEp(onInterim(this.ep, input.text, now), now);
        break;
      case "rec_final":
        this.recFinal(input.text, input.confidence, now);
        break;
      case "rec_end":
        this.recEnd(now);
        break;
      case "rec_error":
        this.recError(input.error, input.message, now);
        break;
      case "send_result":
        this.sendResult(input.ok, input.error, now);
        break;
      case "health":
        this.health(input.report, now);
        break;
      case "tick":
        this.tick(now);
        break;
    }
    if (this.mode !== "off") this.settle(now);
    this.updatePhase(now);
    return this.out;
  }

  // --- helpers -------------------------------------------------------------------

  private emit(a: DriveAction): void {
    this.out.push(a);
  }

  private diag(kind: string, detail?: unknown): void {
    this.emit({ type: "diag", level: "info", kind, detail });
  }

  private anomaly(kind: string, detail?: unknown): void {
    this.emit({ type: "diag", level: "anomaly", kind, detail });
  }

  private invariant(cond: boolean, name: string, detail?: unknown): boolean {
    if (!cond) this.emit({ type: "diag", level: "invariant", kind: name, detail });
    return cond;
  }

  /** A system line goes to the front of the queue — it's about what's happening now. */
  private say(text: string, why: string): void {
    this.diag("say", { why, text });
    this.queue.unshift({ text, kind: "system" });
  }

  private phaseOf(): Phase {
    switch (this.mode) {
      case "off":
      case "paused":
      case "stuck":
      case "done":
        return this.mode;
      case "live":
        if (this.speaking || this.queue.length) return "speaking";
        if (this.listening) return "listening";
        return "waiting";
    }
  }

  private updatePhase(now: number): void {
    const p = this.phaseOf();
    if (p !== this.phase) {
      this.diag("phase", { from: this.phase, to: p });
      this.phase = p;
      this.phaseChangedAt = now;
    }
  }

  // --- lifecycle -------------------------------------------------------------------

  private enable(fromGesture: boolean, knownIds: string[], turnInFlight: boolean, announce: boolean, now: number): void {
    // Everything already on screen when audio came on is history, not news.
    for (const id of knownIds) this.doneIds.add(id);
    this.turnInFlight = turnInFlight;
    if (turnInFlight) this.startTurnClock(now);
    this.lastServerEventAt = now;
    this.diag("enable", { fromGesture, known: knownIds.length, turnInFlight, announce });
    if (fromGesture) {
      this.mode = "live";
      // Spoken synchronously inside the tap: this is what unlocks iOS speech.
      if (announce) this.speakNow({ text: LINES.starting, kind: "system" }, now);
    } else {
      this.mode = "paused";
    }
  }

  /** Stop speaking and listening and wait for a tap, keeping the queue (like backgrounding). */
  private pause(reason: string): void {
    this.diag("pause", { reason });
    if (this.mode !== "live") return;
    if (this.speaking) {
      const { text, kind, msgId, md } = this.speaking;
      this.queue.unshift({ text, kind, msgId, md });
    }
    this.cancelSpeech();
    this.stopListening();
    this.mode = "paused";
  }

  private disable(now: number): void {
    this.diag("disable");
    this.cancelSpeech();
    this.stopListening();
    this.queue = [];
    this.tracks.clear();
    this.mode = "off";
    void now;
  }

  private visibility(hidden: boolean, now: number): void {
    this.diag("visibility", { hidden });
    if (!hidden || this.mode !== "live") return;
    // No auto-resume: a phone call breaks the gesture chain and kills speech,
    // so coming back needs one tap. Re-speak the interrupted chunk on resume.
    this.pause("hidden");
    void now;
  }

  // --- taps ---------------------------------------------------------------------------

  private tap(now: number): void {
    const since = now - this.phaseChangedAt;
    if (since < this.cfg.tapGuardMs && this.phase !== "off") {
      this.diag("tap-ignored", { phase: this.phase, sinceMs: since });
      return;
    }
    this.diag("tap", { phase: this.phase, sinceMs: since });
    switch (this.phase) {
      case "off":
        return;
      case "paused":
        this.mode = "live";
        this.speakNow({ text: LINES.resuming, kind: "system" }, now);
        return;
      case "speaking":
        this.skip(now);
        return;
      case "listening": {
        const step = onDone(this.ep, now, this.cfg.endpoint);
        if (!step.action) this.diag("done-empty", { heard: this.snapshot.heard });
        this.applyEp(step, now);
        return;
      }
      case "waiting":
        this.speakNow(
          {
            text: this.turnInFlight
              ? stillWorkingLine((now - (this.turnStartedAt ?? now)) / 1000)
              : LINES.listeningSoon,
            kind: "system",
          },
          now
        );
        return;
      case "stuck":
        this.mode = "live";
        this.kickedThisTurn = false;
        this.lastProgressAt = now;
        this.dropCutOffMessages();
        this.emit({ type: "kick" });
        this.diag("kick", { by: "tap" });
        return;
      case "done":
        this.speakNow({ text: LINES.committed, kind: "system" }, now);
        return;
    }
  }

  /** Skip: drop everything received so far this turn, including the rest of a streaming message. */
  private skip(now: number): void {
    const dropped = this.queue.length + (this.speaking ? 1 : 0);
    const ids = [...this.tracks.keys()];
    for (const id of ids) {
      this.skippedIds.add(id);
      this.doneIds.add(id);
    }
    this.tracks.clear();
    this.queue = this.queue.filter((u) => u.kind === "system");
    if (this.speaking?.kind !== "system") this.cancelSpeech();
    this.diag("skip", { dropped, messages: ids });
    void now;
  }

  /**
   * A kick replaces the runner mid-reply: the message it was streaming will
   * never finish (seen live — its deltas' id never reached the transcript),
   * and the new runner answers from the start. Drop what's left of it, or its
   * buffered tail would be spoken at turn_done ahead of the fresh reply.
   */
  private dropCutOffMessages(): void {
    const ids = [...this.tracks.keys()];
    if (!ids.length) return;
    for (const id of ids) {
      this.skippedIds.add(id);
      this.doneIds.add(id);
    }
    this.tracks.clear();
    this.queue = this.queue.filter((u) => !(u.msgId && ids.includes(u.msgId)));
    this.diag("cut-off-dropped", { messages: ids });
  }

  private again(now: number): void {
    if (this.mode !== "live") return;
    const md = this.sinceUser.join("\n\n");
    if (!md.trim()) {
      this.diag("again-empty");
      return;
    }
    this.cancelSpeech();
    this.stopListening();
    const c = createChunker();
    const chunks = [...c.push(md), ...c.flush()];
    this.queue = [...this.queue.filter((u) => u.kind === "system"), ...chunks.filter((k) => k.text).map((k) => ({ text: k.text, kind: "replay" as const, md: k.md }))];
    this.diag("again", { chunks: chunks.length });
    void now;
  }

  // --- lesson events ----------------------------------------------------------------------

  private event(ev: LessonEventIn, now: number): void {
    this.lastServerEventAt = now;
    if (this.saidConnectionLost) {
      this.saidConnectionLost = false;
      this.say(LINES.reconnected, "stream-back");
    }
    switch (ev.type) {
      case "heartbeat":
        this.sawHeartbeat = true;
        return;
      case "user":
        this.onUserEvent(ev.text, now);
        return;
      case "delta":
        this.markProgress(now);
        this.onDelta(ev.id, ev.text);
        return;
      case "assistant":
        this.markProgress(now);
        this.onAssistant(ev.id, ev.text);
        return;
      case "tool_use":
        this.markProgress(now);
        this.diag("tool", { name: ev.name });
        return;
      case "turn_done":
        this.onTurnDone(ev.isError, ev.errors, now);
        return;
      case "committed":
        this.committed = true;
        this.diag("committed");
        return;
      case "rate_limit":
        if ((ev.status === "rejected" || ev.status === "allowed_warning") && ev.status !== this.lastRateStatus) {
          this.say(
            ev.status === "rejected"
              ? "Your Claude usage limit is used up for now. Switch to Sonnet, or stop here."
              : "Your Claude usage limit is nearly used up.",
            "rate-limit"
          );
        }
        this.diag("rate_limit", { status: ev.status });
        this.lastRateStatus = ev.status;
        return;
      case "api_error":
        this.errorSaidThisTurn = true;
        this.say(`The tutor hit an error: ${spokenError(ev.error)}.`, "api_error");
        return;
      case "error":
        this.say(`Something went wrong: ${spokenError(ev.message)}.`, "error");
        this.endTurn(now, "error");
        return;
      case "closed":
        this.diag("runner-closed", { turnInFlight: this.turnInFlight });
        if (this.turnInFlight) this.say(LINES.closed, "closed");
        this.endTurn(now, "closed");
        return;
      default:
        return;
    }
  }

  private onUserEvent(text: string, now: number): void {
    // A new learner turn — ours echoing back, or one typed on another device.
    if (this.pendingEcho && this.pendingEcho.text === text.trim()) {
      this.diag("echo", { ms: now - this.pendingEcho.at });
      this.pendingEcho = null;
    } else {
      this.diag("user-elsewhere");
      // Someone else answered: whatever we were collecting is moot.
      if (this.listening) {
        this.diag("listening-abandoned", { heard: this.snapshot.heard });
        this.stopListening();
      }
      this.resumeBuffer = null; // that half-said answer belongs to a turn that's gone
    }
    this.sinceUser = [];
    this.turnInFlight = true;
    this.startTurnClock(now);
  }

  private trackFor(id: string | undefined): [string, Track] {
    const key = id ?? NO_ID;
    let t = this.tracks.get(key);
    if (!t) {
      t = { chunker: createChunker(), consumed: 0 };
      this.tracks.set(key, t);
    }
    return [key, t];
  }

  private onDelta(id: string | undefined, text: string): void {
    this.turnInFlight = true;
    if (id && (this.skippedIds.has(id) || this.doneIds.has(id))) return;
    if (!id && this.skippedIds.has(NO_ID)) return;
    const [key, track] = this.trackFor(id);
    if (!id && track.consumed === 0) this.anomaly("delta-without-id");
    track.consumed += text.length;
    this.enqueue(track.chunker.push(text), key);
  }

  private onAssistant(id: string | undefined, text: string): void {
    this.turnInFlight = true;
    this.sinceUser.push(text);
    const key = id ?? NO_ID;
    // Id-less deltas belong to this message: adopt them under its id.
    if (id && !this.tracks.has(id) && this.tracks.has(NO_ID)) {
      this.tracks.set(id, this.tracks.get(NO_ID)!);
      this.tracks.delete(NO_ID);
    }
    if (id && this.skippedIds.has(NO_ID)) {
      this.skippedIds.delete(NO_ID);
      this.skippedIds.add(id);
    }
    if (this.skippedIds.has(key) || (id && this.doneIds.has(id))) {
      this.tracks.delete(key);
      if (id) this.doneIds.add(id);
      this.diag("assistant-skipped", { id });
      return;
    }
    this.finishMessage(key, text, "assistant");
    if (id) this.doneIds.add(id);
  }

  /**
   * The full text of a message is known: speak whatever of it the stream
   * didn't deliver, then flush. Never re-speaks the part already fed.
   */
  private finishMessage(key: string, text: string, via: "assistant" | "reconcile"): void {
    const [, track] = this.trackFor(key === NO_ID ? undefined : key);
    const got = track.chunker.received;
    if (track.consumed > 0 && got !== text.slice(0, got.length)) {
      // What streamed isn't a prefix of the final text — log it, and don't
      // guess at an offset (speaking the tail could repeat or garble).
      this.anomaly("stream-mismatch", { id: key, via, streamed: got.length, final: text.length });
    } else if (track.consumed < text.length) {
      if (track.consumed === 0 && via === "assistant") this.anomaly("no-deltas", { id: key });
      else {
        this.diag("fill-gap", { id: key, via, from: track.consumed, to: text.length });
      }
      this.enqueue(track.chunker.push(text.slice(track.consumed)), key);
      track.consumed = text.length;
    }
    this.enqueue(track.chunker.flush(), key);
    this.tracks.delete(key);
  }

  private enqueue(chunks: Chunk[], msgId: string): void {
    for (const c of chunks) {
      if (c.notes.length) this.diag("speech-notes", { msgId, notes: c.notes });
      const sig = findSigils(c.text);
      this.invariant(sig.length === 0, "sigil-in-speech", { msgId, sigils: sig, text: c.text });
      if (!c.text) continue;
      this.queue.push({ text: c.text, kind: "tutor", msgId, md: c.md });
    }
  }

  private onTurnDone(isError: boolean, errors: string[] | undefined, now: number): void {
    // Messages that never got their `assistant` event: flush what we have.
    for (const key of [...this.tracks.keys()]) {
      this.anomaly("unflushed-at-turn-done", { id: key });
      this.enqueue(this.tracks.get(key)!.chunker.flush(), key);
      this.tracks.delete(key);
    }
    // A failed request already said why (api_error); one line per failure.
    if (isError && !this.errorSaidThisTurn) {
      this.say(`That turn failed: ${spokenError(errors?.[0] ?? "unknown error")}.`, "turn-error");
    }
    this.endTurn(now, "turn_done");
  }

  private endTurn(now: number, why: string): void {
    if (this.turnInFlight) {
      this.diag("turn-end", { why, ms: this.turnStartedAt === null ? null : now - this.turnStartedAt });
    }
    this.turnInFlight = false;
    this.turnStartedAt = null;
    this.lastStillWorkingAt = null;
    this.kickedThisTurn = false;
    this.errorSaidThisTurn = false;
    this.healthPending = false;
    this.skippedIds.clear();
  }

  private startTurnClock(now: number): void {
    this.turnStartedAt ??= now;
    this.lastProgressAt = now;
  }

  private markProgress(now: number): void {
    this.lastProgressAt = now;
    if (this.turnStartedAt === null) this.turnStartedAt = now;
  }

  // --- reconcile ------------------------------------------------------------------------

  private reconcile(entries: ReconcileEntry[], turnInFlight: boolean | undefined, now: number): void {
    let spoke = 0;
    for (const e of entries) {
      if (e.role === "user") {
        if (this.pendingEcho && this.pendingEcho.text === e.text.trim()) this.pendingEcho = null;
        this.sinceUser = [];
        continue;
      }
      if (this.doneIds.has(e.id)) continue;
      this.sinceUser.push(e.text);
      // A half-streamed message resumes from where the stream left off.
      const key = this.tracks.has(e.id) ? e.id : this.tracks.has(NO_ID) ? NO_ID : e.id;
      if (key === NO_ID) {
        this.tracks.set(e.id, this.tracks.get(NO_ID)!);
        this.tracks.delete(NO_ID);
      }
      this.finishMessage(e.id, e.text, "reconcile");
      this.doneIds.add(e.id);
      spoke++;
    }
    this.diag("reconcile", { entries: entries.length, spoke, turnInFlight });
    if (turnInFlight === false && this.turnInFlight) {
      // The stream dropped the turn's end; the server says it's over.
      this.anomaly("missed-turn-done");
      this.onTurnDone(false, undefined, now);
    } else if (turnInFlight === true) {
      this.turnInFlight = true;
      this.startTurnClock(now);
    }
  }

  // --- speech -----------------------------------------------------------------------------

  private speakNow(u: Utterance, now: number): void {
    // Anything else speaking is superseded; this runs inside the current dispatch
    // (i.e. synchronously inside a tap, which iOS requires for the first speak).
    if (this.speaking) {
      this.queue.unshift({ ...this.speaking });
      this.cancelSpeech();
    }
    this.stopListening();
    this.startUtterance(u, now);
  }

  private startUtterance(u: Utterance, now: number): void {
    const gen = ++this.gen;
    const words = u.text.split(/\s+/).filter(Boolean).length;
    const estMs = Math.round((words / this.cfg.wordsPerSecond) * 1000);
    const leadIn = this.lastSpeechEndAt === null || now - this.lastSpeechEndAt >= this.cfg.leadInAfterMs;
    this.invariant(this.rec === "stopped" || this.rec === "stopping", "speak-while-recognizing", { rec: this.rec });
    this.speaking = { ...u, gen, startedAt: now, estMs };
    this.emit({ type: "speak", gen, text: u.text, kind: u.kind, leadIn, msgId: u.msgId, md: u.md });
  }

  private cancelSpeech(): void {
    if (!this.speaking) return;
    // Bump the generation so the cancelled utterance's late end/error is ignored.
    this.gen++;
    this.speaking = null;
    this.emit({ type: "cancelSpeech" });
  }

  private utteranceEnd(gen: number, now: number, error: string | null): void {
    if (!this.speaking || gen !== this.speaking.gen) {
      this.diag("stale-utterance-event", { gen, current: this.speaking?.gen ?? null, error });
      return;
    }
    const s = this.speaking;
    if (error) this.anomaly("utterance-error", { gen, error, text: s.text });
    this.diag("spoken", { gen, kind: s.kind, msgId: s.msgId, estMs: s.estMs, actualMs: now - s.startedAt });
    this.speaking = null;
    this.lastSpeechEndAt = now;
  }

  // --- recogniser --------------------------------------------------------------------------

  private startListening(now: number): void {
    this.listening = true;
    this.listenCued = false;
    this.ep = initialEndpoint();
    this.diag("listen");
    this.startRecognizer(now);
  }

  private startRecognizer(now: number): void {
    if (this.recRetryAt !== null && now < this.recRetryAt) return; // backing off
    if (!this.invariant(this.rec === "stopped", "start-while-recognizing", { rec: this.rec })) return;
    this.invariant(!this.speaking, "listen-while-speaking");
    this.invariant(!this.turnInFlight, "listen-during-turn");
    this.rec = "starting";
    this.recStartAt = now;
    this.lastRecEventAt = now;
    this.recRetryAt = null;
    this.emit({ type: "startRecognizer" });
  }

  private stopListening(): void {
    if (this.listening && this.ep.phase === "hearing") this.resumeBuffer = keepHeard(this.ep);
    this.listening = false;
    if (this.rec === "starting" || this.rec === "running") {
      this.rec = "stopping";
      this.emit({ type: "stopRecognizer" });
    }
  }

  private recAudioStart(now: number): void {
    this.lastRecEventAt = now;
    this.diag("rec-audiostart", { latencyMs: now - this.recStartAt });
    if (this.rec === "starting") this.rec = "running";
    this.recBackoffIdx = 0;
    if (this.listening && this.ep.phase === "hearing" && this.ep.lastActivityAt === null) {
      this.ep = { ...this.ep, lastActivityAt: now }; // a resumed answer's clock starts now
    }
    // Cue on audiostart, not start(): a cold start took 3.65s, and words
    // spoken before audiostart are lost. Once per answer, not per restart.
    if (this.listening && !this.listenCued) {
      this.listenCued = true;
      this.emit({ type: "cue", cue: "listening" });
    }
  }

  private recFinal(text: string, confidence: number | undefined, now: number): void {
    this.lastRecEventAt = now;
    if (!this.listening) {
      this.diag("late-final", { text, confidence });
      return;
    }
    this.diag("rec-final", { text, confidence });
    this.applyEp(onFinal(this.ep, text, now), now);
  }

  private recEnd(now: number): void {
    this.lastRecEventAt = now;
    this.diag("rec-end", { sessionMs: now - this.recStartAt });
    this.rec = "stopped";
    if (!this.listening) return;
    const step = onRecognizerEnd(this.ep, now);
    if (step.promoted) this.diag("interim-promoted", { text: step.state.finals[step.state.finals.length - 1] });
    this.applyEp(step, now);
    // "The recogniser gave up", not "the learner finished": go again.
    if (this.listening && (this.ep.phase === "idle" || this.ep.phase === "hearing")) this.startRecognizer(now);
  }

  private recError(error: string, message: string | undefined, now: number): void {
    this.lastRecEventAt = now;
    // no-speech and aborted are the normal end path with continuous=false
    // (iOS reports silence as aborted/"No speech detected"). Not errors.
    if (error === "no-speech" || error === "aborted") {
      this.diag("rec-quiet-end", { error, message });
      return;
    }
    if (error === "not-allowed" || error === "service-not-allowed") {
      this.anomaly("rec-not-allowed", { error, message });
      this.stopListening();
      this.rec = "stopped";
      // Spoken directly: once paused, nothing drains the queue.
      this.diag("say", { why: "not-allowed", text: LINES.micUnavailable });
      this.speakNow({ text: LINES.micUnavailable, kind: "system" }, now);
      this.mode = "paused";
      return;
    }
    // network, audio-capture, a start() that threw, anything unknown: back off.
    const delay = this.cfg.recBackoffMs[Math.min(this.recBackoffIdx, this.cfg.recBackoffMs.length - 1)];
    this.recBackoffIdx++;
    this.recRetryAt = now + delay;
    if (error === "start-threw") this.rec = "stopped";
    this.anomaly("rec-error", { error, message, retryInMs: delay });
  }

  private applyEp(step: EndpointStep, now: number): void {
    this.ep = step.state;
    const a = step.action;
    if (!a) return;
    if (a.type === "flush") {
      this.diag("ep-flush", { heard: this.snapshot.heard });
      if (this.rec === "starting" || this.rec === "running") {
        this.rec = "stopping";
        this.emit({ type: "stopRecognizer" });
      }
      return;
    }
    // submit
    const ok = this.invariant(a.text.trim() !== "", "empty-submit", a.trace);
    this.invariant(!this.turnInFlight, "submit-during-turn", { text: a.text });
    this.listening = false;
    if (this.rec === "starting" || this.rec === "running") {
      this.rec = "stopping";
      this.emit({ type: "stopRecognizer" });
    }
    if (!ok) return;
    this.diag("ep-submit", { text: a.text, ...a.trace });
    this.emit({ type: "submit", text: a.text, trace: a.trace });
    this.emit({ type: "cue", cue: "turn-start" });
    this.pendingEcho = { text: a.text.trim(), at: now, warned: false };
    this.sinceUser = [];
    this.turnInFlight = true;
    this.turnStartedAt = now;
    this.lastProgressAt = now;
    this.lastStillWorkingAt = null;
  }

  private sendResult(ok: boolean, error: string | undefined, now: number): void {
    if (ok) {
      this.diag("send-ok");
      return;
    }
    this.anomaly("send-failed", { error });
    this.pendingEcho = null;
    this.endTurn(now, "send-failed");
    this.say(LINES.sendFailed, "send-failed");
  }

  private health(report: HealthReport | null, now: number): void {
    this.healthPending = false;
    this.diag("health", report ?? { unreachable: true });
    if (!report) {
      // Couldn't even reach the server: that's the connection, not the runner.
      if (!this.saidConnectionLost) {
        this.saidConnectionLost = true;
        this.say(LINES.connectionLost, "health-unreachable");
        this.emit({ type: "reconnect" });
      }
      this.lastProgressAt = now;
      return;
    }
    if (!report.turnInFlight && this.turnInFlight) {
      // The server finished the turn; the stream lost the ending.
      this.anomaly("missed-turn-done", { via: "health" });
      this.emit({ type: "reconcile" });
      this.lastProgressAt = now;
      return;
    }
    if (report.alive && report.msSinceLastMessage < this.cfg.replyWatchdogMs) {
      // Still making progress server-side; the stream just hasn't shown it.
      this.lastProgressAt = now - report.msSinceLastMessage;
      return;
    }
    if (!this.kickedThisTurn) {
      this.kickedThisTurn = true;
      this.lastProgressAt = now;
      this.dropCutOffMessages();
      this.say(LINES.kicking, "kick");
      this.emit({ type: "kick" });
      this.diag("kick", { by: "watchdog", report });
      return;
    }
    this.anomaly("stuck-after-kick", { report });
    this.cancelSpeech();
    this.stopListening();
    this.queue = [];
    this.mode = "stuck";
    this.startUtterance({ text: LINES.stuck, kind: "system" }, now);
  }

  // --- the clock -------------------------------------------------------------------------------

  private tick(now: number): void {
    if (this.mode === "off") return;

    // Utterance stalled: iOS's documented failure is a queue that just stops.
    if (this.speaking) {
      const limit = this.speaking.estMs * 2 + this.cfg.utteranceSlackMs;
      if (now - this.speaking.startedAt > limit) {
        this.anomaly("utterance-timeout", { gen: this.speaking.gen, estMs: this.speaking.estMs, text: this.speaking.text });
        this.cancelSpeech();
        this.lastSpeechEndAt = now;
      }
    }

    // A stop that never produced `end` would block listening for good.
    if (this.rec === "stopping") {
      this.recStoppingSince ??= now;
      if (now - this.recStoppingSince >= 3_000) {
        this.anomaly("rec-stop-timeout", { ms: now - this.recStoppingSince });
        this.emit({ type: "abortRecognizer" });
        this.rec = "stopped";
        this.recStoppingSince = null;
      }
    } else {
      this.recStoppingSince = null;
    }

    if (this.mode !== "live") return;

    // Endpointer clocks.
    if (this.listening) this.applyEp(onTick(this.ep, now, this.cfg.endpoint), now);

    // Recogniser watchdog: onresult can stop with neither onerror nor onend.
    if (this.listening && (this.rec === "running" || this.rec === "starting")) {
      const quiet = now - this.lastRecEventAt;
      const limit = this.rec === "starting" ? this.cfg.recStartTimeoutMs : this.cfg.recWatchdogMs;
      if (quiet >= limit) {
        this.anomaly("rec-watchdog", { rec: this.rec, quietMs: quiet });
        this.emit({ type: "abortRecognizer" });
        this.rec = "stopped";
        // Re-opened after the spoken notice drains; a half-said answer is kept.
        if (this.ep.phase === "hearing") this.resumeBuffer = keepHeard(this.ep);
        this.listening = false;
        this.say(LINES.micStalled, "rec-watchdog");
      }
    }

    // A recogniser in backoff comes back when its time is up.
    if (this.listening && this.rec === "stopped" && this.recRetryAt !== null && now >= this.recRetryAt) {
      this.recRetryAt = null;
      this.startRecognizer(now);
    }

    // The answer should echo back as a `user` event.
    if (this.pendingEcho && !this.pendingEcho.warned && now - this.pendingEcho.at >= this.cfg.echoTimeoutMs) {
      this.pendingEcho.warned = true;
      this.anomaly("no-echo", { text: this.pendingEcho.text, ms: now - this.pendingEcho.at });
    }

    // Turn in flight and nothing to say: a cue so silence doesn't read as broken.
    if (this.turnInFlight && !this.speaking && this.queue.length === 0) {
      const since = Math.max(this.turnStartedAt ?? now, this.lastSpeechEndAt ?? 0, this.lastStillWorkingAt ?? 0);
      if (now - since >= this.cfg.stillWorkingMs) {
        this.lastStillWorkingAt = now;
        this.emit({ type: "cue", cue: "still-working" });
      }
    }

    // Reply watchdog: ask before acting — a re-POST would duplicate the turn.
    if (this.turnInFlight && !this.healthPending && now - this.lastProgressAt >= this.cfg.replyWatchdogMs) {
      this.healthPending = true;
      this.diag("reply-watchdog", { quietMs: now - this.lastProgressAt });
      this.emit({ type: "checkHealth" });
    }

    // Stream liveness — only once the server has shown it sends heartbeats.
    if (this.sawHeartbeat && !this.saidConnectionLost && now - this.lastServerEventAt >= this.cfg.sseSilenceMs) {
      this.saidConnectionLost = true;
      this.anomaly("sse-silent", { ms: now - this.lastServerEventAt });
      this.say(LINES.connectionLost, "sse-silent");
      this.emit({ type: "reconnect" });
    }
  }

  // --- settle: what should be happening now ----------------------------------------------------

  private settle(now: number): void {
    if (this.mode !== "live" && this.mode !== "stuck") return;
    // Speak next, one utterance at a time.
    if (!this.speaking && this.queue.length) {
      if (this.listening) this.stopListening();
      if (this.mode === "live" || this.queue[0].kind === "system") {
        this.startUtterance(this.queue.shift()!, now);
      }
      return;
    }
    if (this.mode !== "live" || this.speaking) return;
    // Done: committed, turn over, nothing left to say.
    if (this.committed && !this.turnInFlight) {
      if (!this.finishedSent) {
        this.finishedSent = true;
        this.mode = "done";
        this.stopListening();
        this.diag("finished");
        this.emit({ type: "finished" });
      }
      return;
    }
    // Half-duplex: the mic opens only when the queue is drained AND the turn is over.
    if (!this.turnInFlight && !this.listening && this.rec === "stopped") {
      this.startListening(now);
      if (this.resumeBuffer) {
        // The silence clock restarts when the mic is actually back (audiostart),
        // or the interruption itself would count as the learner going quiet.
        this.ep = { ...this.resumeBuffer, lastActivityAt: null };
        this.resumeBuffer = null;
        this.diag("listen-resumed-buffer", { heard: this.snapshot.heard });
      }
    }
  }
}

/**
 * A half-said answer, set aside while something interrupts listening. Its
 * interim is promoted to a final: the next recogniser session starts fresh,
 * and its first interim would otherwise overwrite those words.
 */
function keepHeard(ep: EndpointState): EndpointState {
  const interim = ep.interim.trim();
  return interim ? { ...ep, finals: [...ep.finals, interim], interim: "" } : ep;
}

/** Make an error string sayable: short, no codes shouted in capitals. */
export function spokenError(raw: string): string {
  switch (raw) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "authentication failed on the host PC";
    case "rate_limit":
      return "the usage limit";
    case "billing_error":
      return "a billing problem";
    case "overloaded":
      return "the model is overloaded";
    default: {
      const t = raw.replace(/[_`*#|\\^$]/g, " ").replace(/\s+/g, " ").trim();
      return t.length > 120 ? `${t.slice(0, 117)}…` : t;
    }
  }
}
