// ---------------------------------------------------------------------------
// The endpointer: decides when the learner has finished answering.
//
// SpeechRecognition has no "how long to wait" setting — with continuous=false
// it ends its own session after ~1–2s of silence. So its `end` means "the
// recogniser gave up", not "the learner finished": the adapter restarts it and
// keeps feeding this one buffer. Two clocks, both ours:
//
//   - Nothing heard yet → wait indefinitely. Thinking time is free; the
//     recogniser cycles silently underneath. An empty buffer NEVER submits.
//   - Something heard → submit after `silenceMs` with no new interim or final,
//     or `midSentenceMs` when the last word can't end a sentence ("the", "to",
//     "which"…). The clock follows interims, not finals: finals land 1.2–2.1s
//     after the learner stops (measured on J's phone), so a finals-only clock
//     adds ~2s of dead air to every answer.
//
//     History: 2.5s flat cut off two of four answers on the first real run
//     ("…automatically backs the", "…the criteria by which that you"); J
//     thinks aloud with pauses of 1–2.7s. J would rather wait than feel
//     rushed, so both clocks went up.
//
// Plus a hard cap from the first sound, and a Done tap. When the newest words
// exist only as an interim, submitting first asks the adapter to stop the
// recogniser and waits up to `flushMs` for their final.
//
// IMPORTANT: this module imports nothing (see web/src/lesson/reconcile.ts for
// why). Time is always passed in, never read.
// ---------------------------------------------------------------------------

export interface EndpointConfig {
  silenceMs: number;
  /** The silence clock when the heard text ends on a word that can't end a sentence. */
  midSentenceMs: number;
  capMs: number;
  flushMs: number;
}

export const DEFAULT_ENDPOINT: EndpointConfig = {
  silenceMs: 4000,
  midSentenceMs: 7000,
  capMs: 90_000,
  flushMs: 1000,
};

export type EndpointPhase = "idle" | "hearing" | "flushing" | "submitted";

export interface EndpointState {
  phase: EndpointPhase;
  finals: string[];
  /** The recogniser's current interim, if newer than the last final. */
  interim: string;
  firstSoundAt: number | null;
  lastActivityAt: number | null;
  flushDeadline: number | null;
  /** Why a flush started — carried through to the submit. */
  pendingReason: SubmitReason | null;
}

export type SubmitReason = "silence" | "cap" | "done";

/** Everything needed to tune the clocks later from the diag log. */
export interface SubmitTrace {
  reason: SubmitReason;
  heardMs: number; // first sound → submit
  silenceMs: number; // last activity → submit
  finals: number;
  /** The last words were only ever an interim (their final never came). */
  usedInterim: boolean;
  /** For a silence submit: the clock that applied, and whether it was the mid-sentence one. */
  waitMs?: number;
  midSentence?: boolean;
}

export type EndpointAction =
  | { type: "flush" } // stop the recogniser; its final should follow
  | { type: "submit"; text: string; trace: SubmitTrace };

export interface EndpointStep {
  state: EndpointState;
  action: EndpointAction | null;
}

export function initialEndpoint(): EndpointState {
  return {
    phase: "idle",
    finals: [],
    interim: "",
    firstSoundAt: null,
    lastActivityAt: null,
    flushDeadline: null,
    pendingReason: null,
  };
}

// Words that almost never end a spoken sentence: articles, prepositions,
// conjunctions, auxiliaries, subject pronouns, fillers. A false positive
// costs a few seconds of extra wait; a false negative cuts J off.
const DANGLING = new Set(
  (
    "a an the to of in on at by for with from into onto about as than and or but nor " +
    "because if whether that which who whom whose where when while although though since " +
    "is are was were be been being am has have had do does did will would can could " +
    "should shall may might must i we they he she you my your our their his her its " +
    "it's that's there's what's this these those very more most less like um uh er erm " +
    "just also then so"
  ).split(" ")
);

