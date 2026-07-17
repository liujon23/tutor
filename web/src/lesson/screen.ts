import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { LessonModel, LessonState } from "../api.js";
import { root, showSelect } from "../main.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";
import { addBubble, addNote, photoUrls, scrollDown } from "./bubbles.js";
import { closeRating } from "./rating.js";
import { showWrapup, mapError, refreshEndingHint } from "./wrapup.js";
import { subscribeEvents } from "./events.js";
import { buildComposer } from "./composer.js";

// ---------------------------------------------------------------------------
// Lesson screen
// ---------------------------------------------------------------------------

export async function showLesson(id: string): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading lesson…"));
  let lesson: LessonState;
  try {
    lesson = await api.lesson(id);
  } catch (e) {
    clear(root);
    root.append(h("div", { class: "error-box" }, (e as Error).message));
    return;
  }
  clear(root);

  const screen = h("div", { class: "screen lesson" });
  const messages = h("div", { class: "messages" });
  const banner = h("div", { class: "banner hidden" });
  const endingHint = h("div", { class: "ending-hint hidden" });
  const wrapup = h("div", { class: "wrapup hidden" });
  const thinking = h("div", { class: "thinking hidden" }, h("span", { class: "dots" }, "· · ·"));

  // Header
  const modelBtn = h(
    "button",
    {
      class: "hdr-chip",
      onclick: async () => {
        const next: LessonModel = lesson.params.model === "opus" ? "sonnet" : "opus";
        try {
          await api.setModel(id, next);
          lesson.params.model = next;
          modelBtn.textContent = next;
        } catch (e) {
          alert((e as Error).message);
        }
      },
    },
    lesson.params.model
  );

  // Streaming/rating/feedback state shared across bubbles/rating/wrapup/events/
  // composer, in place of the single closure the screen used to be.
  let closeEventsAndVisibility: (() => void) | null = null;
  const ctx: LessonCtx = {
    id,
    lesson,
    messages,
    banner,
    thinking,
    endingHint,
    wrapup,
    modelBtn,
    renderedCount: 0,
    streamEl: null,
    streamBuf: "",
    renderQueued: false,
    commitNote: null,
    feedbackById: new Map(),
    bubbleByMid: new Map(),
    popEl: null,
    popFor: null,
    popDocDown: null,
    popDocKey: null,
    leaveLesson: () => {
      closeEventsAndVisibility?.();
      closeRating(ctx);
      void showSelect();
    },
  };
  for (const f of lesson.feedback ?? []) ctx.feedbackById.set(f.messageId, f);

  const endBtn = h(
    "button",
    {
      class: "hdr-chip end",
      onclick: async () => {
        if (lesson.commit) return;
        endBtn.setAttribute("disabled", "");
        addBubble(ctx, "user", "Let's stop here — recap and wrap up.");
        thinking.classList.remove("hidden");
        ctx.renderedCount++; // server persists the wrap-up request to the transcript
        try {
          const res = await api.endLesson(id);
          lesson.ending = true;
          if (res.alreadyCommitted) addNote(ctx, "Already committed.");
        } catch (e) {
          thinking.classList.add("hidden");
          showBanner(ctx, `Couldn't end: ${(e as Error).message}`);
        } finally {
          endBtn.removeAttribute("disabled");
        }
      },
    },
    "End lesson"
  );
  const moreBtn = h(
    "button",
    {
      class: "hdr-chip danger",
      onclick: async () => {
        if (!confirm("Abandon this lesson? Nothing will be written back.")) return;
        await api.abandon(id);
        ctx.leaveLesson();
      },
    },
    "Abandon"
  );
  screen.append(
    h(
      "header",
      { class: "app-header lesson-header" },
      h(
        "button",
        {
          class: "back",
          onclick: () => ctx.leaveLesson(),
        },
        "‹"
      ),
      h("div", { class: "hdr-title" }, h("strong", {}, lesson.title || "Lesson"), h("span", { class: "hdr-sub" }, lesson.params.size)),
      modelBtn,
      endBtn,
      moreBtn
    )
  );

  screen.append(banner, messages, thinking, endingHint, wrapup);

  // Composer
  const { chipRow, composer } = buildComposer(ctx);
  screen.append(chipRow, composer);
  root.append(screen);

  // --- initial transcript render ---------------------------------------------

  for (const t of lesson.transcript) {
    addBubble(ctx, t.role, t.text, photoUrls(t), t.id);
    ctx.renderedCount++;
  }
  if (lesson.status === "abandoned") addNote(ctx, "This lesson was abandoned.");
  if (lesson.commit) showWrapup(ctx, lesson.commit);
  if (lesson.lastError && !lesson.commit) showBanner(ctx, mapError(lesson.lastError));
  refreshEndingHint(ctx);

  // --- events -----------------------------------------------------------------

  closeEventsAndVisibility = subscribeEvents(ctx);

  scrollDown(ctx, true);
}
