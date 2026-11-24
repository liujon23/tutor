// The Curriculum screen, two ways round. By unit: one lane's units as a
// dependency graph, each block expandable into its topics and lessons. By
// date: every past lesson, newest first, with search (lesson-list.ts).
//
// Like every other screen in this app there's no router — showCurriculum clears
// #app and draws. The `initial` argument is how the transcript reader gets you
// back to where you opened it from: the unit, or the list with its filter,
// query and scroll position.
import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { CurriculumView } from "../api.js";
import { renderFlowchart, type FlowchartHandle } from "./flowchart.js";
import { renderLessonList, type DateViewState } from "./lesson-list.js";
import { showTranscript } from "./transcript.js";

export interface CurriculumEntry {
  mode?: "unit" | "date";
  laneId?: string;
  expandUnitId?: string;
  date?: DateViewState;
  scrollTop?: number;
}

export async function showCurriculum(
  root: HTMLElement,
  onBack: () => void,
  initial: CurriculumEntry = {}
): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading…"));

  let view: CurriculumView;
  try {
    view = await api.curriculum();
  } catch (e) {
    clear(root);
    root.append(h("div", { class: "error-box" }, `Couldn't reach the server: ${(e as Error).message}`));
    return;
  }
  clear(root);

  if (view.lanes.length === 0) {
    root.append(
      h(
        "div",
        { class: "screen curriculum" },
        h(
          "header",
          { class: "app-header" },
          h("button", { class: "back", onclick: () => onBack() }, "‹"),
          h("h1", {}, "Curriculum")
        ),
        h("section", { class: "card" }, "No tracks are set up yet.")
      )
    );
    return;
  }

  // Default to the heaviest lane — the one the learner spends most time in.
  const byWeight = [...view.lanes].sort((a, b) => b.weight - a.weight);
  let laneId =
    (initial.laneId && view.lanes.some((l) => l.id === initial.laneId) ? initial.laneId : null) ??
    byWeight[0].id;

  let mode: "unit" | "date" = initial.mode ?? "unit";
  const dateState: DateViewState = initial.date ?? { laneId: null, query: "" };

  const screen = h("div", { class: "screen curriculum" });
  const unitView = h("div", { class: "unit-view" });
  const dateHost = h("div", { class: "date-host" });
  // Chips, not a segmented control: lane names are long and variable, and four
  // of them have to wrap on a phone. `.seg-row` is `overflow: hidden` and never
  // wraps, which silently hid the whole switcher at narrow widths.
  const laneRow = h("div", { class: "chip-row lane-tabs" });
  const direction = h("p", { class: "lane-direction" });
  // Shown only on a finished course: the date, and how to reopen it.
  const finished = h("p", { class: "lane-finished hidden" });
  const graphHost = h("div", { class: "flow-host" });
  let handle: FlowchartHandle | null = null;

  const laneButtons = new Map<string, HTMLElement>();

  // Re-entering the curriculum after reading a transcript restores the lane and
  // reopens the unit, so the reader feels like a step down and back rather than
  // a jump to somewhere new.
  const openTranscript = (lessonNumber: number, unitId: string) => {
    handle?.destroy();
    void showTranscript(root, lessonNumber, () =>
      void showCurriculum(root, onBack, { mode: "unit", laneId, expandUnitId: unitId })
    );
  };

  // From the date view, back restores the filter, the query and the scroll.
  const openFromList = (lessonNumber: number, turn?: number, terms?: string[]) => {
    handle?.destroy();
    const back: CurriculumEntry = { mode: "date", laneId, date: { ...dateState }, scrollTop: screen.scrollTop };
    void showTranscript(root, lessonNumber, () => void showCurriculum(root, onBack, back), { turn, terms });
  };

  const modeButtons = new Map<string, HTMLElement>();
  const modeRow = h("div", { class: "seg-row curriculum-mode" });
  const drawMode = () => {
    for (const [m, btn] of modeButtons) btn.classList.toggle("on", m === mode);
    unitView.classList.toggle("hidden", mode !== "unit");
    dateHost.classList.toggle("hidden", mode !== "date");
    if (mode === "date" && !dateHost.firstChild) dateHost.append(renderLessonList(view, dateState, openFromList));
  };
  for (const [m, label] of [
    ["unit", "By unit"],
    ["date", "By date"],
  ] as const) {
    const btn = h(
      "button",
      {
        class: "seg",
        type: "button",
        onclick: () => {
          if (mode === m) return;
          mode = m;
          drawMode();
          screen.scrollTop = 0;
        },
      },
      label
    );
    modeButtons.set(m, btn);
    modeRow.append(btn);
  }

  const drawLane = (expandUnitId?: string) => {
    const lane = view.lanes.find((l) => l.id === laneId)!;
    direction.textContent = lane.direction;
    direction.classList.toggle("hidden", !lane.direction);
    finished.textContent = lane.finishedAt
      ? `✓ Finished ${lane.finishedAt}. Its topics stay in recall, at half the frequency. Extend it in course-setup to reopen it.`
      : "";
    finished.classList.toggle("hidden", !lane.finishedAt);
    handle?.destroy();
    clear(graphHost);
    if (lane.units.length === 0) {
      graphHost.append(h("section", { class: "card" }, "This track has no units yet."));
      handle = null;
      return;
    }
    handle = renderFlowchart(lane, openTranscript);
    graphHost.append(handle.el);
    if (expandUnitId) handle.expand(expandUnitId);
    for (const [id, btn] of laneButtons) btn.classList.toggle("on", id === laneId);
  };

  for (const lane of view.lanes) {
    const btn = h(
      "button",
      {
        class: "chip",
        onclick: () => {
          if (laneId === lane.id) return;
          laneId = lane.id;
          drawLane();
          // Back to the top of the screen, not the top of the graph: scrolling
          // to the graph would push the lane switcher off a phone screen right
          // after you'd used it.
          screen.scrollTop = 0;
        },
      },
      lane.name.replace(/\s+Lane$/, "") + (lane.finishedAt ? " ✓" : "")
    );
    laneButtons.set(lane.id, btn);
    laneRow.append(btn);
  }

  screen.append(
    h(
      "header",
      { class: "app-header" },
      h("button", { class: "back", onclick: () => onBack() }, "‹"),
      h("h1", {}, "Curriculum")
    ),
    modeRow,
    unitView,
    dateHost
  );
  unitView.append(laneRow, direction, finished, graphHost);
  root.append(screen);
  drawLane(initial.expandUnitId);
  drawMode();
  if (initial.scrollTop) screen.scrollTop = initial.scrollTop;
}
