import "./style.css";
import { api } from "./api.js";
import type {
  LessonModel,
  LessonState,
  MessageFeedback,
  OutgoingImage,
  RatingLevel,
  SessionSize,
  Status,
  StatusLane,
  CommitResult,
  LessonUsage,
  TranscriptEntry,
} from "./api.js";
import { renderInto } from "./markdown.js";
import { showStats } from "./stats.js";

const root = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | ((ev: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function clear(el: HTMLElement): void {
  el.replaceChildren();
}

/**
 * Pick one lane at random, weighted by the lanes' weights. Drawn fresh on every
 * call, so refreshing re-rolls the pick while still following the weight
 * distribution over many draws. Falls back to the first lane if weights are all
 * zero.
 */
function pickLane(lanes: StatusLane[]): StatusLane | undefined {
  if (lanes.length === 0) return undefined;
  const total = lanes.reduce((s, l) => s + Math.max(0, l.weight), 0);
  if (total <= 0) return lanes[0];
  let target = Math.random() * total;
  for (const lane of lanes) {
    target -= Math.max(0, lane.weight);
    if (target < 0) return lane;
  }
  return lanes[lanes.length - 1];
}

// ---------------------------------------------------------------------------
// Select screen
// ---------------------------------------------------------------------------

async function showSelect(): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading…"));
  void checkForUpdate(); // fire-and-forget: never blocks the select screen
  let status: Status;
  try {
    status = await api.status();
  } catch (e) {
    clear(root);
    root.append(h("div", { class: "error-box" }, `Couldn't reach the server: ${(e as Error).message}`));
    return;
  }
  clear(root);

  let selectedLane: string | undefined =
    [...status.lanes].sort((a, b) => b.weight - a.weight)[0]?.id;
  let selectedTopic: string | undefined;
  let size: SessionSize = "standard";
  let model: LessonModel = "opus";
  let modelTouched = false; // true once the user explicitly taps a model button
  const recallPicked = new Set<string>();

  const screen = h("div", { class: "screen select" });

  screen.append(
    h(
      "header",
      { class: "app-header" },
      h("h1", {}, "Tutor"),
      h("span", { class: "date" }, status.today),
      h("button", { class: "stats-link", onclick: () => void showStats(root, () => void showSelect()) }, "Stats")
    )
  );

  // Needs-attention: proposals awaiting the gate, or a lesson ended without a commit.
  if (status.attention.length > 0) {
    const att = h("section", { class: "card attention" }, h("h2", {}, "Needs your attention"));
    for (const a of status.attention) {
      const label =
        a.reason === "pending-approval"
          ? "confirmed-pattern proposals awaiting your yes/no"
          : "ended but not committed yet";
      att.append(
        h(
          "button",
          { class: "attention-row", onclick: () => showLesson(a.id) },
          h("span", { class: "attention-title" }, a.title || "Lesson"),
          h("span", { class: "attention-reason" }, label)
        )
      );
    }
    screen.append(att);
  }

  // Resume in-flight lessons (excluding any already surfaced under attention).
  const attentionIds = new Set(status.attention.map((a) => a.id));
  const resumable = status.activeSessions.filter((s) => !attentionIds.has(s.id));
  if (resumable.length > 0) {
    const resume = h("section", { class: "card resume" }, h("h2", {}, "In progress"));
    for (const s of resumable) {
      resume.append(
        h(
          "button",
          { class: "resume-row", onclick: () => showLesson(s.id) },
          h("span", { class: "resume-title" }, s.title || "Lesson"),
          h("span", { class: "resume-meta" }, `${s.params.size} · started ${s.createdAt.slice(0, 10)}`)
        )
      );
    }
    screen.append(resume);
  }

  // ---- Today's pick -------------------------------------------------------
  // One track, drawn at random from the lane weights rather than shown as a
  // menu. The draw is fresh each load, so refreshing re-rolls it while still
  // following the weight distribution over many visits.
  const picked = pickLane(status.lanes);
  if (picked) selectedLane = picked.id;

  const laneCards = new Map<string, HTMLElement>();
  let pickCard: HTMLElement | undefined;

  const recLineFor = (rec: StatusLane["recommendation"]): string =>
    rec.topicName
      ? `Next: ${rec.topicName}`
      : rec.unitId
        ? `Next unit: ${rec.unitName ?? rec.unitId}`
        : "Nothing queued";

  const refreshSelection = () => {
    pickCard?.classList.toggle("selected", !!picked && selectedLane === picked.id && !selectedTopic);
    for (const [id, card] of laneCards) {
      card.classList.toggle("selected", id === selectedLane && !selectedTopic);
    }
    refreshStart();
  };

  // A selectable lane card (used in the "show every lane" override panel).
  const laneCard = (lane: StatusLane): HTMLElement => {
    const card = h(
      "button",
      {
        class: "card lane-card",
        onclick: () => {
          selectedLane = lane.id;
          selectedTopic = undefined;
          refreshSelection();
        },
      },
      h("div", { class: "lane-head" }, h("strong", {}, lane.name), h("span", { class: "weight" }, `~${lane.weight}%`)),
      lane.currentUnit ? h("div", { class: "lane-unit" }, `${lane.currentUnit.name} · ${lane.currentUnit.state}`) : null,
      h("div", { class: "lane-next" }, recLineFor(lane.recommendation)),
      lane.recommendation.plan ? h("div", { class: "lane-plan" }, lane.recommendation.plan) : null
    );
    laneCards.set(lane.id, card);
    return card;
  };

  if (picked) {
    const rec = picked.recommendation;
    // Prominent card; tapping it re-selects the pick after an override.
    pickCard = h(
      "button",
      {
        class: "card recommended lane-card",
        onclick: () => {
          selectedLane = picked.id;
          selectedTopic = undefined;
          refreshSelection();
        },
      },
      h("div", { class: "welcome" }, "Welcome back! Here's a track to start with — refresh for a different one."),
      h("div", { class: "rec-lane" }, picked.name),
      picked.currentUnit ? h("div", { class: "lane-unit" }, `${picked.currentUnit.name} · ${picked.currentUnit.state}`) : null,
      h("div", { class: "lane-next" }, rec.topicName ?? recLineFor(rec)),
      rec.plan ? h("div", { class: "lane-plan" }, rec.plan) : null
    );
    screen.append(pickCard);
  } else {
    screen.append(h("section", { class: "card" }, "No tracks are set up yet."));
  }

  // ---- Override -----------------------------------------------------------
  // Compact bar → two ways to override the pick: browse every lane, or search
  // for a specific topic.
  const allLanesPanel = h("div", { class: "lanes override-panel hidden" });
  for (const lane of status.lanes) allLanesPanel.append(laneCard(lane));

  const pickerList = h("div", { class: "picker-list" });
  const pickerInput = h("input", {
    class: "picker-input",
    type: "search",
    placeholder: "Search topics…",
    oninput: () => renderPickerList(),
  }) as HTMLInputElement;
  const renderPickerList = () => {
    clear(pickerList);
    const q = pickerInput.value.toLowerCase();
    const rows = status.topics
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q))
      .slice(0, 30);
    for (const t of rows) {
      pickerList.append(
        h(
          "button",
          {
            class: `picker-row ${selectedTopic === t.id ? "on" : ""}`,
            onclick: () => {
              selectedTopic = selectedTopic === t.id ? undefined : t.id;
              renderPickerList();
              refreshSelection();
            },
          },
          h("span", {}, t.name),
          h("span", { class: "picker-meta" }, `${t.unitName} · ${t.state}`)
        )
      );
    }
  };
  const topicPanel = h("div", { class: "override-panel hidden" }, pickerInput, pickerList);

  const optLanes = h("button", { class: "override-opt" }, "Show every lane");
  const optTopic = h("button", { class: "override-opt" }, "Pick a specific topic");
  const overrideOptions = h("div", { class: "override-options hidden" }, optLanes, optTopic);
  const overrideToggle = h("button", { class: "override-toggle" }, "Choose a different track ▾");

  const setPanels = (which: "none" | "lanes" | "topic") => {
    allLanesPanel.classList.toggle("hidden", which !== "lanes");
    topicPanel.classList.toggle("hidden", which !== "topic");
    optLanes.classList.toggle("on", which === "lanes");
    optTopic.classList.toggle("on", which === "topic");
    if (which === "topic") renderPickerList();
  };
  let overrideOpen = false;
  overrideToggle.addEventListener("click", () => {
    overrideOpen = !overrideOpen;
    overrideOptions.classList.toggle("hidden", !overrideOpen);
    overrideToggle.textContent = overrideOpen ? "Choose a different track ▴" : "Choose a different track ▾";
    if (!overrideOpen) setPanels("none");
  });
  optLanes.addEventListener("click", () => setPanels(allLanesPanel.classList.contains("hidden") ? "lanes" : "none"));
  optTopic.addEventListener("click", () => setPanels(topicPanel.classList.contains("hidden") ? "topic" : "none"));

  screen.append(
    h("section", { class: "card override" }, overrideToggle, overrideOptions, allLanesPanel, topicPanel)
  );

  // ---- Recall warm-ups (optional) ----------------------------------------
  if (status.recallCandidates.length > 0) {
    const chips = h("section", { class: "card recall" }, h("h2", {}, "Recall warm-ups (tap to include)"));
    const row = h("div", { class: "chip-row" });
    for (const r of status.recallCandidates) {
      const chip = h(
        "button",
        {
          class: "chip",
          onclick: () => {
            if (recallPicked.has(r.topicId)) recallPicked.delete(r.topicId);
            else recallPicked.add(r.topicId);
            chip.classList.toggle("on", recallPicked.has(r.topicId));
          },
        },
        `${r.name} · ${r.daysStale}d`
      );
      row.append(chip);
    }
    chips.append(row);
    screen.append(chips);
  }

  // ---- Session size + model ----------------------------------------------
  // modelRow is built first so sizeRow's handler can drive its "on" state:
  // picking "tight" preselects Sonnet (and standard/deep preselect Opus)
  // until the user explicitly taps a model button, which wins from then on.
  const modelBtns = new Map<LessonModel, HTMLButtonElement>();
  const modelRow = h("div", { class: "seg-row" });
  for (const m of ["opus", "sonnet"] as LessonModel[]) {
    const b = h(
      "button",
      {
        class: `seg ${m === model ? "on" : ""}`,
        onclick: () => {
          modelTouched = true;
          model = m;
          modelRow.querySelectorAll(".seg").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
        },
      },
      m
    ) as HTMLButtonElement;
    modelBtns.set(m, b);
    modelRow.append(b);
  }

  const sizeRow = h("div", { class: "seg-row" });
  for (const s of ["tight", "standard", "deep"] as SessionSize[]) {
    const b = h(
      "button",
      {
        class: `seg ${s === size ? "on" : ""}`,
        onclick: () => {
          size = s;
          sizeRow.querySelectorAll(".seg").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          if (!modelTouched) {
            model = size === "tight" ? "sonnet" : "opus";
            modelRow.querySelectorAll(".seg").forEach((x) => x.classList.remove("on"));
            modelBtns.get(model)!.classList.add("on");
          }
        },
      },
      s
    );
    sizeRow.append(b);
  }
  screen.append(
    h(
      "section",
      { class: "card controls" },
      h("div", { class: "control" }, h("label", {}, "Session size"), sizeRow),
      h("div", { class: "control" }, h("label", {}, "Model"), modelRow)
    )
  );

  // Start buttons
  const startBtn = h("button", { class: "primary" }, "Start lesson") as HTMLButtonElement;
  const discussBtn = h("button", { class: "secondary" }, "Discuss it instead") as HTMLButtonElement;
  const refreshStart = () => {
    const topic = selectedTopic ? status.topics.find((t) => t.id === selectedTopic) : undefined;
    startBtn.textContent = topic ? `Start: ${topic.name}` : "Start lesson";
  };
  const start = async (discuss: boolean) => {
    startBtn.disabled = discussBtn.disabled = true;
    startBtn.textContent = "Starting…";
    try {
      const res = await api.createLesson({
        laneId: selectedTopic ? undefined : selectedLane,
        topicOverride: selectedTopic,
        discuss,
        recallRequested: recallPicked.size ? [...recallPicked] : undefined,
        size,
        model,
      });
      showLesson(res.sessionId);
    } catch (e) {
      startBtn.disabled = discussBtn.disabled = false;
      refreshStart();
      alert(`Couldn't start: ${(e as Error).message}`);
    }
  };
  startBtn.addEventListener("click", () => start(false));
  discussBtn.addEventListener("click", () => start(true));
  screen.append(h("div", { class: "start-row" }, startBtn, discussBtn));

  refreshSelection();
  root.append(screen);
}

