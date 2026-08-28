import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { CommitResult, LessonUsage, RecallRecord } from "../api.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";
import { addNote, scrollDown } from "./bubbles.js";

// ---------------------------------------------------------------------------
// Wrap-up panel: usage rendering, the committed view, confirmed-pattern
// approval, error mapping, and the ending-hint refresh.
// ---------------------------------------------------------------------------

function renderUsage(u: LessonUsage): HTMLElement {
  const nf = new Intl.NumberFormat("en-US");
  const t = u.tokens;
  const cacheTotal = t.cacheRead + t.cacheCreation;
  const total = t.input + t.output + cacheTotal;
  const dur = (ms: number): string => {
    const s = Math.round(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    if (hh > 0) return `${hh}h ${mm}m`;
    if (mm > 0) return `${mm}m ${s % 60}s`;
    return `${s % 60}s`;
  };

  const box = h("div", { class: "wrapup-usage" });
  box.append(h("h3", {}, "This lesson used"));

  box.append(
    h(
      "div",
      { class: "usage-tokens" },
      h("span", { class: "usage-big" }, nf.format(total)),
      h("span", { class: "usage-unit" }, " tokens")
    )
  );
  box.append(
    h(
      "div",
      { class: "usage-breakdown" },
      `${nf.format(t.input)} in · ${nf.format(t.output)} out · ${nf.format(cacheTotal)} cache`
    )
  );

  // Dollars are a computed equivalent at API rates — subscriptions aren't metered.
  box.append(
    h(
      "div",
      { class: "usage-cost" },
      h("strong", {}, `≈ $${u.costUsd.toFixed(2)}`),
      h(
        "span",
        { class: "usage-note" },
        __DEMO__
          ? " equivalent at API rates — the author's subscription isn't billed per token"
          : " equivalent at API rates — your Pro plan isn't billed per token"
      )
    )
  );

  const facts: string[] = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`];
  if (u.features.webSearch) facts.push(`${u.features.webSearch}× web search`);
  if (u.features.webFetch) facts.push(`${u.features.webFetch}× web fetch`);
  if (u.features.photos) facts.push(`${u.features.photos} photo${u.features.photos === 1 ? "" : "s"}`);
  const models = Object.keys(u.byModel);
  if (models.length > 1) facts.push(`models: ${models.join(" + ")}`);
  box.append(h("div", { class: "usage-facts" }, facts.join(" · ")));

  // Wall-clock is elapsed time, not effort — it counts any time you stepped
  // away mid-lesson, so treat it as rough.
  box.append(
    h(
      "div",
      { class: "usage-facts" },
      `${dur(u.wallClockMs)} elapsed `,
      h("span", { class: "usage-note" }, "(rough — includes any time away from the lesson)")
    )
  );

  return box;
}

/**
 * The recall-mode counterpart of showWrapup. Reuses the same .wrapup container
 * and classes — a recall check has no lesson number, no proposed patterns, and
 * no approval gate, so none of showWrapup's machinery applies, but the shape of
 * the panel is the same.
 */
export function showRecallPanel(ctx: LessonCtx, recall: RecallRecord): void {
  ctx.commitNote?.remove();
  ctx.commitNote = null;
  clear(ctx.wrapup);
  ctx.wrapup.classList.remove("hidden");
  ctx.wrapup.append(h("h2", {}, "Recall recorded"));
  const ul = h("ul", { class: "wrapup-summary" });
  for (const g of recall.graded) {
    const back = g.nextInDays >= 60 ? `~${Math.round(g.nextInDays / 30)} months` : `~${g.nextInDays} days`;
    ul.append(h("li", {}, `${g.name} — ${g.result} · streak ${g.streak} · back in ${back}`));
  }
  ctx.wrapup.append(ul);
  // summary carries what actually hit disk — and, on a post-write failure, the
  // only warning that the grade was saved but never versioned. gitMessage is ""
  // in that case, so without this the panel would look like a clean success.
  const details = h("ul", { class: "wrapup-summary" });
  for (const line of recall.summary) details.append(h("li", {}, line));
  ctx.wrapup.append(details);
  if (recall.usage) ctx.wrapup.append(renderUsage(recall.usage));
  if (recall.gitMessage) ctx.wrapup.append(h("div", { class: "wrapup-git" }, recall.gitMessage));
  ctx.wrapup.append(
    h(
      "button",
      {
        class: "secondary small",
        onclick: async () => {
          // The grade is already durable in curriculum.yaml and git. The session
          // file (transcript included) is transient scratch under .app/ — never
          // archived, never versioned — so abandoning it loses nothing that counts.
          try {
            await api.abandon(ctx.id);
          } catch {
            /* best-effort cleanup; leaving it costs only a session file */
          }
          ctx.leaveLesson();
        },
      },
      "Back to start"
    )
  );
  scrollDown(ctx, true);
}

export function showWrapup(ctx: LessonCtx, commit: CommitResult): void {
  // The commit finished — drop the live "Committing…" note; the panel says it now.
  ctx.commitNote?.remove();
  ctx.commitNote = null;
  clear(ctx.wrapup);
  ctx.wrapup.classList.remove("hidden");
  ctx.wrapup.append(h("h2", {}, `Lesson ${commit.lessonNumber} committed`));
  const ul = h("ul", { class: "wrapup-summary" });
  for (const s of commit.summary) ul.append(h("li", {}, s));
  ctx.wrapup.append(ul);
  if (commit.usage) ctx.wrapup.append(renderUsage(commit.usage));
  ctx.wrapup.append(h("div", { class: "wrapup-git" }, commit.gitMessage));

  if (commit.proposedConfirmedPatterns.length > 0 && !commit.patternsResolved) {
    ctx.wrapup.append(h("h3", {}, "Proposed confirmed patterns — your call"));
    const checks: { box: HTMLInputElement; text: string }[] = [];
    for (const p of commit.proposedConfirmedPatterns) {
      const box = h("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = true;
      checks.push({ box, text: p });
      ctx.wrapup.append(h("label", { class: "pattern-row" }, box, h("span", {}, p)));
    }
    const applyBtn = h(
      "button",
      {
        class: "primary small",
        onclick: async () => {
          const approve = checks.filter((c) => c.box.checked).map((c) => c.text);
          try {
            const res = await api.approvePatterns(ctx.id, approve);
            commit.patternsResolved = true;
            showWrapup(ctx, commit);
            addNote(
              ctx,
              res.applied > 0
                ? `${res.applied} confirmed pattern(s) approved and written to your profile.`
                : "Proposals dismissed — nothing written."
            );
          } catch (e) {
            alert((e as Error).message);
          }
        },
      },
      "Apply my selections"
    ) as HTMLButtonElement;
    ctx.wrapup.append(h("div", { class: "pattern-actions" }, applyBtn));
  } else if (commit.patternsResolved) {
    ctx.wrapup.append(h("div", { class: "wrapup-resolved" }, "Confirmed-pattern proposals resolved."));
  }
  ctx.wrapup.append(
    h("button", { class: "secondary small", onclick: () => ctx.leaveLesson() }, "Back to start")
  );
  scrollDown(ctx, true);
}

export function mapError(raw: string): string {
  switch (raw) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "Auth failed — the subscription token may have expired. On the host PC, re-run `claude setup-token` and restart the server.";
    case "rate_limit":
      return "Hit the Pro rate limit — wait for the window to reset, or switch to Sonnet.";
    case "billing_error":
      return "Billing error from the API. Check the subscription/credits on the host.";
    case "overloaded":
      return "The model is overloaded right now — try again in a moment.";
    default:
      return raw;
  }
}

// Show a persistent "ended but not committed" hint with a retry, so a lesson
// whose model wrapped up without calling commit_session isn't silently lost.
export function refreshEndingHint(ctx: LessonCtx): void {
  if (ctx.lesson.ending && !ctx.lesson.commit && ctx.lesson.status !== "abandoned") {
    clear(ctx.endingHint);
    ctx.endingHint.classList.remove("hidden");
    ctx.endingHint.append(
      h("span", {}, "This lesson ended but hasn't been committed yet — nothing is saved until it is."),
      h(
        "button",
        {
          class: "ending-btn",
          onclick: async () => {
            try {
              await api.endLesson(ctx.id);
              ctx.thinking.classList.remove("hidden");
            } catch (e) {
              showBanner(ctx, (e as Error).message);
            }
          },
        },
        "Ask the tutor to commit"
      )
    );
  } else {
    ctx.endingHint.classList.add("hidden");
  }
}
