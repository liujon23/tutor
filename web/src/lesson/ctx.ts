import { h, clear } from "../dom.js";
import type { LessonState, MessageFeedback } from "../api.js";
import { findPendingSend } from "./reconcile.js";

export { entryKey } from "./reconcile.js";

// ---------------------------------------------------------------------------
// Shared state for the lesson screen's modules. One instance is created per
// showLesson() call (in screen.ts) and threaded through bubbles/rating/
// wrapup/events/composer in place of the single closure the screen used to
// be. Mutable fields here are exactly the variables that used to cross
// function boundaries inside that closure.
// ---------------------------------------------------------------------------

/** A user bubble on screen that the server has not yet confirmed. */
export interface PendingSend {
  /** Exactly the text the server will store for this turn. */
  text: string;
  imageCount: number;
  el: HTMLElement;
}

export interface LessonCtx {
  readonly id: string;
  lesson: LessonState;

  // Layout elements built once in screen.ts and touched by several modules.
  readonly messages: HTMLElement;
  readonly banner: HTMLElement;
  readonly thinking: HTMLElement;
  readonly endingHint: HTMLElement;
  readonly wrapup: HTMLElement;
  readonly modelBtn: HTMLButtonElement;

  // Keys of transcript entries already on screen. SSE and reconcile both add
  // to this so a refetch appends only what was missed, never a duplicate.
  // A count cannot do this job: `user` events from another device are not
  // rendered locally, so a counter silently falls behind and reconcile then
  // re-renders the tail on every wake.
  renderedIds: Set<string>;

  // User bubbles rendered optimistically, before the server confirmed them and
  // assigned an id. Held until the matching `user` event (or a reconcile)
  // arrives so the turn is adopted rather than rendered a second time.
  pendingSends: PendingSend[];

  // Streaming assistant-text buffer (delta events accumulate here).
  streamEl: HTMLElement | null;
  streamBuf: string;
  renderQueued: boolean;

  // A single reused note for commit progress, so the step updates in place
  // (e.g. "Committing… git commit (4/4)") rather than stacking a note per step.
  commitNote: HTMLElement | null;

  // Per-message feedback/rating state.
  feedbackById: Map<string, MessageFeedback>;
  bubbleByMid: Map<string, HTMLElement>;
  // One rating popover at a time, anchored directly under its message, plus
  // the document-level listeners that close it (kept here so any module can
  // ask for it to close, e.g. on commit or on leaving the lesson).
  popEl: HTMLElement | null;
  popFor: string | null;
  popDocDown: ((e: Event) => void) | null;
  popDocKey: ((e: KeyboardEvent) => void) | null;

  /** Tear down the lesson screen's subscriptions and go back to select. */
  leaveLesson(): void;
}

export function showBanner(
  ctx: LessonCtx,
  text: string,
  action?: { label: string; run: () => void }
): void {
  clear(ctx.banner);
  ctx.banner.classList.remove("hidden");
  ctx.banner.append(h("span", {}, text));
  if (action) {
    ctx.banner.append(h("button", { class: "banner-btn", onclick: action.run }, action.label));
  }
  ctx.banner.append(h("button", { class: "banner-x", onclick: () => ctx.banner.classList.add("hidden") }, "×"));
}

/**
 * Claim a confirmed user turn as one we already rendered optimistically.
 * Returns true when it was ours (the bubble is on screen and only needs its
 * id recorded), false when it came from another device and still needs
 * rendering. Matching on text plus attachment count rather than arrival order
 * keeps two devices sending at once from stealing each other's bubbles.
 */
export function adoptLocalSend(
  ctx: LessonCtx,
  key: string | undefined,
  text: string,
  imageCount: number
): boolean {
  const i = findPendingSend(ctx.pendingSends, text, imageCount);
  if (i === -1) return false;
  ctx.pendingSends.splice(i, 1);
  if (key) ctx.renderedIds.add(key);
  return true;
}

/**
 * Drop an optimistic bubble whose send failed. Nothing was persisted, so
 * leaving it on screen strands a message the tutor never received — and in a
 * spoken client the failure is otherwise inaudible.
 */
export function rollbackLocalSend(ctx: LessonCtx, pending: PendingSend): void {
  const i = ctx.pendingSends.indexOf(pending);
  if (i !== -1) ctx.pendingSends.splice(i, 1);
  pending.el.remove();
}
