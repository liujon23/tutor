// The Curriculum screen's By date view: every past lesson, newest first, across
// lanes, with a lane filter and full-text search over the transcripts.
//
// The list itself is built from the curriculum view the screen already has
// (each unit carries its lessons), so it needs no endpoint of its own and works
// in the demo build. Search goes to /api/lessons/search and is hidden in the
// demo, which ships one transcript.
import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { CurriculumView, LessonSearchResult } from "../api.js";
import { readableDate } from "./transcript.js";

export interface DateViewState {
  /** null: all lanes. */
  laneId: string | null;
  query: string;
}

export interface DateRow {
  lessonNumber: number;
  date: string;
  laneId: string;
  laneName: string;
  unitName: string;
  topicsLabel: string;
  topicsFull: string;
  hasTranscript: boolean;
  /** The lesson's first key point, when it has one. */
  keyPoint?: string;
}

const shortLane = (name: string) => name.replace(/\s+Lane$/, "");

/** Every lesson in the view, once, newest first. */
export function lessonRows(view: CurriculumView): DateRow[] {
  const byNumber = new Map<number, DateRow>();
  for (const lane of view.lanes) {
    for (const unit of lane.units) {
      for (const l of unit.lessons) {
        if (byNumber.has(l.lessonNumber)) continue;
        byNumber.set(l.lessonNumber, {
          lessonNumber: l.lessonNumber,
          date: l.date,
          laneId: lane.id,
          laneName: shortLane(lane.name),
          unitName: unit.name,
          topicsLabel: l.topicsLabel,
          topicsFull: l.topicsFull,
          hasTranscript: l.hasTranscript,
          ...(l.keyPoint ? { keyPoint: l.keyPoint } : {}),
        });
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => b.lessonNumber - a.lessonNumber);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Snippet text with each term (matched at a word start, as the server does) in <mark>. */
function marked(text: string, terms: string[]): HTMLElement {
  const el = h("span", { class: "hit-text" });
  if (terms.length === 0) {
    el.textContent = text;
    return el;
  }
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "giu");
  let last = 0;
  for (const m of text.matchAll(re)) {
    el.append(text.slice(last, m.index), h("mark", {}, m[0]));
    last = m.index! + m[0].length;
  }
  el.append(text.slice(last));
  return el;
}

function rowHead(r: DateRow): HTMLElement[] {
  return [
    h("span", { class: "lesson-num" }, `L${r.lessonNumber}`),
    h("span", { class: "date-row-when" }, `${readableDate(r.date)} · ${r.laneName} · ${r.unitName}`),
  ];
}

function dateRow(r: DateRow, open: (n: number) => void): HTMLElement {
  const topics = h("span", { class: "date-row-topics", ...(r.topicsFull ? { title: r.topicsFull } : {}) }, r.topicsLabel || "—");
  if (!r.hasTranscript) {
    return h(
      "div",
      { class: "date-row inert", title: "This lesson predates the transcript archive" },
      h("div", { class: "date-row-head" }, ...rowHead(r), h("span", { class: "lesson-note" }, "no transcript")),
      topics
    );
  }
  return h(
    "button",
    { class: "date-row", type: "button", onclick: () => open(r.lessonNumber) },
    h("div", { class: "date-row-head" }, ...rowHead(r)),
    topics,
    r.keyPoint ? h("span", { class: "date-row-point", title: r.keyPoint }, r.keyPoint) : null
  );
}

export function renderLessonList(
  view: CurriculumView,
  state: DateViewState,
  open: (lessonNumber: number, turn?: number, terms?: string[]) => void
): HTMLElement {
  const rows = lessonRows(view);
  const rowFor = new Map(rows.map((r) => [r.lessonNumber, r]));
  const host = h("div", { class: "date-view" });
  const listHost = h("div", { class: "date-list" });

  const chips = h("div", { class: "chip-row" });
  const chipFor = new Map<string | null, HTMLElement>();
  const lanes: [string | null, string][] = [[null, "All"], ...view.lanes.map((l) => [l.id, shortLane(l.name)] as [string, string])];
  for (const [id, label] of lanes) {
    const btn = h(
      "button",
      {
        class: "chip",
        type: "button",
        onclick: () => {
          state.laneId = id;
          draw();
        },
      },
      label
    );
    chipFor.set(id, btn);
    chips.append(btn);
  }

  const input = h("input", {
    type: "search",
    class: "date-search",
    placeholder: "Search transcripts",
    "aria-label": "Search transcripts",
    enterkeyhint: "search",
  }) as HTMLInputElement;
  input.value = state.query;

  let results: LessonSearchResult | null = null;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const inLane = (n: number) => state.laneId === null || rowFor.get(n)?.laneId === state.laneId;

  const drawList = () => {
    clear(listHost);
    const shown = rows.filter((r) => inLane(r.lessonNumber));
    if (shown.length === 0) {
      listHost.append(h("div", { class: "detail-empty" }, "No lessons yet."));
      return;
    }
    listHost.append(
      h("div", { class: "detail-label" }, `${shown.length} lesson${shown.length === 1 ? "" : "s"}`),
      ...shown.map((r) => dateRow(r, (n) => open(n)))
    );
  };

  const drawResults = (res: LessonSearchResult) => {
    clear(listHost);
    const hits = res.hits.filter((hit) => inLane(hit.lessonNumber) && rowFor.has(hit.lessonNumber));
    if (hits.length === 0) {
      listHost.append(h("div", { class: "detail-empty" }, `Nothing found for “${res.query}”.`));
      return;
    }
    const turns = hits.reduce((n, hit) => n + hit.turnsMatched, 0);
    listHost.append(
      h(
        "div",
        { class: "detail-label" },
        `${turns} matching turn${turns === 1 ? "" : "s"} in ${hits.length} lesson${hits.length === 1 ? "" : "s"}${res.truncated ? " (first 100 lessons)" : ""}`
      )
    );
    for (const hit of hits) {
      const r = rowFor.get(hit.lessonNumber)!;
      const more = hit.turnsMatched - hit.snippets.length;
      listHost.append(
        h(
          "div",
          { class: "hit" },
          h(
            "button",
            { class: "date-row-head hit-head", type: "button", onclick: () => open(r.lessonNumber) },
            ...rowHead(r)
          ),
          ...hit.snippets.map((s) =>
            h(
              "button",
              { class: `hit-snippet ${s.role}`, type: "button", onclick: () => open(r.lessonNumber, s.turn, res.terms) },
              h("span", { class: "hit-who" }, s.role === "tutor" ? "Tutor" : "You"),
              marked(s.text, res.terms)
            )
          ),
          more > 0 ? h("div", { class: "hit-more" }, `and ${more} more in this lesson`) : null
        )
      );
    }
  };

  const draw = () => {
    for (const [id, btn] of chipFor) btn.classList.toggle("on", id === state.laneId);
    if (state.query.trim().length >= 2 && results && results.query === state.query.trim()) drawResults(results);
    else if (state.query.trim().length >= 2) {
      clear(listHost);
      listHost.append(h("div", { class: "detail-empty" }, "Searching…"));
    } else drawList();
  };

  const search = () => {
    const q = state.query.trim();
    if (q.length < 2) {
      results = null;
      draw();
      return;
    }
    const mine = ++pending;
    draw();
    api
      .searchLessons(q)
      .then((res) => {
        if (mine !== pending) return; // a newer query is in flight
        results = res;
        draw();
      })
      .catch((e: Error) => {
        if (mine !== pending) return;
        clear(listHost);
        listHost.append(h("div", { class: "error-box" }, `Search failed: ${e.message}`));
      });
  };

  input.addEventListener("input", () => {
    state.query = input.value;
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });

  if (!__DEMO__) host.append(input);
  host.append(chips, listHost);
  if (state.query.trim().length >= 2) search();
  else draw();
  return host;
}
