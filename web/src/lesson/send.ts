import { api } from "../api.js";
import type { OutgoingImage, Via } from "../api.js";
import type { LessonCtx, PendingSend } from "./ctx.js";
import { rollbackLocalSend } from "./ctx.js";
import { addBubble, scrollDown } from "./bubbles.js";

// ---------------------------------------------------------------------------
// Sending one learner turn — shared by the composer and drive mode, so both
// follow the same sequence: optimistic bubble, pending-send bookkeeping (the
// `user` echo or a reconcile then adopts the bubble instead of drawing a
// second one), thinking indicator, and rollback when the POST fails.
// ---------------------------------------------------------------------------

export interface PickedImage {
  out: OutgoingImage;
  preview: string;
}

export type SendOutcome =
  | { status: "sent" }
  | { status: "empty" } // nothing to send — no bubble drawn
  | { status: "failed"; error: string }; // bubble removed; nothing was persisted

export async function sendTurn(
  ctx: LessonCtx,
  text: string,
  opts: { images?: PickedImage[]; via?: Via; heard?: string } = {}
): Promise<SendOutcome> {
  const trimmed = text.trim();
  const images = opts.images ?? [];
  if (!trimmed && images.length === 0) return { status: "empty" };
  // Rendered now, confirmed later: the server assigns the id, and the
  // matching `user` event (or a reconcile) adopts this bubble. The pending
  // text must be exactly what the server stores — it trims too.
  const el = addBubble(ctx, "user", trimmed, images.map((p) => p.preview));
  const pending: PendingSend = { text: trimmed, imageCount: images.length, el };
  ctx.pendingSends.push(pending);
  ctx.thinking.classList.remove("hidden");
  scrollDown(ctx, true);
  try {
    await api.sendMessage(ctx.id, trimmed, images.map((p) => p.out), opts.via, opts.heard);
    return { status: "sent" };
  } catch (e) {
    // Nothing was persisted, so take the bubble back off screen rather than
    // leaving a message the tutor never saw looking delivered.
    rollbackLocalSend(ctx, pending);
    ctx.thinking.classList.add("hidden");
    return { status: "failed", error: (e as Error).message };
  }
}
