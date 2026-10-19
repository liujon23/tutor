// ---------------------------------------------------------------------------
// The only file that touches speechSynthesis, SpeechRecognition, the screen
// wake lock and Web Audio. Everything here is plumbing: it executes what the
// drive state machine decides, and reports what the browser did back as
// DriveInputs. Each rule in it was learned on J's phone (docs/drive-mode.md):
//
// - One SpeechRecognition, ever: constructing another plays the system chime.
// - Never start() a recogniser that is running — the spike threw
//   InvalidStateError ~100 times a run doing that. A start() that throws is
//   reported, not retried here.
// - Keep a strong reference to the speaking utterance (it can be garbage
//   collected before onend), and tag each with the machine's generation so a
//   cancelled one's late onend/onerror is recognisably stale.
// - Never set navigator.audioSession.type to "play-and-record": it made the
//   speaker quieter and switched the car's Bluetooth source. What IS set, when
//   the sessionPlayback setting is on (the default since 2026-10-10), is
//   "playback" while the tutor speaks and "auto" again before the mic opens:
//   J heard the tutor come out quieter on some drives and not others, which
//   fits iOS keeping the session in its record mode after the mic closes. On
//   Bluetooth it also keeps the tutor's voice out of the car's phone-call
//   audio (only the mic needs that). An experiment: every switch is logged.
// - Tones come from an oscillator (the CSP blocks data: audio). The
//   AudioContext must be created inside a tap.
// ---------------------------------------------------------------------------

import type { Cue, DriveInput } from "./drive-state.js";

// Minimal typings — lib.dom doesn't carry the Web Speech recognition API.
interface RecAlternative {
  transcript: string;
  confidence: number;
}
interface RecResult {
  isFinal: boolean;
  length: number;
  [i: number]: RecAlternative;
}
interface RecEvent extends Event {
  resultIndex: number;
  results: { length: number; [i: number]: RecResult };
}
interface RecErrorEvent extends Event {
  error: string;
  message?: string;
}
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognizerCtor = new () => Recognizer;

export type AdapterLevel = "info" | "anomaly";

export interface AdapterSink {
  /** A browser event the drive machine should hear about. */
  input(i: DriveInput): void;
  /** Raw platform detail for the diag log. */
  log(kind: string, detail?: unknown, level?: AdapterLevel): void;
}

export interface SpeechSettings {
  /** null: the default voice, Samantha (see defaultVoice). */
  voiceURI: string | null;
  rate: number;
  tones: boolean;
  /** Mark the audio session "playback" while speaking (see the header). */
  sessionPlayback: boolean;
}

/** navigator.audioSession — Safari only, not in lib.dom yet. */
interface AudioSessionLike extends EventTarget {
  type: string;
  readonly state?: string;
}
function audioSession(): AudioSessionLike | null {
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession ?? null;
}

export interface Probes {
  ua: string;
  safari: boolean;
  ios: boolean;
  secure: boolean;
  recognition: boolean;
  synthesis: boolean;
  wakeLock: boolean;
  audioSession: boolean;
  audioContext: boolean;
}

export type MicCheck =
  | { ok: true; text: string; confidence: number; startLatencyMs: number }
  | { ok: false; error: string };

const now = () => performance.now();

// Short sine figures: [frequency Hz, duration s, peak gain].
const TONES: Record<Cue | "lead-in", [number, number, number][]> = {
  "lead-in": [[440, 0.08, 0.04]],
  "turn-start": [
    [523, 0.09, 0.12],
    [659, 0.12, 0.12],
  ],
  "still-working": [[392, 0.16, 0.08]],
  listening: [
    [660, 0.07, 0.1],
    [880, 0.09, 0.1],
  ],
};

// Spoken stand-ins when tones are switched off. The listening cue has none:
// it fires with the mic already live, which would hear its own voice.
const SPOKEN_CUES: Partial<Record<Cue, string>> = {
  "turn-start": "Okay.",
  "still-working": "Still working.",
};

