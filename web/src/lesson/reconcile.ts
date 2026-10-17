// ---------------------------------------------------------------------------
// Transcript reconciliation: deciding what is already on screen.
//
// SSE has no replay, so the lesson screen refetches the authoritative
// transcript after a reconnect or a return to the foreground and appends
// whatever it missed. Getting "what did I miss" wrong is not cosmetic: too low
// and the tail is re-rendered on every wake, too high and a real message is
// skipped for good.
//
// IMPORTANT: this module imports nothing. It is compiled by BOTH the web build
// and the root tsconfig (so tests/ can reach it without a browser), and those
// two programs disagree about module resolution and ambient globals — a single
// import of anything under web/src/ would break one of them. Keep it pure.
// ---------------------------------------------------------------------------

/** The part of a pending optimistic send that identifies it. */
export interface PendingSendMatch {
  /** Exactly the text the server will store for this turn. */
  text: string;
  imageCount: number;
}

/** The part of a transcript entry that identifies it. */
export interface TranscriptEntryKey {
  id?: string;
  role: string;
  at: string;
}

/**
 * Stable key for a transcript entry.
 *
 * The server assigns `id` at append time (server/store.ts appendTranscript), so
 * it is the real handle. The `role@at` fallback covers sessions stored before
 * per-message ids existed; `at` is a per-entry ISO timestamp, so it is stable
 * across refetches, which is the only property this needs.
 *
 * Index position is deliberately NOT used: hidden entries (the kickoff, the
 * feedback-flag hand-off) are stripped from the transcript the client is
 * served, so indices do not line up with what the server stored.
 */
export function entryKey(t: TranscriptEntryKey): string {
  return t.id ?? `${t.role}@${t.at}`;
}

/**
 * Index of the optimistic send matching a now-confirmed user turn, or -1.
 *
 * Matched on content rather than arrival order: a session can be open on two
 * devices, so this client receives `user` events it never sent. Claiming those
 * by position would hand another device's turn to a local bubble and leave the
 * real one unrendered. Identical texts match first-in-first-out, which is the
 * order the server queues them in.
 */
export function findPendingSend(
  pending: readonly PendingSendMatch[],
  text: string,
  imageCount: number
): number {
  return pending.findIndex((p) => p.text === text && p.imageCount === imageCount);
}

/**
 * The visible user turn the server stores when the learner ends a lesson.
 *
 * MUST stay byte-identical to END_TURN_TEXT in server/params.ts — the client
 * renders this turn from the `user` SSE event rather than optimistically, so
 * the two copies never have to agree for correctness; they agree so the demo
 * replay (which has no server) shows the same line the live app does.
 * tests/reconcile.test.ts fails if they drift.
 */
export const END_TURN_TEXT = "Let's stop here \u2014 recap and wrap up.";
