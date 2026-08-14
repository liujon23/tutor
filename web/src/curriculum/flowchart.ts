// The lane flowchart: unit blocks in dependency rows, with the prerequisite
// graph drawn behind them.
//
// Layout is CSS grid (one row per layer, from core/layout.ts). The arrows are
// an SVG overlay measured from the real laid-out boxes rather than computed
// positions — blocks change height when an accordion opens, and measuring
// afterwards is the only way the arrows stay attached to them.
//
// On a narrow screen the graph collapses to a single column and the arrows are
// replaced by "after: …" text on each block: a DAG drawn at phone width is
// unreadable, and pan/zoom is worse than not drawing it.
import { h, clear } from "../dom.js";
import type { CurriculumLane, CurriculumUnit } from "../api.js";
import { unitBody } from "./unit-detail.js";

/** Below this width the graph becomes a list. */
const NARROW = 640;

const STATE_LABEL: Record<string, string> = {
  complete: "complete",
  "core-complete": "core complete",
  "in-progress": "in progress",
  "not-started": "not started",
};

/** The one date a block shows, and what it means. */
function dateLine(u: CurriculumUnit): string | null {
  if (u.completedAt) return `completed ${u.completedAt}`;
  if (u.lastLessonDate) return `last worked on ${u.lastLessonDate}`;
  return null;
}

function isDone(u: CurriculumUnit): boolean {
  return u.state === "complete" || u.state === "core-complete";
}

export interface FlowchartHandle {
  el: HTMLElement;
  /** Open a unit's accordion and scroll it into view. */
  expand(unitId: string): void;
  destroy(): void;
}