/** Gap after a lead-in tone before speech, so the waking route clips the tone, not the words. */
const LEAD_IN_MS = 250;

export function probes(): Probes {
  const ua = navigator.userAgent;
  const w = window as unknown as Record<string, unknown>;
  return {
    ua,
    // Chrome/Firefox/Edge on iOS expose recognition but fail it instantly
    // (not-allowed): only real Safari works.
    safari: /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua),
    ios: /iPhone|iPad|iPod/.test(ua),
    secure: window.isSecureContext,
    recognition: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
    synthesis: "speechSynthesis" in window,
    wakeLock: "wakeLock" in navigator,
    audioSession: "audioSession" in navigator,
    audioContext: !!(w.AudioContext || w.webkitAudioContext),
  };
}

export class AudioAdapter {
  private sink: AdapterSink | null = null;
  private rec: Recognizer | null = null;
  private recSession = 0;
  private recStartedAt = 0;
  private finalsThisSession = new Set<number>();
  private capture: { resolve: (r: MicCheck) => void; startedAt: number; audioAt: number | null } | null = null;
  private current: SpeechSynthesisUtterance | null = null;
  private leadInTimer: ReturnType<typeof setTimeout> | undefined;
  /** A recogniser start waiting for speech to end (see startRecognizer). */
  private deferredStart: ReturnType<typeof setTimeout> | undefined;
  private ac: AudioContext | null = null;
  private wake: WakeLockSentinel | null = null;
  private settings: SpeechSettings = { voiceURI: null, rate: 1, tones: true, sessionPlayback: true };
  private sessionWatched = false;
  /** Bumped on every speak/cancel, so a lead-in waiting on a resume can tell it was superseded. */
  private speakToken = 0;
  private voice: SpeechSynthesisVoice | null = null;

  bind(sink: AdapterSink): void {
    this.sink = sink;
    const as = audioSession();
    if (as && !this.sessionWatched) {
      // Interruptions (navigation prompts, calls) show up here, if anywhere.
      this.sessionWatched = true;
      as.addEventListener("statechange", () => this.log("audiosession-state", this.sessionInfo()));
    }
  }

  private sessionInfo(): { type: string; state: string | null } | null {
    const as = audioSession();
    return as ? { type: as.type, state: as.state ?? null } : null;
  }

  /** Switch the audio session type (see the header). Logged; never throws. */
  private sessionFor(use: "speech" | "mic"): void {
    const as = audioSession();
    if (!as) return;
    const want = use === "speech" && this.settings.sessionPlayback ? "playback" : "auto";
    if (as.type === want) return;
    try {
      as.type = want;
      this.log("audiosession-set", { type: want, for: use, state: as.state ?? null });
    } catch (e) {
      this.log("audiosession-set-failed", { type: want, error: (e as Error).message }, "anomaly");
    }
  }

  private input(i: DriveInput): void {
    this.sink?.input(i);
  }

  private log(kind: string, detail?: unknown, level: AdapterLevel = "info"): void {
    this.sink?.log(kind, detail, level);
  }

  // --- unlocking (must run synchronously inside a tap) ---------------------------

  /**
   * Create/resume the AudioContext inside the user's tap. Speech is unlocked
   * by the first speak() inside the same tap, which the caller does next.
   */
  unlock(): void {
    try {
      if (!this.ac) {
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (Ctor) {
          this.ac = new Ctor();
          this.ac.addEventListener("statechange", () => this.log("audiocontext-state", { state: this.ac?.state }));
        }
      }
      if (this.ac && this.ac.state !== "running") void this.ac.resume().catch(() => undefined);
      this.log("unlock", { audioContext: this.ac?.state ?? "none" });
    } catch (e) {
      this.log("unlock-failed", { error: (e as Error).message }, "anomaly");
    }
  }

