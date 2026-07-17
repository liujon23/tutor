import { h, clear } from "../dom.js";
import type { LessonState, MessageFeedback } from "../api.js";

// ---------------------------------------------------------------------------
// Shared state for the lesson screen's modules. One instance is created per
// showLesson() call (in screen.ts) and threaded through bubbles/rating/
// wrapup/events/composer in place of the single closure the screen used to
// be. Mutable fields here are exactly the variables that used to cross
// function boundaries inside that closure.
// ---------------------------------------------------------------------------

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

  // Count of transcript entries already on screen. SSE and reconcile both
  // keep this in sync so a refetch appends only what was missed, never a
  // duplicate.
  renderedCount: number;

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