/** Whether this text stops on a word that can't end a sentence. */
export function endsMidSentence(text: string): boolean {
  const words = text.toLowerCase().replace(/[’]/g, "'").match(/[a-z']+/g);
  if (!words) return false;
  return DANGLING.has(words[words.length - 1]);
}

/** Text the learner has said so far (finals plus any newer interim). */
export function heardText(s: EndpointState): string {
  return [...s.finals, s.interim].map((t) => t.trim()).filter(Boolean).join(" ");
}

function heard(s: EndpointState, now: number): EndpointState {
  return {
    ...s,
    phase: s.phase === "flushing" ? "flushing" : "hearing",
    firstSoundAt: s.firstSoundAt ?? now,
    lastActivityAt: now,
  };
}

function submit(
  s: EndpointState,
  reason: SubmitReason,
  now: number,
  usedInterim = s.interim.trim() !== "",
  wait?: { waitMs: number; midSentence: boolean }
): EndpointStep {
  const text = heardText(s);
  return {
    state: { ...s, phase: "submitted", flushDeadline: null, pendingReason: null },
    action: {
      type: "submit",
      text,
      trace: {
        reason,
        heardMs: now - (s.firstSoundAt ?? now),
        silenceMs: now - (s.lastActivityAt ?? now),
        finals: s.finals.length,
        usedInterim,
        ...(wait ?? {}),
      },
    },
  };
}

/** Submit now if every word is final; otherwise flush first. */
function finish(
  s: EndpointState,
  reason: SubmitReason,
  now: number,
  cfg: EndpointConfig,
  wait?: { waitMs: number; midSentence: boolean }
): EndpointStep {
  if (s.interim.trim() === "") return submit(s, reason, now, undefined, wait);
  return {
    state: { ...s, phase: "flushing", flushDeadline: now + cfg.flushMs, pendingReason: reason },
    action: { type: "flush" },
  };
}

export function onInterim(s: EndpointState, text: string, now: number): EndpointStep {
  if (s.phase === "submitted") return { state: s, action: null };
  // An empty interim carries no speech — it must not start the silence clock.
  if (text.trim() === "") return { state: s, action: null };
  return { state: heard({ ...s, interim: text }, now), action: null };
}

export function onFinal(s: EndpointState, text: string, now: number): EndpointStep {
  if (s.phase === "submitted") return { state: s, action: null };
  const t = text.trim();
  if (t === "") {
    // An empty final recognised nothing; keep any interim rather than lose it.
    if (s.phase === "flushing") return submit(s, s.pendingReason ?? "silence", now);
    return { state: s, action: null };
  }
  const next = heard({ ...s, finals: [...s.finals, t], interim: "" }, now);
  if (next.phase === "flushing") return submit(next, next.pendingReason ?? "silence", now);
  return { state: next, action: null };
}

/**
 * The recogniser session ended (it will be restarted). An interim with no
 * final is kept as if it were final — otherwise the next session's first
 * interim would overwrite those words. `promoted` says whether that happened,
 * for the diag log.
 */
export function onRecognizerEnd(s: EndpointState, now: number): EndpointStep & { promoted: boolean } {
  if (s.phase === "submitted" || s.interim.trim() === "") return { state: s, action: null, promoted: false };
  // While flushing, the flush was waiting for exactly this: submit on the tick.
  const promotedState: EndpointState = { ...s, finals: [...s.finals, s.interim.trim()], interim: "" };
  if (s.phase === "flushing") {
    return { ...submit(promotedState, s.pendingReason ?? "silence", now, true), promoted: true };
  }
  return { state: promotedState, action: null, promoted: true };
}

export function onTick(s: EndpointState, now: number, cfg: EndpointConfig = DEFAULT_ENDPOINT): EndpointStep {
  switch (s.phase) {
    case "idle":
    case "submitted":
      return { state: s, action: null };
    case "flushing":
      if (s.flushDeadline !== null && now >= s.flushDeadline) {
        return submit(s, s.pendingReason ?? "silence", now);
      }
      return { state: s, action: null };
    case "hearing":
      if (s.firstSoundAt !== null && now - s.firstSoundAt >= cfg.capMs) return finish(s, "cap", now, cfg);
      if (s.lastActivityAt !== null) {
        const midSentence = endsMidSentence(heardText(s));
        const waitMs = midSentence ? cfg.midSentenceMs : cfg.silenceMs;
        if (now - s.lastActivityAt >= waitMs) return finish(s, "silence", now, cfg, { waitMs, midSentence });
      }
      return { state: s, action: null };
  }
}

/** The Done tap. A no-op when nothing has been heard — never an empty submit. */
export function onDone(s: EndpointState, now: number, cfg: EndpointConfig = DEFAULT_ENDPOINT): EndpointStep {
  if (s.phase === "submitted" || s.phase === "flushing") return { state: s, action: null };
  if (heardText(s) === "") return { state: s, action: null };
  return finish(s, "done", now, cfg);
}