  // --- speech ------------------------------------------------------------------------

  configure(settings: SpeechSettings): void {
    this.settings = settings;
    this.voice = null; // re-picked on the next speak
    if (!settings.sessionPlayback) this.sessionFor("mic"); // switched off: back to "auto" now
  }

  /** Voices, waiting for voiceschanged only if none are loaded yet (it may never fire). */
  voices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
    const have = speechSynthesis.getVoices();
    if (have.length) return Promise.resolve(have);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        speechSynthesis.removeEventListener("voiceschanged", done);
        resolve(speechSynthesis.getVoices());
      };
      const t = setTimeout(done, timeoutMs);
      speechSynthesis.addEventListener("voiceschanged", done);
    });
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voice) return this.voice;
    const all = speechSynthesis.getVoices();
    const saved = this.settings.voiceURI ? all.find((v) => v.voiceURI === this.settings.voiceURI) : undefined;
    const chosen = saved ?? defaultVoice(all);
    this.voice = chosen ?? null;
    if (chosen) {
      this.log("voice", {
        name: chosen.name,
        lang: chosen.lang,
        uri: chosen.voiceURI,
        of: all.length,
        // "saved-missing": the saved voice isn't installed (any more).
        why: saved ? "saved" : this.settings.voiceURI ? "saved-missing" : "default",
      });
    }
    return this.voice;
  }

  private utterance(text: string): SpeechSynthesisUtterance {
    const u = new SpeechSynthesisUtterance(text);
    const v = this.pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = this.settings.rate;
    return u;
  }

  /**
   * Speak one utterance for the machine. `inGesture`: this call is inside a
   * tap, so speak synchronously — a lead-in delay would break the gesture
   * chain, and iOS drops speech started outside it.
   */
  speak(gen: number, text: string, leadIn: boolean, inGesture: boolean): void {
    clearTimeout(this.leadInTimer);
    const token = ++this.speakToken;
    this.sessionFor("speech");
    const u = this.utterance(text);
    this.current = u; // strong ref until it ends
    const startedAt = now();
    u.onstart = () =>
      this.log("tts-start", { gen, delayMs: Math.round(now() - startedAt), session: this.sessionInfo(), ac: this.ac?.state ?? null });
    u.onend = () => {
      if (this.current === u) this.current = null;
      this.input({ type: "utterance_end", now: now(), gen });
    };
    u.onerror = (e) => {
      if (this.current === u) this.current = null;
      this.input({ type: "utterance_error", now: now(), gen, error: (e as SpeechSynthesisErrorEvent).error ?? "unknown" });
    };
    const go = () => {
      try {
        speechSynthesis.speak(u);
      } catch (e) {
        this.log("tts-speak-threw", { gen, error: (e as Error).message }, "anomaly");
        this.input({ type: "utterance_error", now: now(), gen, error: "speak-threw" });
      }
    };
    if (leadIn && !inGesture && this.settings.tones && this.ac) {
      // The tone may first wait for a suspended context to resume; the speech
      // follows the tone, not this call, or the two overlap.
      void this.tone("lead-in").then(() => {
        if (token === this.speakToken) this.leadInTimer = setTimeout(go, LEAD_IN_MS);
      });
    } else {
      go();
    }
    if (speechSynthesis.paused) {
      // A paused queue swallows everything after it; resume rather than stall.
      this.log("tts-was-paused", { gen }, "anomaly");
      speechSynthesis.resume();
    }
  }

  cancelSpeech(): void {
    clearTimeout(this.leadInTimer);
    this.speakToken++;
    this.current = null;
    speechSynthesis.cancel();
  }

  /** Speak outside the machine (pre-drive check, select-screen "Starting."). Resolves on end. */
  speakOnce(text: string, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve) => {
      this.sessionFor("speech");
      const u = this.utterance(text);
      this.current = u;
      const done = () => {
        clearTimeout(t);
        if (this.current === u) this.current = null;
        resolve();
      };
      const t = setTimeout(() => {
        this.log("speak-once-timeout", { text }, "anomaly");
        done();
      }, timeoutMs);
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // --- cues ----------------------------------------------------------------------------

  cue(kind: Cue): void {
    if (this.settings.tones && this.ac) {
      void this.tone(kind);
      return;
    }
    const line = SPOKEN_CUES[kind];
    if (line) {
      // Not tracked by the machine — its own utterances carry generations.
      this.sessionFor("speech");
      const u = this.utterance(line);
      speechSynthesis.speak(u);
    }
    this.log("cue", { kind, as: line ? "speech" : "none" });
  }

  /** Play a cue tone. Resolves once it is scheduled (after any resume), so speech can follow it. */
  tone(kind: Cue | "lead-in"): Promise<void> {
    const ac = this.ac;
    if (!ac) {
      this.log("tone-no-audiocontext", { kind }, "anomaly");
      return Promise.resolve();
    }
    if (ac.state === "running") {
      this.playTone(ac, kind);
      return Promise.resolve();
    }
    // iOS suspends an idle context ~8s after its last sound (seen on every
    // drive, 2026-10-10) and interrupts it for calls and Siri. Scheduling on a
    // suspended context's frozen clock played the tone late, over the speech
    // it was meant to precede: resume first. A refused resume is given up on
    // after 500ms — a late tone beats a stalled utterance.
    const started = now();
    const state = ac.state;
    return Promise.race([ac.resume().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 500))]).then(() => {
      this.log("tone-context-resumed", { kind, from: state, to: ac.state, ms: Math.round(now() - started) });
      this.playTone(ac, kind);
    });
  }

  private playTone(ac: AudioContext, kind: Cue | "lead-in"): void {
    let t = ac.currentTime + 0.01;
    for (const [freq, dur, peak] of TONES[kind]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur;
    }
    this.log("tone", { kind, state: ac.state });
  }

  // --- recognition -------------------------------------------------------------------

  private recognizer(): Recognizer | null {
    if (this.rec) return this.rec;
    const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = false; // iOS ends a session after ~1–2s of silence; we restart
    r.interimResults = true; // the endpointer's silence clock runs on interims
    r.lang = "en-US";
    r.maxAlternatives = 1;
    r.onstart = () => this.log("rec-start-event", { session: this.recSession });
    r.onaudiostart = () => {
      const latencyMs = Math.round(now() - this.recStartedAt);
      if (this.capture) {
        this.capture.audioAt = now();
        return;
      }
      this.log("rec-audiostart", { session: this.recSession, latencyMs });
      this.input({ type: "rec_audiostart", now: now() });
    };
    r.onspeechstart = () => this.log("rec-speechstart", { session: this.recSession });
    r.onspeechend = () => this.log("rec-speechend", { session: this.recSession });
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        if (res.isFinal) {
          if (this.finalsThisSession.has(i)) {
            // iOS can repeat a final; the endpointer must not hear it twice.
            this.log("rec-duplicate-final", { session: this.recSession, index: i, text: alt.transcript }, "anomaly");
            continue;
          }
          this.finalsThisSession.add(i);
          this.log("rec-final", { session: this.recSession, index: i, text: alt.transcript, confidence: alt.confidence });
          if (this.capture) {
            const c = this.capture;
            this.capture = null;
            c.resolve({
              ok: true,
              text: alt.transcript,
              confidence: alt.confidence,
              startLatencyMs: Math.round((c.audioAt ?? now()) - c.startedAt),
            });
            continue;
          }
          this.input({ type: "rec_final", now: now(), text: alt.transcript, confidence: alt.confidence });
        } else {
          interim += alt.transcript;
        }
      }
      if (interim) {
        this.log("rec-interim", { session: this.recSession, text: interim });
        if (!this.capture) this.input({ type: "rec_interim", now: now(), text: interim });
      }
    };
    r.onerror = (e) => {
      const level: AdapterLevel = e.error === "no-speech" || e.error === "aborted" ? "info" : "anomaly";
      this.log("rec-error", { session: this.recSession, error: e.error, message: e.message ?? "" }, level);
      if (this.capture && e.error !== "no-speech" && e.error !== "aborted") {
        const c = this.capture;
        this.capture = null;
        c.resolve({ ok: false, error: e.error });
        return;
      }
      // Outside real Safari (Chrome/Firefox/Edge on iOS) a refusal is the
      // browser lacking the entitlement — no reload or prompt can fix that.
      const refused = e.error === "not-allowed" || e.error === "service-not-allowed";
      const error = refused && !probes().safari ? "unsupported" : e.error;
      if (!this.capture) this.input({ type: "rec_error", now: now(), error, message: e.message });
    };
    r.onend = () => {
      this.log("rec-end", { session: this.recSession, ms: Math.round(now() - this.recStartedAt) });
      if (this.capture) {
        const c = this.capture;
        this.capture = null;
        c.resolve({ ok: false, error: "no speech heard" });
        return;
      }
      this.input({ type: "rec_end", now: now() });
    };
    this.rec = r;
    this.log("rec-created");
    return r;
  }

  /**
   * Start a recogniser session for the machine — but never while anything is
   * speaking. Safari fails the mic permission check, without showing its
   * prompt, for a start() made over playing speech (2026-10-10 and -19: the
   * select screen's "Starting.", which the machine doesn't track, was still
   * playing), and then refuses the mic for the rest of the page. So wait for
   * the speech to end; past 5s, start anyway rather than never listen.
   */
  startRecognizer(): void {
    const r = this.recognizer();
    if (!r) {
      this.input({ type: "rec_error", now: now(), error: "unsupported", message: "no SpeechRecognition in this browser" });
      return;
    }
    clearTimeout(this.deferredStart);
    this.deferredStart = undefined;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      const since = now();
      this.log("rec-start-deferred", { speaking: speechSynthesis.speaking, pending: speechSynthesis.pending });
      const retry = () => {
        if ((speechSynthesis.speaking || speechSynthesis.pending) && now() - since < 5000) {
          this.deferredStart = setTimeout(retry, 100);
          return;
        }
        this.deferredStart = undefined;
        const waitedMs = Math.round(now() - since);
        if (waitedMs >= 5000) this.log("rec-start-deferral-gave-up", { waitedMs }, "anomaly");
        else this.log("rec-start-undeferred", { waitedMs });
        this.beginRecognizer(r);
      };
      this.deferredStart = setTimeout(retry, 100);
      return;
    }
    this.beginRecognizer(r);
  }

  /** A deferred start was cancelled by a stop/abort: the session never began, so end it for the machine. */
  private cancelDeferredStart(): boolean {
    if (this.deferredStart === undefined) return false;
    clearTimeout(this.deferredStart);
    this.deferredStart = undefined;
    this.log("rec-start-deferral-cancelled");
    this.input({ type: "rec_end", now: now() });
    return true;
  }

  private beginRecognizer(r: Recognizer): void {
    this.sessionFor("mic");
    this.recSession++;
    this.finalsThisSession.clear();
    // Reset per session, or the first audiostart measures from an earlier
    // session and reports a fictitious stall (the spike logged 50,596ms).
    this.recStartedAt = now();
    try {
      r.start();
    } catch (e) {
      this.log("rec-start-threw", { session: this.recSession, error: (e as Error).message }, "anomaly");
      this.input({ type: "rec_error", now: now(), error: "start-threw", message: (e as Error).message });
    }
  }

  stopRecognizer(): void {
    if (this.cancelDeferredStart()) return;
    try {
      this.rec?.stop();
    } catch (e) {
      this.log("rec-stop-threw", { error: (e as Error).message }, "anomaly");
    }
  }

  abortRecognizer(): void {
    if (this.cancelDeferredStart()) return;
    try {
      this.rec?.abort();
    } catch (e) {
      this.log("rec-abort-threw", { error: (e as Error).message }, "anomaly");
    }
  }

  /** Listen for one phrase outside the machine (the pre-drive mic check). */
  listenOnce(timeoutMs = 9000): Promise<MicCheck> {
    const r = this.recognizer();
    if (!r) return Promise.resolve({ ok: false, error: "no SpeechRecognition in this browser" });
    return new Promise<MicCheck>((resolve) => {
      const t = setTimeout(() => {
        if (this.capture) {
          this.capture = null;
          this.abortRecognizer();
          resolve({ ok: false, error: "timed out" });
        }
      }, timeoutMs);
      this.capture = {
        resolve: (res) => {
          clearTimeout(t);
          resolve(res);
        },
        startedAt: now(),
        audioAt: null,
      };
      this.recSession++;
      this.finalsThisSession.clear();
      this.recStartedAt = now();
      this.sessionFor("mic");
      try {
        r.start();
      } catch (e) {
        this.capture = null;
        clearTimeout(t);
        resolve({ ok: false, error: `start threw: ${(e as Error).message}` });
      }
    });
  }

  // --- wake lock ---------------------------------------------------------------------

  get wakeLockHeld(): boolean {
    return this.wake !== null;
  }

  async acquireWakeLock(): Promise<void> {
    if (this.wake || !("wakeLock" in navigator)) return;
    try {
      const w = await navigator.wakeLock.request("screen");
      this.wake = w;
      this.log("wakelock-acquired");
      w.addEventListener("release", () => {
        // The system drops it whenever the page is hidden; re-acquired on return.
        this.log("wakelock-released");
        if (this.wake === w) this.wake = null;
      });
    } catch (e) {
      // Low Power Mode, for one, can refuse it.
      this.log("wakelock-refused", { error: (e as Error).message }, "anomaly");
    }
  }

  releaseWakeLock(): void {
    const w = this.wake;
    this.wake = null;
    void w?.release().catch(() => undefined);
  }
}

