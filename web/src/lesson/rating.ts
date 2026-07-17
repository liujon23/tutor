import { h } from "../dom.js";
import { api } from "../api.js";
import type { RatingLevel } from "../api.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";

// ---------------------------------------------------------------------------
// Per-message feedback: rate a tutor message via long-press (touch) /
// right-click (mouse): ±1/±2 with a required note. Only a ⏬ (-2) reaches the
// tutor live; the rest are siloed until wrap-up. No rating = no signal, so
// nothing here is proactive.
// ---------------------------------------------------------------------------

const LEVEL_EMOJI: Record<RatingLevel, string> = { 2: "⏫", 1: "👍", "-1": "👎", "-2": "⏬" };

export function registerAssistantBubble(ctx: LessonCtx, b: HTMLElement, mid: string): void {
  b.dataset.mid = mid;
  ctx.bubbleByMid.set(mid, b);
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRating(ctx, b, mid);
  });
  attachLongPress(b, () => openRating(ctx, b, mid));
  decorateFeedback(ctx, mid);
}

/** Badge on the rated message + (for fired ⏬ flags) the note under it. */
export function decorateFeedback(ctx: LessonCtx, mid: string): void {
  const bubble = ctx.bubbleByMid.get(mid);
  if (!bubble) return;
  const f = ctx.feedbackById.get(mid);
  let badge = bubble.querySelector(":scope > .fb-badge") as HTMLElement | null;
  if (f) {
    if (!badge) {
      badge = h("span", { class: "fb-badge" });
      bubble.append(badge);
    }
    badge.textContent = LEVEL_EMOJI[f.level];
  } else {
    badge?.remove();
  }
  const flagEl = ctx.messages.querySelector(`[data-flag-for="${mid}"]`);
  if (f?.flagged) {
    const text = `⏬ You flagged this — the tutor will adjust. “${f.note}”`;
    if (flagEl) flagEl.textContent = text;
    else bubble.after(h("div", { class: "feedback-flag", "data-flag-for": mid }, text));
  } else {
    flagEl?.remove();
  }
}

/** ~500ms still-finger long-press; cancelled by movement or a second touch. */
function attachLongPress(el: HTMLElement, fire: () => void): void {
  let timer: number | null = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return cancel();
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        fire();
      }, 500);
    },
    { passive: true }
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      if (timer != null && Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10)
        cancel();
    },
    { passive: true }
  );
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

export function closeRating(ctx: LessonCtx): void {
  ctx.popEl?.remove();
  ctx.popEl = null;
  ctx.popFor = null;
  if (ctx.popDocDown) document.removeEventListener("pointerdown", ctx.popDocDown, true);
  if (ctx.popDocKey) document.removeEventListener("keydown", ctx.popDocKey, true);
  ctx.popDocDown = null;
  ctx.popDocKey = null;
}

function openRating(ctx: LessonCtx, bubble: HTMLElement, mid: string): void {
  if (ctx.lesson.commit || ctx.lesson.status !== "active") return; // feedback closed
  if (ctx.popFor === mid) return; // long-press + contextmenu double-fire
  closeRating(ctx);
  const existing = ctx.feedbackById.get(mid);
  let level: RatingLevel | null = existing?.level ?? null;

  const note = h("textarea", {
    class: "fb-note",
    rows: "2",
    placeholder: "Why? (required)",
  }) as HTMLTextAreaElement;
  if (existing) note.value = existing.note;
  const saveBtn = h(
    "button",
    { class: "primary small" },
    existing ? "Update" : "Save"
  ) as HTMLButtonElement;
  const refresh = () => {
    saveBtn.disabled = level == null || !note.value.trim();
  };
  note.addEventListener("input", refresh);

  const thumbRow = h("div", { class: "fb-thumbs" });
  const thumbBtns: [HTMLButtonElement, RatingLevel][] = [];
  for (const [lv, hint] of [
    [2, "Really liked this"],
    [1, "Liked this"],
    [-1, "Didn't like this"],
    [-2, "Really didn't — tutor adjusts now"],
  ] as [RatingLevel, string][]) {
    const btn = h(
      "button",
      {
        class: `fb-thumb ${lv === level ? "on" : ""}`,
        title: hint,
        onclick: () => {
          level = lv;
          for (const [bb, blv] of thumbBtns) bb.classList.toggle("on", blv === lv);
          refresh();
        },
      },
      LEVEL_EMOJI[lv]
    ) as HTMLButtonElement;
    thumbBtns.push([btn, lv]);
    thumbRow.append(btn);
  }

  const actions = h("div", { class: "fb-actions" });
  if (existing) {
    actions.append(
      h(
        "button",
        {
          class: "fb-remove",
          onclick: async () => {
            try {
              await api.clearFeedback(ctx.id, mid);
              ctx.feedbackById.delete(mid);
              decorateFeedback(ctx, mid);
              closeRating(ctx);
            } catch (e) {
              showBanner(ctx, `Couldn't remove rating: ${(e as Error).message}`);
            }
          },
        },
        "Remove"
      )
    );
  }
  actions.append(saveBtn);
  saveBtn.addEventListener("click", async () => {
    const n = note.value.trim();
    if (level == null || !n) return;
    saveBtn.disabled = true;
    try {
      const res = await api.setFeedback(ctx.id, { messageId: mid, level, note: n });
      const prev = ctx.feedbackById.get(mid);
      ctx.feedbackById.set(mid, {
        messageId: mid,
        level,
        note: n,
        at: new Date().toISOString(),
        flagged: prev?.flagged || res.flagged,
      });
      decorateFeedback(ctx, mid);
      closeRating(ctx);
    } catch (e) {
      saveBtn.disabled = false;
      showBanner(ctx, `Couldn't save rating: ${(e as Error).message}`);
    }
  });

  const popEl = h(
    "div",
    { class: "fb-pop" },
    thumbRow,
    note,
    h("div", { class: "fb-hint" }, "⏬ reaches the tutor right away; other ratings wait for the wrap-up. Unrated messages mean nothing."),
    actions
  );
  ctx.popEl = popEl;
  ctx.popFor = mid;
  bubble.after(popEl);
  refresh();
  const onDocDown = (e: Event) => {
    if (ctx.popEl && !ctx.popEl.contains(e.target as Node)) closeRating(ctx);
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeRating(ctx);
  };
  ctx.popDocDown = onDocDown;
  ctx.popDocKey = onDocKey;
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onDocKey, true);
  popEl.scrollIntoView({ block: "nearest" });
  note.focus();
}
