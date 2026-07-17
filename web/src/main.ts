import "./style.css";
import { api } from "./api.js";
import type { LessonModel, SessionSize, Status, StatusLane } from "./api.js";
import { showStats } from "./stats.js";
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