/**
 * The default voice: Samantha (en-US), always, when she's installed — J's pick
 * after trying the lot on the first real run. Only a phone without her falls
 * through to bestVoice. (The automatic pick has twice landed on an Eloquence
 * novelty voice — Reed on the first run, Flo on 2026-10-10 — so the picker no
 * longer offers an "automatic" option at all.)
 */
export function defaultVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const samantha = voices.filter((v) => /^samantha\b/i.test(v.name.trim()) && /^en[-_]US$/i.test(v.lang));
  // Prefer a richer Samantha if iOS has one installed.
  const rank = (v: SpeechSynthesisVoice) =>
    /premium/i.test(v.voiceURI + v.name) ? 2 : /enhanced/i.test(v.voiceURI + v.name) ? 1 : 0;
  return samantha.sort((a, b) => rank(b) - rank(a))[0] ?? bestVoice(voices);
}

/**
 * The fallback when Samantha isn't installed: iOS's Premium, then Enhanced,
 * then any local en-US, then any English, then the browser default.
 */
export function bestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice): number =>
    (/^samantha/i.test(v.name) && /^en[-_]US$/i.test(v.lang) ? 100 : 0) +
    (/premium/i.test(v.name) ? 40 : 0) +
    (/enhanced/i.test(v.name) ? 20 : 0) +
    (/^en[-_]US$/i.test(v.lang) ? 5 : 0) +
    (v.localService ? 2 : 0) +
    (v.default ? 1 : 0);
  return [...english].sort((a, b) => score(b) - score(a))[0] ?? voices.find((v) => v.default);
}

/** One adapter per page: one recogniser, one AudioContext, across lesson screens. */
export const audioAdapter = new AudioAdapter();
