// ---------------------------------------------------------------------------
// Drive mode's controller: the glue between the lesson screen, the drive
// state machine (decisions), the adapter (browser audio), the overlay (DOM)
// and the diagnostics log. It owns no rules of its own — those live in
// drive-state.ts — only wiring, timers, storage and uploads.
//
// Hung on LessonCtx as one opaque field, `audio` (docs/drive-mode.md).
// ---------------------------------------------------------------------------

import { api } from "../../api.js";
import type { LessonEvent, StreamStatus, TranscriptEntry } from "../../api.js";
import type { LessonCtx } from "../ctx.js";
import { sendTurn } from "../send.js";
import { DriveMachine, lastTutorTurn, type DriveAction, type DriveInput, type LessonEventIn } from "./drive-state.js";
import { createDiag, parseStoredBatches, type Diag, type DiagBatch } from "./diag.js";
import { audioAdapter, probes, type SpeechSettings } from "./adapter.js";
import { DrivePanel } from "./panel.js";

/** What the lesson screen talks to. */
export interface AudioController {
  onEvent(ev: LessonEvent): void;
  onReconcile(entries: TranscriptEntry[], turnInFlight: boolean | undefined): void;
  onStreamStatus(status: StreamStatus, detail?: unknown): void;
  stop(): void;
}

/**
 * How drive mode is starting:
 * - "tap": the headphones button — this call is inside the tap.
 * - "after-select": the select screen's Start tap already unlocked audio and said "Starting.".
 * - "restore": a reload found drive mode on; audio is locked until the next tap.
 */
export type DriveStart = "tap" | "after-select" | "restore";

export interface DriveDeps {
  reconnect(): void;
  reconcile(): Promise<void>;
  /** The overlay's "Exit drive mode" closed it; the lesson stays open in text. */
  onExit(): void;
}

// --- per-device storage (every access guarded: private mode and the like throw) --------

const DRIVE_KEY = "tutor.drive";
// v2: a fresh start when the defaults changed to Samantha with tones on, so
// the settings saved during the first run's voice tour (tones off) don't stick.
const SETTINGS_KEY = "tutor.voice.v2";
const LISTEN_KEY = "tutor.listen";
const DIAG_PREFIX = "tutor.diag.";
/** Unsent diag held on the phone is capped; the oldest batches go first. */
const MAX_STORED_DIAG_CHARS = 2_000_000;

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — nothing to do */
  }
}

/** The select screen's Listen toggle, remembered on this device. */
export function listenPreference(): boolean {
  return readStore(LISTEN_KEY) === "1";
}
export function setListenPreference(on: boolean): void {
  writeStore(LISTEN_KEY, on ? "1" : null);
}

/** A lesson that was in drive mode when the page went away (reload-on-resume). */
export function pendingDriveLesson(maxAgeMs = 12 * 60 * 60 * 1000): string | null {
  const raw = readStore(DRIVE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { lessonId?: string; at?: number };
    if (typeof v.lessonId === "string" && typeof v.at === "number" && Date.now() - v.at < maxAgeMs) return v.lessonId;
  } catch {
    /* fall through */
  }
  writeStore(DRIVE_KEY, null);
  return null;
}
export function clearPendingDrive(): void {
  writeStore(DRIVE_KEY, null);
}

function loadSettings(): SpeechSettings {
  writeStore("tutor.voice", null); // the v1 key — see SETTINGS_KEY
  try {
    const v = JSON.parse(readStore(SETTINGS_KEY) ?? "{}") as Partial<SpeechSettings>;
    return {
      voiceURI: typeof v.voiceURI === "string" ? v.voiceURI : null,
      rate: typeof v.rate === "number" ? v.rate : 1,
      tones: v.tones !== false,
      // Absent in settings saved before 2026-10-10: on, like a fresh device.
      sessionPlayback: v.sessionPlayback !== false,
    };
  } catch {
    return { voiceURI: null, rate: 1, tones: true, sessionPlayback: true };
  }
}

const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the controller ---------------------------------------------------------------------

export class DriveController implements AudioController {
  private machine = new DriveMachine();
  private diag: Diag;
  private panel: DrivePanel;
  private queue: DriveInput[] = [];
  private dispatching = false;
  /** Set while handling a tap, so the adapter speaks synchronously (iOS gesture rule). */
  private inTap = false;
  private stopped = false;
  private checking = false;
  private checkLines: string[] = [];
  private lastHeartbeatAt = 0;
  private ticks = 0;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private readonly onVisibility = () => this.visibility();
  private readonly onPageHide = () => this.beaconFlush("pagehide");

