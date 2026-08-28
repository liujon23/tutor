import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { LessonModel, LessonState } from "../api.js";
import { root, showSelect } from "../main.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";
import { addBubble, addNote, photoUrls, scrollDown } from "./bubbles.js";
import { closeRating } from "./rating.js";
import { showWrapup, showRecallPanel, mapError, refreshEndingHint } from "./wrapup.js";
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

  // A recall check reuses this whole screen — only the header chips and the
  // end-of-session panel differ, and both read off params.mode.
  const isRecall = lesson.params.mode === "recall";

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
        // A recorded recall check has already written its grade to curriculum.yaml
        // and git — abandoning drops the conversation, not the grade.
        const warning = isRecall
          ? lesson.recall
            ? "Close this recall check? The grade is already saved and won't be undone."
            : "Close this recall check? Nothing has been graded yet."
          : "Abandon this lesson? Nothing will be written back.";
        if (!confirm(warning)) return;
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
      h(
        "div",
        { class: "hdr-title" },
        h("strong", {}, lesson.title || "Lesson"),
        h("span", { class: "hdr-sub" }, isRecall ? "quick recall" : lesson.params.size)
      ),
      // Model switch and abandon are meaningless against a fixed recording.
      __DEMO__ ? null : modelBtn,
      // A recall check has no commit_session tool, so the wrap-up checklist the
      // End button sends would be an instruction it cannot follow — the server
      // 409s it too. The check closes when the learner taps "Back to start" on
      // the recall panel (or the 24h sweep collects it); nothing flips its
      // status the way a commit does.
      isRecall ? null : endBtn,
      __DEMO__ ? null : moreBtn
    )
  );

  screen.append(banner, messages, thinking, endingHint, wrapup);
  // Demo mode: a dismissible banner explaining the replay, from the recording's note.
  if (__DEMO__ && lesson.note) showBanner(ctx, lesson.note);

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
  if (lesson.recall) showRecallPanel(ctx, lesson.recall);
  if (lesson.lastError && !lesson.commit) showBanner(ctx, mapError(lesson.lastError));
  refreshEndingHint(ctx);

  // --- events -----------------------------------------------------------------

  closeEventsAndVisibility = subscribeEvents(ctx);

  scrollDown(ctx, true);
}
