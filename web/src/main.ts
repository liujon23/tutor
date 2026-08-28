import "./style.css";
import { api } from "./api.js";
import type { LessonModel, SessionSize, Status, StatusLane } from "./api.js";
import { showStats } from "./stats.js";
import { showCurriculum } from "./curriculum/screen.js";
import { h, clear } from "./dom.js";
import { showLesson } from "./lesson/screen.js";

export const root = document.getElementById("app")!;

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

export async function showSelect(): Promise<void> {
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

  const screen = h("div", { class: "screen select" });

  screen.append(
    h(
      "header",
      { class: "app-header" },
      h("h1", {}, "Tutor"),
      h("span", { class: "date" }, status.today),
      // Unlike Stats, this works in a demo build too — it reads a static
      // curriculum snapshot rather than live usage history.
      h(
        "button",
        { class: "stats-link", onclick: () => void showCurriculum(root, () => void showSelect()) },
        "Curriculum"
      ),
      // Stats reports on real usage/cost history — nothing to show in a static replay.
      __DEMO__
        ? null
        : h("button", { class: "stats-link", onclick: () => void showStats(root, () => void showSelect()) }, "Stats")
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
          h(
            "span",
            { class: "resume-meta" },
            // A recall check has no size worth reporting, and reading as
            // "standard" would send the learner to a screen with no End button.
            `${s.params.mode === "recall" ? "quick recall" : s.params.size} · started ${s.createdAt.slice(0, 10)}`
          )
        )
      );
    }
    screen.append(resume);
  }

  // ---- Today's pick -------------------------------------------------------
  // One track, drawn at random from the lane weights rather than shown as a
  // menu. The draw is fresh each load, so refreshing re-rolls it while still
  // following the weight distribution over many visits. In demo mode the pick
  // is always the one lane that has a recording.
  const demoLocked = (lane: StatusLane): boolean =>
    __DEMO__ && lane.recommendation.kind === "demo-locked";
  const picked = __DEMO__
    ? (status.lanes.find((l) => !demoLocked(l)) ?? null)
    : pickLane(status.lanes);
  if (picked) selectedLane = picked.id;

  const laneCards = new Map<string, HTMLElement>();
  let pickCard: HTMLElement | undefined;

  const recLineFor = (rec: StatusLane["recommendation"]): string =>
    rec.kind === "demo-locked"
      ? (rec.note ?? "Not in this demo")
      : rec.topicName
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
  // Demo-locked lanes (no recording in the demo) render dimmed and inert.
  const laneCard = (lane: StatusLane): HTMLElement => {
    const locked = demoLocked(lane);
    const card = h(
      "button",
      {
        class: locked ? "card lane-card demo-locked" : "card lane-card",
        ...(locked
          ? { disabled: "true" }
          : {
              onclick: () => {
                selectedLane = lane.id;
                selectedTopic = undefined;
                refreshSelection();
              },
            }),
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
  // ---- Quick recall ------------------------------------------------------
  // A one-question spaced-recall check: no selection at all, the server draws
  // the most overdue topic(s). Its own row rather than a third button in the
  // start row — .start-row children are flex:1, and three of them is cramped on
  // a phone. The button stays put on a quiet day rather than vanishing; a daily
  // habit needs a fixed place to tap.
  const recallBtn = h("button", { class: "secondary" }, "Quick recall") as HTMLButtonElement;
  const dueCount = status.recallDueCount;
  const recallNote = h(
    "div",
    { class: "card-note" },
    dueCount === 0
      ? "Nothing due today"
      : `${dueCount} topic${dueCount === 1 ? "" : "s"} due for recall`
  );

  // One switch for every action button. The old code chained
  // `startBtn.disabled = discussBtn.disabled = true`, which silently leaves any
  // newly-added button live — a double-tap would then open two sessions.
  const actionButtons = [startBtn, discussBtn, recallBtn];
  const setBusy = (busy: boolean) => {
    for (const b of actionButtons) b.disabled = busy;
    if (!busy && dueCount === 0) recallBtn.disabled = true; // never re-enable an empty recall
  };

  const start = async (discuss: boolean) => {
    setBusy(true);
    startBtn.textContent = "Starting…";
    try {
      const res = await api.createLesson({
        laneId: selectedTopic ? undefined : selectedLane,
        topicOverride: selectedTopic,
        discuss,
        size,
        model,
      });
      showLesson(res.sessionId);
    } catch (e) {
      setBusy(false);
      refreshStart();
      alert(`Couldn't start: ${(e as Error).message}`);
    }
  };
  const startRecall = async () => {
    setBusy(true);
    recallBtn.textContent = "Starting…";
    try {
      // No lane, topic, or discuss flag — the server picks what's most overdue.
      const res = await api.createLesson({ mode: "recall", size, model });
      showLesson(res.sessionId);
    } catch (e) {
      setBusy(false);
      recallBtn.textContent = "Quick recall";
      alert(`Couldn't start: ${(e as Error).message}`);
    }
  };
  startBtn.addEventListener("click", () => start(false));
  discussBtn.addEventListener("click", () => start(true));
  recallBtn.addEventListener("click", () => void startRecall());
  if (dueCount === 0) recallBtn.disabled = true;

  // Demo mode: no "discuss it instead" — selection-in-chat needs a live model.
  // The element still exists (start() toggles its disabled state); it just
  // never enters the DOM.
  screen.append(h("div", { class: "start-row" }, startBtn, __DEMO__ ? null : discussBtn));
  screen.append(h("div", { class: "start-row" }, recallBtn), recallNote);

  refreshSelection();
  root.append(screen);
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

// Skip entirely in demo mode: no server to keep the shell cache fresh, and the
// hardcoded "/sw.js" path doesn't respect the Pages base ("/tutor/") anyway.
if (!__DEMO__ && "serviceWorker" in navigator && !location.hostname.includes("localhost")) {
  void navigator.serviceWorker.register("/sw.js");
}

void showSelect();