  constructor(
    private ctx: LessonCtx,
    private deps: DriveDeps
  ) {
    const settings = loadSettings();
    audioAdapter.configure(settings);
    this.diag = createDiag({
      now,
      build: __BUILD_ID__,
      session: ctx.id,
      state: () => this.machine.snapshot.phase,
    });
    audioAdapter.bind({
      input: (i) => this.dispatch(i),
      log: (kind, detail, level) => (level === "anomaly" ? this.diag.anomaly(kind, detail) : this.diag.log(kind, detail)),
    });
    this.panel = new DrivePanel(
      {
        tap: () => this.tap(),
        again: () => {
          // Again from paused resumes too, and this tap is what re-unlocks audio.
          if (this.machine.snapshot.phase === "paused") {
            audioAdapter.unlock();
            void audioAdapter.acquireWakeLock();
          }
          this.withTap(() => this.dispatch({ type: "again", now: now() }));
        },
        exit: () => this.exit(),
        check: () => void this.check(),
        settings: (s) => this.applySettings(s),
      },
      __BUILD_ID__,
      settings
    );
    this.restoreStoredDiag();
  }

  // --- lifecycle --------------------------------------------------------------------------

  /** For "tap", call synchronously inside the tap handler. */
  start(how: DriveStart): void {
    this.panel.mount();
    if (how === "tap") {
      audioAdapter.unlock();
      void audioAdapter.acquireWakeLock();
    }
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    this.diag.log("drive-start", { how, navigation: nav?.type ?? null, probes: probes() });
    writeStore(DRIVE_KEY, JSON.stringify({ lessonId: this.ctx.id, at: Date.now() }));

    // Start out assuming a turn is running, and let the server say otherwise.
    // Guessing "idle" opens the mic at once — and right after a spoken start
    // the opening turn IS running with nothing on screen yet (seen in the
    // first browser run: the mic opened mid-kickoff). Assuming "running"
    // costs at most the health round trip before the mic opens.
    const localGuess = !this.ctx.thinking.classList.contains("hidden") || this.ctx.streamEl !== null;
    this.withTap(
      () =>
        this.dispatch({
          type: "enable",
          now: now(),
          fromGesture: how !== "restore",
          knownIds: [...this.ctx.renderedIds],
          turnInFlight: true,
          announce: how === "tap",
        }),
      how === "tap"
    );
    void api
      .health(this.ctx.id)
      .then((h) => {
        this.diag.log("turn-at-start", { localGuess, server: h.turnInFlight });
        this.dispatch({ type: "turn_state", now: now(), turnInFlight: h.turnInFlight, source: "health-at-start" });
      })
      // Unreachable: stay "turn running"; the reply watchdog re-asks and says so.
      .catch((e) => this.diag.anomaly("health-at-start-failed", { error: (e as Error).message }));
    // What Again replays before any new turn: read fresh, since the screen's
    // copy of the transcript is only the one it loaded with.
    void api
      .lesson(this.ctx.id)
      .then((l) => l.transcript)
      .catch(() => this.ctx.lesson.transcript)
      .then((t) => this.dispatch({ type: "history", now: now(), lastTurn: lastTutorTurn(t) }));
    // Spawning the cleanup model takes ~5s; have it ready for the first answer.
    void api.warmCleanup(this.ctx.id).catch(() => undefined);

    this.tickTimer = setInterval(() => {
      this.dispatch({ type: "tick", now: now() });
      if (++this.ticks % 4 === 0) this.panel.renderDebug(this.machine.snapshot, this.diag.counters, this.diag.recent(20));
    }, 250);
    this.flushTimer = setInterval(() => void this.flush(), 15_000);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    void audioAdapter.voices().then((v) => {
      this.diag.log("voices", { count: v.length });
      this.panel.setVoices(v, loadSettings().voiceURI);
    });
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.dispatch({ type: "disable", now: now() });
    this.stopped = true;
    clearInterval(this.tickTimer);
    clearInterval(this.flushTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    audioAdapter.cancelSpeech();
    audioAdapter.abortRecognizer();
    audioAdapter.releaseWakeLock();
    this.diag.log("drive-stop");
    void this.flush();
    this.panel.unmount();
    clearPendingDrive();
  }

  private exit(): void {
    this.stop();
    this.deps.onExit();
  }

  // --- inputs from the lesson screen ------------------------------------------------------

  onEvent(ev: LessonEvent): void {
    if (ev.type === "heartbeat") this.lastHeartbeatAt = now();
    this.dispatch({ type: "event", now: now(), event: ev as LessonEventIn });
  }

  onReconcile(entries: TranscriptEntry[], turnInFlight: boolean | undefined): void {
    const withIds = entries.filter((e): e is TranscriptEntry & { id: string } => typeof e.id === "string");
    if (withIds.length !== entries.length) this.diag.anomaly("reconcile-entries-without-id", { n: entries.length - withIds.length });
    this.dispatch({
      type: "reconcile",
      now: now(),
      entries: withIds.map((e) => ({ id: e.id, role: e.role, text: e.text })),
      turnInFlight,
    });
  }

  onStreamStatus(status: StreamStatus, detail?: unknown): void {
    if (status === "open") this.diag.log("sse-open", detail);
    else this.diag.anomaly(`sse-${status}`, detail);
  }

  // --- the machine loop --------------------------------------------------------------------

  /**
   * Inputs are queued and drained in order: an adapter callback can fire
   * synchronously while an action executes (cancel() firing onend, a
   * start() that throws), and must not re-enter the machine mid-batch.
   */
  private dispatch(input: DriveInput): void {
    if (this.stopped) return;
    this.queue.push(input);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        for (const a of this.machine.dispatch(next)) this.exec(a);
      }
    } catch (e) {
      // A bug here must not leave the car silent without a trace.
      this.diag.invariant(false, "controller-threw", { error: (e as Error).message, stack: (e as Error).stack });
    } finally {
      this.dispatching = false;
    }
    this.render();
  }

  private withTap(fn: () => void, inTap = true): void {
    this.inTap = inTap;
    try {
      fn();
    } finally {
      this.inTap = false;
    }
  }

  private exec(a: DriveAction): void {
    switch (a.type) {
      case "speak":
        this.diag.log("speak", { gen: a.gen, kind: a.kind, msgId: a.msgId, leadIn: a.leadIn, inTap: this.inTap, text: a.text.slice(0, 200) });
        audioAdapter.speak(a.gen, a.text, a.leadIn, this.inTap);
        return;
      case "cancelSpeech":
        audioAdapter.cancelSpeech();
        return;
      case "startRecognizer":
        audioAdapter.startRecognizer();
        return;
      case "stopRecognizer":
        audioAdapter.stopRecognizer();
        return;
      case "abortRecognizer":
        audioAdapter.abortRecognizer();
        return;
      case "cue":
        audioAdapter.cue(a.cue);
        return;
      case "submit":
        void this.submit(a.text);
        return;
      case "checkHealth":
        void api
          .health(this.ctx.id)
          .then((report) => this.dispatch({ type: "health", now: now(), report }))
          .catch(() => this.dispatch({ type: "health", now: now(), report: null }));
        return;
      case "kick":
        void api
          .kick(this.ctx.id)
          .then((r) => this.diag.log("kick-result", r))
          .catch((e) => this.diag.anomaly("kick-failed", { error: (e as Error).message }));
        return;
      case "reconcile":
        void this.deps.reconcile();
        return;
      case "reconnect":
        this.deps.reconnect();
        return;
      case "reload":
        // Safari asks for a mic it refused only on a fresh page. The pending
        // drive record stays (no stop()), so the reload reopens this lesson in
        // drive mode, paused; the tap that resumes it leads to the prompt.
        this.beaconFlush("reload");
        location.reload();
        return;
      case "finished":
        clearPendingDrive();
        audioAdapter.releaseWakeLock();
        void this.flush();
        return;
      case "diag":
        if (a.level === "invariant") this.diag.invariant(false, a.kind, a.detail);
        else if (a.level === "anomaly") this.diag.anomaly(a.kind, a.detail);
        else this.diag.log(a.kind, a.detail);
        return;
    }
  }

  /**
   * Send a heard answer: first a small model's best guess at what was really
   * said (server/cleanup.ts), which is what the tutor reads, the bubble shows
   * and the transcript keeps — with the raw recognition riding along as
   * `heard`. Cleanup can only ever cost time: any failure sends the raw text.
   */
  private async submit(raw: string): Promise<void> {
    let text = raw.trim();
    let heard: string | undefined;
    try {
      const r = await api.cleanSpoken(this.ctx.id, text);
      if (r.cleaned && r.text.trim()) {
        if (r.text.trim() !== text) heard = text;
        text = r.text.trim();
      }
      this.dispatch({ type: "cleaned", now: now(), text, cleaned: r.cleaned, ms: r.ms, ...(r.fallback ? { fallback: r.fallback } : {}) });
    } catch (e) {
      this.dispatch({ type: "cleaned", now: now(), text, cleaned: false, ms: 0, fallback: (e as Error).message });
    }
    const out = await sendTurn(this.ctx, text, { via: "spoken", heard });
    if (out.status === "failed") {
      // A failed POST isn't proof the answer was lost: on 2026-10-13 the
      // server stored it and the tutor was already replying when the phone's
      // connection blipped and the response never arrived ("Load failed").
      // "Please say it again" then invites a duplicate turn. Ask first.
      const landed = await this.answerLanded(text);
      this.diag.log("send-verify", { error: out.error, landed });
      if (landed) {
        void this.deps.reconcile(); // sendTurn took the bubble back; this redraws it
        this.dispatch({ type: "send_result", now: now(), ok: true });
        return;
      }
    }
    this.dispatch({
      type: "send_result",
      now: now(),
      ok: out.status === "sent",
      ...(out.status === "failed" ? { error: out.error } : {}),
    });
  }

  /**
   * Whether the server's newest learner turn is this answer. Retried while the
   * connection is still coming back (~6s); unreachable throughout counts as
   * not landed. Two identical answers in a row (a second "yes" whose send
   * failed) would read as landed — the reply watchdog recovers that case.
   */
  private async answerLanded(text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { transcript } = await api.lesson(this.ctx.id);
        const lastUser = [...transcript].reverse().find((e) => e.role === "user");
        return lastUser?.text === text.trim();
      } catch {
        await sleep(2000);
      }
    }
    return false;
  }

  private render(): void {
    this.panel.render(this.machine.snapshot, {
      wakeLock: audioAdapter.wakeLockHeld,
      checking: this.checking,
      checkLines: this.checkLines,
    });
  }

  // --- overlay actions ---------------------------------------------------------------------

  private tap(): void {
    if (this.checking) return;
    const phase = this.machine.snapshot.phase;
    if (phase === "paused" || phase === "stuck") {
      // Coming back from a call, the background, or a restore: this tap is
      // what re-unlocks audio and the wake lock.
      audioAdapter.unlock();
      void audioAdapter.acquireWakeLock();
    }
    this.withTap(() => this.dispatch({ type: "tap", now: now() }));
  }

  private applySettings(s: SpeechSettings): void {
    writeStore(SETTINGS_KEY, JSON.stringify(s));
    audioAdapter.configure(s);
    this.diag.log("settings", s);
  }

  // --- the pre-drive check -------------------------------------------------------------------

  /** Run while parked: everything the drive depends on, said aloud and listed on screen. */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.checkLines = [];
    this.dispatch({ type: "pause", now: now(), reason: "check" });
    // Synchronously inside the button's tap: unlock, then speak at once.
    audioAdapter.unlock();
    void audioAdapter.acquireWakeLock();
    const intro = audioAdapter.speakOnce("Running the pre-drive check.");
    const results: { ok: boolean | null; text: string }[] = [];
    const line = (ok: boolean | null, text: string) => {
      results.push({ ok, text });
      this.checkLines.push(`${ok === null ? "·" : ok ? "✓" : "✗"} ${text}`);
      this.render();
    };
    try {
      const p = probes();
      line(p.safari, p.safari ? "Safari" : "Not Safari — speech recognition only works in Safari on iOS");
      line(p.secure, p.secure ? "Secure (HTTPS) page" : "Not HTTPS — use the tailnet URL");
      line(p.recognition, "Speech recognition present");
      const playback = loadSettings().sessionPlayback;
      line(null, p.audioSession ? `audioSession present (playback while speaking: ${playback ? "on" : "off"})` : "no audioSession API");
      const voices = await audioAdapter.voices();
      line(voices.length > 0, `${voices.length} voices`);
      await sleep(300);
      line(audioAdapter.wakeLockHeld, audioAdapter.wakeLockHeld ? "Screen wake lock held" : "Screen wake lock NOT held (Low Power Mode?)");
      try {
        const h = await api.health(this.ctx.id);
        line(true, `Server reachable (runner ${h.alive ? "alive" : "idle"}, ${h.listeners} stream listener${h.listeners === 1 ? "" : "s"})`);
      } catch (e) {
        line(false, `Server unreachable: ${(e as Error).message}`);
      }
      const hbAge = this.lastHeartbeatAt ? Math.round((now() - this.lastHeartbeatAt) / 1000) : null;
      line(hbAge !== null && hbAge < 20, hbAge === null ? "No stream heartbeat seen yet" : `Stream heartbeat ${hbAge}s ago`);
      try {
        const v = await api.version();
        line(v.buildId === __BUILD_ID__, v.buildId === __BUILD_ID__ ? `Build ${__BUILD_ID__} is current` : `Stale build ${__BUILD_ID__} (server has ${v.buildId}) — reload`);
      } catch {
        line(false, "Couldn't check the build");
      }
      await intro;
      await audioAdapter.tone("turn-start");
      await sleep(500);
      await audioAdapter.speakOnce("That was a tone. This sentence should sound just as loud as the first one.");
      line(null, "Tone, then speech — judge the volume by ear");
      // The machine's recogniser must be fully stopped before the check's.
      for (let i = 0; i < 20 && this.machine.snapshot.rec !== "stopped"; i++) await sleep(100);
      await audioAdapter.speakOnce("Mic check. After the tone, say: testing, one, two, three.");
      await audioAdapter.tone("listening");
      const mic = await audioAdapter.listenOnce();
      line(
        mic.ok,
        mic.ok
          ? `Heard “${mic.text}” (confidence ${mic.confidence.toFixed(2)}, mic took ${mic.startLatencyMs}ms to open)`
          : `Mic: ${mic.error}`
      );
      const failed = results.filter((r) => r.ok === false).length;
      await audioAdapter.speakOnce(
        failed ? `${failed} check${failed === 1 ? "" : "s"} failed. The details are on screen.` : "All checks passed. Tap to start."
      );
    } catch (e) {
      line(false, `Check crashed: ${(e as Error).message}`);
    } finally {
      this.diag.log("preflight", { lines: this.checkLines });
      this.checking = false;
      this.render();
    }
  }

  // --- visibility -----------------------------------------------------------------------------

  private visibility(): void {
    const hidden = document.visibilityState === "hidden";
    this.dispatch({ type: "visibility", now: now(), hidden });
    if (hidden) this.beaconFlush("hidden");
  }

  // --- diagnostics upload (with the phone's storage as the safety net) --------------------------

  private persistDiag(): void {
    let batches = this.diag.pending();
    let json = JSON.stringify(batches);
    while (json.length > MAX_STORED_DIAG_CHARS && batches.length > 1) {
      batches = batches.slice(1);
      json = JSON.stringify(batches);
    }
    writeStore(DIAG_PREFIX + this.ctx.id, batches.length ? json : null);
  }

  private async flush(): Promise<void> {
    this.diag.takeBatch();
    this.persistDiag();
    for (const b of [...this.diag.pending()].slice(0, 5)) {
      try {
        await api.sendDiag(this.ctx.id, b);
        this.diag.ack(b.id);
      } catch {
        break; // offline — the batch stays on the phone and goes next time
      }
    }
    this.persistDiag();
  }

  /** The page may be about to die: hand the backlog to the browser to deliver. Not acked — the server dedupes re-sends. */
  private beaconFlush(why: string): void {
    this.diag.log("beacon-flush", { why });
    this.diag.takeBatch();
    this.persistDiag();
    for (const b of this.diag.pending()) {
      try {
        navigator.sendBeacon(`/api/diag/${this.ctx.id}`, new Blob([JSON.stringify(b)], { type: "application/json" }));
      } catch {
        break;
      }
    }
  }

  /** Batches left on the phone by earlier pages: this lesson's are adopted, others sent straight up. */
  private restoreStoredDiag(): void {
    let keys: string[] = [];
    try {
      keys = Object.keys(localStorage).filter((k) => k.startsWith(DIAG_PREFIX));
    } catch {
      return;
    }
    for (const key of keys) {
      const sessionId = key.slice(DIAG_PREFIX.length);
      const batches = parseStoredBatches(readStore(key));
      if (sessionId === this.ctx.id) {
        this.diag.restore(batches);
        continue;
      }
      void (async () => {
        const left: DiagBatch[] = [];
        for (const b of batches) {
          try {
            await api.sendDiag(sessionId, b);
          } catch {
            left.push(b);
          }
        }
        writeStore(key, left.length ? JSON.stringify(left) : null);
      })();
    }
  }
}
