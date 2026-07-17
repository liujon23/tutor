// The Stats screen: usage, curriculum progress, and feedback trends — the
// in-app view of what used to be CLI-only (`npm run usage-report`).
import { api } from "./api.js";
import type { Report } from "./api.js";

// ---------------------------------------------------------------------------
// Tiny DOM helper — deliberately duplicated from main.ts (not moved) to avoid
// churning that file. Keep in sync by hand if it ever changes there.
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

// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat("en-US");
const fmtInt = (n: number): string => nf.format(Math.round(n));
const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;
const avgInt = (n: number, d: number): string => (d ? fmtInt(n / d) : "—");
const avgUsd = (n: number, d: number): string => (d ? fmtUsd(n / d) : "—");

const RATING_LEVELS = ["2", "1", "-1", "-2"] as const;
const LEVEL_EMOJI: Record<(typeof RATING_LEVELS)[number], string> = {
  "2": "⏫",
  "1": "👍",
  "-1": "👎",
  "-2": "⏬",
};

function statTile(value: string, label: string): HTMLElement {
  return h("div", { class: "stat-tile" }, h("div", { class: "stat-num" }, value), h("div", { class: "stat-label" }, label));
}

export async function showStats(root: HTMLElement, onBack: () => void): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading…"));

  let report: Report;
  try {
    report = await api.report();
  } catch (e) {
    clear(root);
    root.append(h("div", { class: "error-box" }, `Couldn't reach the server: ${(e as Error).message}`));
    return;
  }
  clear(root);

  const screen = h("div", { class: "screen stats" });
  screen.append(
    h(
      "header",
      { class: "app-header" },
      h("button", { class: "back", onclick: () => onBack() }, "‹"),
      h("h1", {}, "Stats")
    )
  );

  const o = report.usage.overall;
  if (o.lessons === 0) {
    screen.append(
      h(
        "section",
        { class: "card" },
        "No lessons yet — usage, progress, and feedback stats will show up here after your first one."
      )
    );
    root.append(screen);
    return;
  }

  // ---- Totals --------------------------------------------------------------
  screen.append(
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Totals"),
      h(
        "div",
        { class: "stat-grid" },
        statTile(fmtInt(o.lessons), "lessons"),
        statTile(fmtInt(o.totalTokens), "tokens"),
        statTile(fmtUsd(o.costUsd), "API-equiv"),
        statTile(avgInt(o.totalTokens, o.lessons), "avg tok/lesson"),
        statTile(avgUsd(o.costUsd, o.lessons), "avg $/lesson"),
        statTile(avgInt(o.turns, o.lessons), "avg turns")
      )
    )
  );

  // ---- Per lesson ------------------------------------------------------------
  const table = h(
    "table",
    { class: "stats-table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "#"),
        h("th", {}, "date"),
        h("th", {}, "lane"),
        h("th", {}, "size"),
        h("th", {}, "tokens"),
        h("th", {}, "$")
      )
    ),
    h(
      "tbody",
      {},
      ...report.usage.timeline.map((r) =>
        h(
          "tr",
          {},
          h("td", {}, String(r.lessonNumber)),
          h("td", {}, r.date),
          h("td", {}, r.laneId),
          h("td", {}, r.size),
          h("td", {}, fmtInt(r.totalTokens)),
          h("td", {}, fmtUsd(r.costUsd))
        )
      )
    )
  );
  screen.append(
    h("section", { class: "card" }, h("h2", {}, "Per lesson"), h("div", { class: "table-scroll" }, table))
  );

  // ---- Packet size -----------------------------------------------------------
  if (report.packetTrend.length > 0) {
    const max = Math.max(...report.packetTrend.map((p) => p.packetTokens));
    const bars = h("div", { class: "bar-list" });
    for (const p of report.packetTrend) {
      const pct = max > 0 ? Math.round((p.packetTokens / max) * 100) : 0;
      bars.append(
        h(
          "div",
          { class: "bar-row" },
          h("span", { class: "bar-label" }, `#${p.lessonNumber}`),
          h("span", { class: "bar-track" }, h("span", { class: "bar-fill", style: `width:${pct}%` })),
          h("span", { class: "bar-value" }, fmtInt(p.packetTokens))
        )
      );
    }
    screen.append(
      h(
        "section",
        { class: "card" },
        h("h2", {}, "Packet size"),
        h("div", { class: "card-note" }, "First-turn cache tokens per lesson — a proxy for the packet's size."),
        bars
      )
    );
  }

  // ---- Lanes -------------------------------------------------------------
  const lanesCard = h("section", { class: "card" }, h("h2", {}, "Lanes"));
  for (const lane of report.progress) {
    const pct = lane.coreTopicsTotal > 0 ? Math.round((lane.coreTopicsComfortable / lane.coreTopicsTotal) * 100) : 0;
    lanesCard.append(
      h(
        "div",
        { class: "lane-stat-row" },
        h(
          "div",
          { class: "lane-stat-head" },
          h("strong", {}, lane.name),
          h("span", { class: "weight" }, `~${lane.weight}%`)
        ),
        h(
          "div",
          { class: "lane-stat-meta" },
          `${lane.lessonsTaken} lesson${lane.lessonsTaken === 1 ? "" : "s"} · ` +
            `${lane.unitsComplete}/${lane.unitsTotal} units`
        ),
        lane.currentUnitName ? h("div", { class: "lane-stat-meta" }, `Current: ${lane.currentUnitName}`) : null,
        h("div", { class: "progress-track" }, h("div", { class: "progress-fill", style: `width:${pct}%` })),
        h(
          "div",
          { class: "lane-stat-meta" },
          `${lane.coreTopicsComfortable}/${lane.coreTopicsTotal} core topics comfortable` +
            (lane.staleTopics > 0 ? ` · ${lane.staleTopics} stale` : "")
        )
      )
    );
  }
  screen.append(lanesCard);

  // ---- Feedback ------------------------------------------------------------
  if (report.feedbackTrend.entries.length > 0) {
    const fbCard = h("section", { class: "card" }, h("h2", {}, "Feedback"));
    for (const entry of report.feedbackTrend.entries) {
      const row = h("div", { class: "feedback-row" }, h("span", { class: "feedback-lesson" }, `#${entry.lessonNumber}`));
      for (const level of RATING_LEVELS) {
        const n = entry.counts[level];
        if (n > 0) row.append(h("span", { class: "fb-count-badge" }, `${LEVEL_EMOJI[level]} ${n}`));
      }
      fbCard.append(row);
    }
    const totalsRow = h("div", { class: "feedback-totals" }, "Overall: ");
    for (const level of RATING_LEVELS) {
      const n = report.feedbackTrend.totals[level];
      if (n > 0) totalsRow.append(h("span", { class: "fb-count-badge" }, `${LEVEL_EMOJI[level]} ${n}`));
    }
    fbCard.append(totalsRow);
    screen.append(fbCard);
  }

  root.append(screen);
}