export function renderFlowchart(
  lane: CurriculumLane,
  onOpenTranscript: (lessonNumber: number, unitId: string) => void
): FlowchartHandle {
  const byId = new Map(lane.units.map((u) => [u.id, u]));
  const blocks = new Map<string, HTMLElement>();
  const bodies = new Map<string, HTMLElement>();
  const expanded = new Set<string>();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "flow-edges");
  svg.setAttribute("aria-hidden", "true");

  const rows = h("div", { class: "flow-rows" });
  const wrap = h("div", { class: "flow" }, svg, rows);

  const toggle = (unitId: string) => {
    const body = bodies.get(unitId);
    const block = blocks.get(unitId);
    if (!body || !block) return;
    const open = expanded.has(unitId);
    if (open) expanded.delete(unitId);
    else expanded.add(unitId);
    body.classList.toggle("hidden", open);
    block.classList.toggle("open", !open);
    block.setAttribute("aria-expanded", String(!open));
    drawEdges();
  };

  for (const row of lane.layers) {
    const rowEl = h("div", { class: "flow-row" });
    for (const unitId of row) {
      const u = byId.get(unitId);
      if (!u) continue;

      const pct =
        u.progress.coreTotal > 0
          ? Math.round((u.progress.coreComfortable / u.progress.coreTotal) * 100)
          : 0;
      const date = dateLine(u);

      // Prerequisite names, shown as text only in the narrow layout where the
      // arrows are gone.
      const afterNames = u.prerequisites
        .map((p) => byId.get(p)?.name)
        .filter((n): n is string => !!n);

      const body = h("div", { class: "unit-body hidden" }, unitBody(u, onOpenTranscript));
      bodies.set(unitId, body);

      const block = h(
        "div",
        {
          class:
            `unit-block state-${u.state}` +
            (lane.currentUnitId === unitId ? " current" : "") +
            (isDone(u) ? " done" : ""),
          "data-unit": unitId,
        },
        h(
          "button",
          {
            class: "unit-head",
            "aria-expanded": "false",
            onclick: () => toggle(unitId),
          },
          afterNames.length
            ? h("div", { class: "unit-after" }, `after: ${afterNames.join(", ")}`)
            : null,
          h(
            "div",
            { class: "unit-title-row" },
            h("span", { class: "unit-name" }, u.name),
            lane.currentUnitId === unitId ? h("span", { class: "unit-current" }, "current") : null
          ),
          h(
            "div",
            { class: "unit-meta" },
            h("span", { class: "unit-state" }, (isDone(u) ? "✓ " : "") + (STATE_LABEL[u.state] ?? u.state)),
            date ? h("span", { class: "unit-date" }, date) : null
          ),
          u.progress.coreTotal > 0
            ? h(
                "div",
                { class: "unit-progress" },
                h("div", { class: "progress-track" }, h("span", { class: "progress-fill", style: `width:${pct}%` })),
                h(
                  "div",
                  { class: "unit-progress-label" },
                  `${u.progress.coreComfortable}/${u.progress.coreTotal} core comfortable` +
                    (isDone(u) && u.optionalRemaining > 0 ? ` · +${u.optionalRemaining} optional left` : "")
                )
              )
            : null
        ),
        body
      );
      blocks.set(unitId, block);
      rowEl.append(block);
    }
    rows.append(rowEl);
  }

  // --- Edges ---------------------------------------------------------------

  const isNarrow = () => window.innerWidth <= NARROW;

  /**
   * Draw one connector per edge, measured from the current DOM. Prerequisites
   * are solid; bridgeTopics are dashed and may point either direction — a
   * bridge can reference a topic in a LATER unit (sts-scot-ant → sts-education),
   * so no assumption is made about which way they run.
   */
  const drawEdges = () => {
    clear(svg as unknown as HTMLElement);
    if (isNarrow()) {
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      return;
    }
    const base = wrap.getBoundingClientRect();
    svg.setAttribute("width", String(base.width));
    svg.setAttribute("height", String(base.height));
    svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);

    const centerBottom = (r: DOMRect) => ({ x: r.left - base.left + r.width / 2, y: r.bottom - base.top });
    const centerTop = (r: DOMRect) => ({ x: r.left - base.left + r.width / 2, y: r.top - base.top });

    const line = (
      from: { x: number; y: number },
      to: { x: number; y: number },
      dashed: boolean
    ) => {
      // A vertical-tangent cubic: leaves the bottom of one block and arrives at
      // the top of the next, so crossing edges stay readable.
      const dy = Math.max(18, Math.abs(to.y - from.y) / 2);
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute(
        "d",
        `M ${from.x} ${from.y} C ${from.x} ${from.y + dy}, ${to.x} ${to.y - dy}, ${to.x} ${to.y}`
      );
      p.setAttribute("class", dashed ? "flow-edge bridge" : "flow-edge");
      svg.append(p);
    };

    for (const u of lane.units) {
      const target = blocks.get(u.id);
      if (!target) continue;
      const tr = target.getBoundingClientRect();

      for (const dep of u.prerequisites) {
        const src = blocks.get(dep);
        if (!src) continue;
        line(centerBottom(src.getBoundingClientRect()), centerTop(tr), false);
      }
      // Dashed: this unit leans on a topic living in another unit of the lane.
      for (const b of u.bridgesInLane) {
        const src = blocks.get(b.unitId);
        if (!src || b.unitId === u.id) continue;
        const sr = src.getBoundingClientRect();
        const downward = sr.top < tr.top;
        line(
          downward ? centerBottom(sr) : centerTop(sr),
          downward ? centerTop(tr) : centerBottom(tr),
          true
        );
      }
    }
  };

  // Re-measure whenever anything can move: window resize, accordion toggles
  // (which change block heights), and font/image loads inside an open body.
  const ro = new ResizeObserver(() => drawEdges());
  ro.observe(rows);
  const onResize = () => {
    wrap.classList.toggle("narrow", isNarrow());
    drawEdges();
  };
  window.addEventListener("resize", onResize);
  wrap.classList.toggle("narrow", isNarrow());
  // First paint: wait for layout so getBoundingClientRect returns real boxes.
  requestAnimationFrame(() => drawEdges());

  return {
    el: wrap,
    expand(unitId: string) {
      if (!blocks.has(unitId) || expanded.has(unitId)) return;
      toggle(unitId);
      blocks.get(unitId)?.scrollIntoView({ block: "center" });
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    },
  };
}
