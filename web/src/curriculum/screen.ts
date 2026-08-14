// The Curriculum screen: one lane's units as a dependency graph, each block
// expandable into its topics and lessons.
//
// Like every other screen in this app there's no router — showCurriculum clears
// #app and draws. The `initial` argument is how the transcript reader gets you
// back to the unit you opened it from.
import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { CurriculumView } from "../api.js";
import { renderFlowchart, type FlowchartHandle } from "./flowchart.js";
import { showTranscript } from "./transcript.js";

export interface CurriculumEntry {
  laneId?: string;
  expandUnitId?: string;
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

  const screen = h("div", { class: "screen curriculum" });
  const laneRow = h("div", { class: "seg-row lane-tabs" });
  const direction = h("p", { class: "lane-direction" });
  const graphHost = h("div", { class: "flow-host" });
  let handle: FlowchartHandle | null = null;

  const laneButtons = new Map<string, HTMLElement>();

  // Re-entering the curriculum after reading a transcript restores the lane and
  // reopens the unit, so the reader feels like a step down and back rather than
  // a jump to somewhere new.
  const openTranscript = (lessonNumber: number, unitId: string) => {
    handle?.destroy();
    void showTranscript(root, lessonNumber, () =>
      void showCurriculum(root, onBack, { laneId, expandUnitId: unitId })
    );
  };

  const drawLane = (expandUnitId?: string) => {
    const lane = view.lanes.find((l) => l.id === laneId)!;
    direction.textContent = lane.direction;
    direction.classList.toggle("hidden", !lane.direction);
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
        class: "seg",
        onclick: () => {
          if (laneId === lane.id) return;
          laneId = lane.id;
          drawLane();
          graphHost.scrollIntoView({ block: "start" });
        },
      },
      lane.name.replace(/\s+Lane$/, "")
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
    laneRow,
    direction,
    graphHost
  );
  root.append(screen);
  drawLane(initial.expandUnitId);
}
