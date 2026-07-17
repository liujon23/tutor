import { api } from "../api.js";
import { renderInto } from "../markdown.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";
import { addBubble, photoUrls, renderStream, scrollDown, setCommitProgress } from "./bubbles.js";
import { registerAssistantBubble, decorateFeedback, closeRating } from "./rating.js";
import { showWrapup, mapError, refreshEndingHint } from "./wrapup.js";

// ---------------------------------------------------------------------------
// The SSE subscription: the event-type switch, reconnect/reconcile logic,
// visibilitychange handling.
// ---------------------------------------------------------------------------

/**
 * Subscribe to the lesson's SSE stream and wire up reconcile-on-reopen plus
 * visibilitychange handling. Returns a cleanup function that closes the
 * stream and removes the visibility listener.
 */
export function subscribeEvents(ctx: LessonCtx): () => void {
  // SSE has no replay. After a reconnect (or when the PWA returns to foreground),
  // refetch the authoritative state and append anything the stream missed.
  let reconciling = false;
  async function reconcile(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const fresh = await api.lesson(ctx.id);
      ctx.lesson.status = fresh.status;
      ctx.lesson.ending = fresh.ending;
      // Drop a dangling partial stream bubble — its finalized text is in the transcript.
      if (ctx.streamEl) {
        ctx.streamEl.remove();
        ctx.streamEl = null;
        ctx.streamBuf = "";
      }
      for (let i = ctx.renderedCount; i < fresh.transcript.length; i++) {
        const t = fresh.transcript[i];
        addBubble(ctx, t.role, t.text, photoUrls(t), t.id);
      }
      ctx.renderedCount = Math.max(ctx.renderedCount, fresh.transcript.length);
      // Re-sync ratings (badges + flag notes) — covers changes from other devices.
      const staleIds = new Set(ctx.feedbackById.keys());
      ctx.feedbackById.clear();
      for (const f of fresh.feedback ?? []) ctx.feedbackById.set(f.messageId, f);
      for (const mid of new Set([...staleIds, ...ctx.feedbackById.keys()])) decorateFeedback(ctx, mid);
      ctx.lesson.feedback = fresh.feedback;
      if (fresh.commit && !ctx.lesson.commit) {
        ctx.lesson.commit = fresh.commit;
        ctx.lesson.status = "committed";
        ctx.thinking.classList.add("hidden");
        showWrapup(ctx, fresh.commit);
      }
      if (fresh.lastError && !fresh.commit) showBanner(ctx, mapError(fresh.lastError));
      refreshEndingHint(ctx);
    } catch {
      /* offline or gone — leave the screen as-is */
    } finally {
      reconciling = false;
    }
  }

  const closeEvents = api.events(
    ctx.id,
    (ev) => {
      switch (ev.type) {
        case "user":
          // Echo of our own send is already rendered locally; ignore duplicates
          break;
        case "delta":
          if (!ctx.streamEl) {
            ctx.streamBuf = "";
            ctx.streamEl = addBubble(ctx, "assistant", "");
            ctx.streamEl.classList.add("streaming");
            ctx.thinking.classList.add("hidden");
          }
          ctx.streamBuf += ev.text;
          renderStream(ctx);
          break;
        case "assistant":
          if (ctx.streamEl) {
            renderInto(ctx.streamEl, ev.text);
            ctx.streamEl.classList.remove("streaming");
            // The finalized message now has its id — make it rateable.
            if (ev.id) registerAssistantBubble(ctx, ctx.streamEl, ev.id);
            ctx.streamEl = null;
            ctx.streamBuf = "";
          } else {
            addBubble(ctx, "assistant", ev.text, [], ev.id);
          }
          ctx.renderedCount++; // the server persists this assistant turn to the transcript
          scrollDown(ctx);
          break;
        case "tool_use":
          if (ev.name.includes("commit_session")) setCommitProgress(ctx, "Committing session…");
          break;
        case "feedback_flag": {
          // A ⏬ fired (this device or another) — show the note under the message.
          const prev = ctx.feedbackById.get(ev.messageId);
          ctx.feedbackById.set(ev.messageId, {
            messageId: ev.messageId,
            level: -2,
            note: ev.note,
            at: new Date().toISOString(),
            flagged: true,
          });
          if (!prev || prev.note !== ev.note || !prev.flagged) decorateFeedback(ctx, ev.messageId);
          break;
        }
        case "committed":
          ctx.lesson.commit = ev.commit;
          ctx.lesson.status = "committed";
          ctx.endingHint.classList.add("hidden");
          closeRating(ctx); // ratings close at commit
          showWrapup(ctx, ev.commit);
          break;
        case "turn_done":
          ctx.thinking.classList.add("hidden");
          ctx.streamEl?.classList.remove("streaming");
          ctx.streamEl = null;
          if (ev.isError && ev.errors?.length) showBanner(ctx, `Something went wrong: ${ev.errors[0]}`);
          refreshEndingHint(ctx);
          break;
        case "rate_limit":
          if (ev.status === "rejected" || ev.status === "allowed_warning") {
            const when = ev.resetsAt ? new Date(ev.resetsAt * 1000).toLocaleTimeString() : "later";
            showBanner(
              ctx,
              `Your Claude usage window is ${ev.status === "rejected" ? "exhausted" : "nearly exhausted"} (resets ${when}). It's shared with your other Claude use.`,
              ctx.lesson.params.model === "opus"
                ? {
                    label: "Switch to Sonnet",
                    run: async () => {
                      await api.setModel(ctx.id, "sonnet");
                      ctx.lesson.params.model = "sonnet";
                      ctx.modelBtn.textContent = "sonnet";
                      ctx.banner.classList.add("hidden");
                    },
                  }
                : undefined
            );
          }
          break;
        case "api_error":
          showBanner(ctx, mapError(ev.error));
          break;
        case "error":
          ctx.thinking.classList.add("hidden");
          showBanner(ctx, mapError(ev.message));
          break;
        case "closed":
          // Server-side runner wound down; EventSource will reconnect and revive it.
          break;
        default:
          break;
      }
    },
    // onReopen: the stream dropped and came back — pull anything we missed.
    () => void reconcile()
  );

  // The PWA returning to the foreground is the other common gap (iOS suspends
  // EventSource when backgrounded); reconcile on visibility too.
  const onVisible = () => {
    if (document.visibilityState === "visible") void reconcile();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    closeEvents();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