// ---------------------------------------------------------------------------
// Lesson screen
// ---------------------------------------------------------------------------

async function showLesson(id: string): Promise<void> {
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
  const endBtn = h(
    "button",
    {
      class: "hdr-chip end",
      onclick: async () => {
        if (lesson.commit) return;
        endBtn.setAttribute("disabled", "");
        addBubble("user", "Let's stop here — recap and wrap up.");
        thinking.classList.remove("hidden");
        renderedCount++; // server persists the wrap-up request to the transcript
        try {
          const res = await api.endLesson(id);
          lesson.ending = true;
          if (res.alreadyCommitted) addNote("Already committed.");
        } catch (e) {
          thinking.classList.add("hidden");
          showBanner(`Couldn't end: ${(e as Error).message}`);
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
        cleanup();
        void showSelect();
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
          onclick: () => {
            cleanup();
            void showSelect();
          },
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
  const input = h("textarea", {
    class: "composer-input",
    placeholder: "Message…",
    rows: "1",
  }) as HTMLTextAreaElement;
  const sendBtn = h("button", { class: "composer-send" }, "↑") as HTMLButtonElement;
  // Photo attachments: picked → downscaled client-side → chip preview → sent
  // as base64 with the next message. `capture` hint keeps phone cameras easy.
  const fileInput = h("input", {
    type: "file",
    accept: "image/*",
    capture: "environment",
    multiple: "",
    class: "hidden",
  }) as HTMLInputElement;
  const attachBtn = h(
    "button",
    { class: "composer-attach", onclick: () => fileInput.click() },
    "+"
  ) as HTMLButtonElement;
  const chipRow = h("div", { class: "attach-chips hidden" });
  const pendingImages: { out: OutgoingImage; preview: string }[] = [];
  const MAX_ATTACH = 4;

  const refreshChips = () => {
    clear(chipRow);
    chipRow.classList.toggle("hidden", pendingImages.length === 0);
    pendingImages.forEach((p, i) => {
      chipRow.append(
        h(
          "span",
          { class: "attach-chip" },
          h("img", { src: p.preview, alt: "attachment" }),
          h(
            "button",
            {
              class: "attach-x",
              onclick: () => {
                pendingImages.splice(i, 1);
                refreshChips();
              },
            },
            "×"
          )
        )
      );
    });
  };

  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    for (const f of files) {
      if (pendingImages.length >= MAX_ATTACH) break;
      try {
        pendingImages.push(await downscaleImage(f));
      } catch {
        showBanner(`Couldn't read ${f.name} as an image.`);
      }
    }
    refreshChips();
  });

  const composer = h("div", { class: "composer" }, attachBtn, fileInput, input, sendBtn);
  screen.append(chipRow, composer);
  root.append(screen);

  // --- message rendering ----------------------------------------------------

  const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160;
  const scrollDown = (force = false) => {
    if (force || nearBottom()) messages.scrollTop = messages.scrollHeight;
  };

  function addBubble(
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
    messages.append(b);
    if (role === "assistant" && mid) registerAssistantBubble(b, mid);
    scrollDown(true);
    return b;
  }

  // --- per-message feedback ---------------------------------------------------
  // Rate a tutor message via long-press (touch) / right-click (mouse): ±1/±2
  // with a required note. Only a ⏬ (-2) reaches the tutor live; the rest are
  // siloed until wrap-up. No rating = no signal, so nothing here is proactive.

  const feedbackById = new Map<string, MessageFeedback>();
  for (const f of lesson.feedback ?? []) feedbackById.set(f.messageId, f);
  const bubbleByMid = new Map<string, HTMLElement>();
  const LEVEL_EMOJI: Record<RatingLevel, string> = { 2: "⏫", 1: "👍", "-1": "👎", "-2": "⏬" };

  function registerAssistantBubble(b: HTMLElement, mid: string): void {
    b.dataset.mid = mid;
    bubbleByMid.set(mid, b);
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openRating(b, mid);
    });
    attachLongPress(b, () => openRating(b, mid));
    decorateFeedback(mid);
  }

  /** Badge on the rated message + (for fired ⏬ flags) the note under it. */
  function decorateFeedback(mid: string): void {
    const bubble = bubbleByMid.get(mid);
    if (!bubble) return;
    const f = feedbackById.get(mid);
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
    const flagEl = messages.querySelector(`[data-flag-for="${mid}"]`);
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

  // One popover at a time, anchored directly under its message.
  let popEl: HTMLElement | null = null;
  let popFor: string | null = null;
  const onDocDown = (e: Event) => {
    if (popEl && !popEl.contains(e.target as Node)) closeRating();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeRating();
  };
  function closeRating(): void {
    popEl?.remove();
    popEl = null;
    popFor = null;
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
  }

  function openRating(bubble: HTMLElement, mid: string): void {
    if (lesson.commit || lesson.status !== "active") return; // feedback closed
    if (popFor === mid) return; // long-press + contextmenu double-fire
    closeRating();
    const existing = feedbackById.get(mid);
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
                await api.clearFeedback(id, mid);
                feedbackById.delete(mid);
                decorateFeedback(mid);
                closeRating();
              } catch (e) {
                showBanner(`Couldn't remove rating: ${(e as Error).message}`);
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
        const res = await api.setFeedback(id, { messageId: mid, level, note: n });
        const prev = feedbackById.get(mid);
        feedbackById.set(mid, {
          messageId: mid,
          level,
          note: n,
          at: new Date().toISOString(),
          flagged: prev?.flagged || res.flagged,
        });
        decorateFeedback(mid);
        closeRating();
      } catch (e) {
        saveBtn.disabled = false;
        showBanner(`Couldn't save rating: ${(e as Error).message}`);
      }
    });

    popEl = h(
      "div",
      { class: "fb-pop" },
      thumbRow,
      note,
      h("div", { class: "fb-hint" }, "⏬ reaches the tutor right away; other ratings wait for the wrap-up. Unrated messages mean nothing."),
      actions
    );
    popFor = mid;
    bubble.after(popEl);
    refresh();
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onDocKey, true);
    popEl.scrollIntoView({ block: "nearest" });
    note.focus();
  }

  /** Server-stored inbound photo names → asset-route URLs. */
  const photoUrls = (t: TranscriptEntry): string[] =>
    (t.images ?? []).map((name) => `/api/assets/local/${encodeURIComponent(name)}`);

  function addNote(text: string): void {
    messages.append(h("div", { class: "note" }, text));
    scrollDown();
  }

  // A single reused note for commit progress, so the step updates in place
  // (e.g. "Committing… git commit (4/4)") rather than stacking a note per step.
  let commitNote: HTMLElement | null = null;
  function setCommitProgress(text: string): void {
    if (!commitNote) {
      commitNote = h("div", { class: "note" }, text);
      messages.append(commitNote);
    } else {
      commitNote.textContent = text;
    }
    scrollDown();
  }

  // Count of transcript entries already on screen. SSE and reconcile both keep
  // this in sync so a refetch appends only what was missed, never a duplicate.
  let renderedCount = 0;
  for (const t of lesson.transcript) {
    addBubble(t.role, t.text, photoUrls(t), t.id);
    renderedCount++;
  }
  if (lesson.status === "abandoned") addNote("This lesson was abandoned.");
  if (lesson.commit) showWrapup(lesson.commit);
  if (lesson.lastError && !lesson.commit) showBanner(mapError(lesson.lastError));
  refreshEndingHint();

  // --- streaming state --------------------------------------------------------

  let streamEl: HTMLElement | null = null;
  let streamBuf = "";
  let renderQueued = false;

  const renderStream = () => {
    if (renderQueued || !streamEl) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (streamEl) {
        // finalize: false — mermaid fences stay as placeholder boxes while
        // streaming; they render to SVG when the final assistant text lands.
        renderInto(streamEl, streamBuf, { finalize: false });
        scrollDown();
      }
    });
  };

  function showBanner(text: string, action?: { label: string; run: () => void }): void {
    clear(banner);
    banner.classList.remove("hidden");
    banner.append(h("span", {}, text));
    if (action) {
      banner.append(h("button", { class: "banner-btn", onclick: action.run }, action.label));
    }
    banner.append(h("button", { class: "banner-x", onclick: () => banner.classList.add("hidden") }, "×"));
  }

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

    // Dollars are a computed equivalent at API rates — Pro isn't metered.
    box.append(
      h(
        "div",
        { class: "usage-cost" },
        h("strong", {}, `≈ $${u.costUsd.toFixed(2)}`),
        h("span", { class: "usage-note" }, " equivalent at API rates — your Pro plan isn't billed per token")
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

  function showWrapup(commit: CommitResult): void {
    // The commit finished — drop the live "Committing…" note; the panel says it now.
    commitNote?.remove();
    commitNote = null;
    clear(wrapup);
    wrapup.classList.remove("hidden");
    wrapup.append(h("h2", {}, `Lesson ${commit.lessonNumber} committed`));
    const ul = h("ul", { class: "wrapup-summary" });
    for (const s of commit.summary) ul.append(h("li", {}, s));
    wrapup.append(ul);
    if (commit.usage) wrapup.append(renderUsage(commit.usage));
    wrapup.append(h("div", { class: "wrapup-git" }, commit.gitMessage));

    if (commit.proposedConfirmedPatterns.length > 0 && !commit.patternsResolved) {
      wrapup.append(h("h3", {}, "Proposed confirmed patterns — your call"));
      const checks: { box: HTMLInputElement; text: string }[] = [];
      for (const p of commit.proposedConfirmedPatterns) {
        const box = h("input", { type: "checkbox" }) as HTMLInputElement;
        box.checked = true;
        checks.push({ box, text: p });
        wrapup.append(h("label", { class: "pattern-row" }, box, h("span", {}, p)));
      }
      const applyBtn = h(
        "button",
        {
          class: "primary small",
          onclick: async () => {
            const approve = checks.filter((c) => c.box.checked).map((c) => c.text);
            try {
              const res = await api.approvePatterns(id, approve);
              commit.patternsResolved = true;
              showWrapup(commit);
              addNote(
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
      wrapup.append(h("div", { class: "pattern-actions" }, applyBtn));
    } else if (commit.patternsResolved) {
      wrapup.append(h("div", { class: "wrapup-resolved" }, "Confirmed-pattern proposals resolved."));
    }
    wrapup.append(
      h("button", { class: "secondary small", onclick: () => { cleanup(); void showSelect(); } }, "Back to start")
    );
    scrollDown(true);
  }

  function mapError(raw: string): string {
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
  function refreshEndingHint(): void {
    if (lesson.ending && !lesson.commit && lesson.status !== "abandoned") {
      clear(endingHint);
      endingHint.classList.remove("hidden");
      endingHint.append(
        h("span", {}, "This lesson ended but hasn't been committed yet — nothing is saved until it is."),
        h(
          "button",
          {
            class: "ending-btn",
            onclick: async () => {
              try {
                await api.endLesson(id);
                thinking.classList.remove("hidden");
              } catch (e) {
                showBanner((e as Error).message);
              }
            },
          },
          "Ask the tutor to commit"
        )
      );
    } else {
      endingHint.classList.add("hidden");
    }
  }

  // SSE has no replay. After a reconnect (or when the PWA returns to foreground),
  // refetch the authoritative state and append anything the stream missed.
  let reconciling = false;
  async function reconcile(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const fresh = await api.lesson(id);
      lesson.status = fresh.status;
      lesson.ending = fresh.ending;
      // Drop a dangling partial stream bubble — its finalized text is in the transcript.
      if (streamEl) {
        streamEl.remove();
        streamEl = null;
        streamBuf = "";
      }
      for (let i = renderedCount; i < fresh.transcript.length; i++) {
        const t = fresh.transcript[i];
        addBubble(t.role, t.text, photoUrls(t), t.id);
      }
      renderedCount = Math.max(renderedCount, fresh.transcript.length);
      // Re-sync ratings (badges + flag notes) — covers changes from other devices.
      const staleIds = new Set(feedbackById.keys());
      feedbackById.clear();
      for (const f of fresh.feedback ?? []) feedbackById.set(f.messageId, f);
      for (const mid of new Set([...staleIds, ...feedbackById.keys()])) decorateFeedback(mid);
      lesson.feedback = fresh.feedback;
      if (fresh.commit && !lesson.commit) {
        lesson.commit = fresh.commit;
        lesson.status = "committed";
        thinking.classList.add("hidden");
        showWrapup(fresh.commit);
      }
      if (fresh.lastError && !fresh.commit) showBanner(mapError(fresh.lastError));
      refreshEndingHint();
    } catch {
      /* offline or gone — leave the screen as-is */
    } finally {
      reconciling = false;
    }
  }

  // --- events -----------------------------------------------------------------

  const closeEvents = api.events(
    id,
    (ev) => {
    switch (ev.type) {
      case "user":
        // Echo of our own send is already rendered locally; ignore duplicates
        break;
      case "delta":
        if (!streamEl) {
          streamBuf = "";
          streamEl = addBubble("assistant", "");
          streamEl.classList.add("streaming");
          thinking.classList.add("hidden");
        }
        streamBuf += ev.text;
        renderStream();
        break;
      case "assistant":
        if (streamEl) {
          renderInto(streamEl, ev.text);
          streamEl.classList.remove("streaming");
          // The finalized message now has its id — make it rateable.
          if (ev.id) registerAssistantBubble(streamEl, ev.id);
          streamEl = null;
          streamBuf = "";
        } else {
          addBubble("assistant", ev.text, [], ev.id);
        }
        renderedCount++; // the server persists this assistant turn to the transcript
        scrollDown();
        break;
      case "tool_use":
        if (ev.name.includes("commit_session")) setCommitProgress("Committing session…");
        break;
      case "feedback_flag": {
        // A ⏬ fired (this device or another) — show the note under the message.
        const prev = feedbackById.get(ev.messageId);
        feedbackById.set(ev.messageId, {
          messageId: ev.messageId,
          level: -2,
          note: ev.note,
          at: new Date().toISOString(),
          flagged: true,
        });
        if (!prev || prev.note !== ev.note || !prev.flagged) decorateFeedback(ev.messageId);
        break;
      }
      case "committed":
        lesson.commit = ev.commit;
        lesson.status = "committed";
        endingHint.classList.add("hidden");
        closeRating(); // ratings close at commit
        showWrapup(ev.commit);
        break;
      case "turn_done":
        thinking.classList.add("hidden");
        streamEl?.classList.remove("streaming");
        streamEl = null;
        if (ev.isError && ev.errors?.length) showBanner(`Something went wrong: ${ev.errors[0]}`);
        refreshEndingHint();
        break;
      case "rate_limit":
        if (ev.status === "rejected" || ev.status === "allowed_warning") {
          const when = ev.resetsAt ? new Date(ev.resetsAt * 1000).toLocaleTimeString() : "later";
          showBanner(
            `Your Claude usage window is ${ev.status === "rejected" ? "exhausted" : "nearly exhausted"} (resets ${when}). It's shared with your other Claude use.`,
            lesson.params.model === "opus"
              ? {
                  label: "Switch to Sonnet",
                  run: async () => {
                    await api.setModel(id, "sonnet");
                    lesson.params.model = "sonnet";
                    modelBtn.textContent = "sonnet";
                    banner.classList.add("hidden");
                  },
                }
              : undefined
          );
        }
        break;
      case "api_error":
        showBanner(mapError(ev.error));
        break;
      case "error":
        thinking.classList.add("hidden");
        showBanner(mapError(ev.message));
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

  function cleanup(): void {
    closeEvents();
    closeRating();
    document.removeEventListener("visibilitychange", onVisible);
  }

  // --- composer ----------------------------------------------------------------

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    const images = pendingImages.splice(0, pendingImages.length);
    refreshChips();
    if (!trimmed && images.length === 0) return;
    addBubble("user", trimmed, images.map((p) => p.preview));
    renderedCount++; // the server persists this user turn to the transcript
    lesson.ending = false; // chatting on means we're no longer just wrapping up
    endingHint.classList.add("hidden");
    thinking.classList.remove("hidden");
    scrollDown(true);
    try {
      await api.sendMessage(id, trimmed, images.map((p) => p.out));
    } catch (e) {
      thinking.classList.add("hidden");
      // The attachments weren't delivered — put them back in the composer.
      pendingImages.push(...images);
      refreshChips();
      showBanner(`Couldn't send: ${(e as Error).message}`);
    }
  }

  const submit = () => {
    const v = input.value;
    input.value = "";
    input.style.height = "auto";
    void send(v);
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  scrollDown(true);
}

function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

/**
 * Downscale a picked photo to ≤1568 px on the long edge and re-encode as
 * JPEG (~0.8) — token and upload cost control; full-resolution camera shots
 * are wasted on the model anyway.
 */
async function downscaleImage(file: File): Promise<{ out: OutgoingImage; preview: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const hpx = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hpx;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, hpx);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return {
    out: { media_type: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) },
    preview: dataUrl,
  };
}

// ---------------------------------------------------------------------------
// Update toast — sw.js serves the shell cache-first, so an installed PWA can
// silently run one build behind. Compare the server's current build id
// (GET /api/version) against the one baked into this bundle (__BUILD_ID__);
// on a mismatch, offer a one-tap cache-clear + reload.
// ---------------------------------------------------------------------------

let updateToastShown = false;

async function checkForUpdate(): Promise<void> {
  if (updateToastShown) return;
  let info;
  try {
    info = await api.version();
  } catch {
    return; // offline or server not up yet — try again next select-screen load
  }
  if (info.buildId && info.buildId !== __BUILD_ID__) {
    updateToastShown = true;
    showUpdateToast();
  }
}

function showUpdateToast(): void {
  const toast = h(
    "button",
    {
      class: "update-toast",
      onclick: () => {
        toast.disabled = true;
        toast.textContent = "Updating…";
        void (async () => {
          try {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          } finally {
            location.reload();
          }
        })();
      },
    },
    "New version — tap to update"
  );
  document.body.append(toast);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if ("serviceWorker" in navigator && !location.hostname.includes("localhost")) {
  void navigator.serviceWorker.register("/sw.js");
}

void showSelect();
