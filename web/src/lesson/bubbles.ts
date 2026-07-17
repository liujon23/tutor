import { h } from "../dom.js";
import { renderInto } from "../markdown.js";
import type { TranscriptEntry } from "../api.js";
import type { LessonCtx } from "./ctx.js";
import { registerAssistantBubble } from "./rating.js";

// ---------------------------------------------------------------------------
// Message rendering: bubbles, notes, the streaming text buffer, and the
// commit-progress indicator.
// ---------------------------------------------------------------------------

const nearBottom = (ctx: LessonCtx): boolean =>
  ctx.messages.scrollHeight - ctx.messages.scrollTop - ctx.messages.clientHeight < 160;

export function scrollDown(ctx: LessonCtx, force = false): void {
  if (force || nearBottom(ctx)) ctx.messages.scrollTop = ctx.messages.scrollHeight;
}

export function addBubble(
  ctx: LessonCtx,
  role: "user" | "assistant",
  text: string,
  images: string[] = [],
  mid?: string
): HTMLElement {
  const b = h("div", { class: `bubble ${role}` });
  if (role === "assistant") renderInto(b, text);
  else {
    for (const src of images) b.append(h("img", { class: "sent-photo", src, alt: "photo" }));
    if (text) b.append(h("div", {}, text));
  }
  ctx.messages.append(b);
  if (role === "assistant" && mid) registerAssistantBubble(ctx, b, mid);
  scrollDown(ctx, true);
  return b;
}

/** Server-stored inbound photo names → asset-route URLs. */
export function photoUrls(t: TranscriptEntry): string[] {
  return (t.images ?? []).map((name) => `/api/assets/local/${encodeURIComponent(name)}`);
}

export function addNote(ctx: LessonCtx, text: string): void {
  ctx.messages.append(h("div", { class: "note" }, text));
  scrollDown(ctx);
}

// A single reused note for commit progress, so the step updates in place
// (e.g. "Committing… git commit (4/4)") rather than stacking a note per step.
export function setCommitProgress(ctx: LessonCtx, text: string): void {
  if (!ctx.commitNote) {
    ctx.commitNote = h("div", { class: "note" }, text);
    ctx.messages.append(ctx.commitNote);
  } else {
    ctx.commitNote.textContent = text;
  }
  scrollDown(ctx);
}

export function renderStream(ctx: LessonCtx): void {
  if (ctx.renderQueued || !ctx.streamEl) return;
  ctx.renderQueued = true;
  requestAnimationFrame(() => {
    ctx.renderQueued = false;
    if (ctx.streamEl) {
      // finalize: false — mermaid fences stay as placeholder boxes while
      // streaming; they render to SVG when the final assistant text lands.
      renderInto(ctx.streamEl, ctx.streamBuf, { finalize: false });
      scrollDown(ctx);
    }
  });
}
