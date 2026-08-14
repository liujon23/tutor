// The accordion body of a unit block: what it covers, its topics, and the
// lessons that happened in it — the bridge into the transcript reader.
import { h } from "../dom.js";
import type { CurriculumTopic, CurriculumUnit } from "../api.js";

const TOPIC_STATE_MARK: Record<string, string> = {
  comfortable: "●",
  touched: "◐",
  shaky: "◍",
  "not-started": "○",
};

/**
 * One topic row. The last-touched lesson is a link when its transcript was
 * archived and plain text when it wasn't — lessons 1-3 predate the archive, so
 * a topic can legitimately point at a lesson with nothing to read. It can also
 * point at a lesson in a DIFFERENT unit (a recall warm-up run inside another
 * unit's lesson — recall is paired to the lane, so it never crosses lanes),
 * which is exactly why it's worth linking from here.
 */
function topicRow(
  t: CurriculumTopic,
  onOpenTranscript: (lessonNumber: number) => void
): HTMLElement {
  const mark = h(
    "span",
    { class: `topic-mark state-${t.state}`, title: t.state },
    TOPIC_STATE_MARK[t.state] ?? "○"
  );
  const name = h("span", { class: "topic-name" }, t.name);

  let trailing: HTMLElement | null = null;
  if (t.lastLesson !== null && t.lastLessonHasTranscript) {
    trailing = h(
      "button",
      {
        class: "topic-lesson-link",
        title: `Read the transcript of lesson ${t.lastLesson}`,
        onclick: () => onOpenTranscript(t.lastLesson!),
      },
      `L${t.lastLesson}${t.lastTouchedDate ? ` · ${t.lastTouchedDate}` : ""}`
    );
  } else if (t.lastLesson !== null) {
    trailing = h(
      "span",
      { class: "topic-lesson-plain", title: "This lesson predates the transcript archive" },
      `L${t.lastLesson}${t.lastTouchedDate ? ` · ${t.lastTouchedDate}` : ""} · no transcript`
    );
  }

  return h("div", { class: "topic-row" }, mark, name, trailing);
}

function topicGroup(
  title: string,
  topics: CurriculumTopic[],
  cls: string,
  onOpenTranscript: (lessonNumber: number) => void
): HTMLElement | null {
  if (topics.length === 0) return null;
  return h(
    "div",
    { class: `topic-group ${cls}` },
    h("div", { class: "detail-label" }, title),
    ...topics.map((t) => topicRow(t, onOpenTranscript))
  );
}

export function unitBody(
  u: CurriculumUnit,
  onOpenTranscript: (lessonNumber: number, unitId: string) => void
): HTMLElement {
  const open = (n: number) => onOpenTranscript(n, u.id);

  const summary = u.summary
    ? h(
        "p",
        { class: u.summaryStale ? "unit-summary stale" : "unit-summary" },
        u.summary,
        u.summaryStale
          ? h(
              "span",
              {
                class: "stale-mark",
                title:
                  "This unit changed since its summary was written. Run `npm run unit-summaries` to refresh it.",
              },
              "outdated"
            )
          : null
      )
    : null;

  const lessons =
    u.lessons.length > 0
      ? h(
          "div",
          { class: "lesson-list" },
          h("div", { class: "detail-label" }, `Lessons (${u.lessons.length})`),
          ...u.lessons.map((l) => {
            const label = h(
              "span",
              { class: "lesson-topics", ...(l.topicsFull ? { title: l.topicsFull } : {}) },
              l.topicsLabel || "—"
            );
            const head = h("span", { class: "lesson-num" }, `L${l.lessonNumber}`);
            const date = h("span", { class: "lesson-date" }, l.date);
            return l.hasTranscript
              ? h(
                  "button",
                  { class: "lesson-row", onclick: () => open(l.lessonNumber) },
                  head,
                  date,
                  label
                )
              : h(
                  "div",
                  { class: "lesson-row inert", title: "This lesson predates the transcript archive" },
                  head,
                  date,
                  label,
                  h("span", { class: "lesson-note" }, "no transcript archived")
                );
          })
        )
      : h("div", { class: "detail-empty" }, "No lessons yet.");

  // Cross-lane bridges have nowhere to point in this lane's graph, so they're
  // listed rather than drawn (in-lane ones are the dashed edges).
  const crossLane =
    u.bridgesCrossLane.length > 0
      ? h(
          "div",
          { class: "bridge-list" },
          h("div", { class: "detail-label" }, "Connects to other lanes"),
          ...u.bridgesCrossLane.map((b) =>
            h(
              "div",
              { class: "bridge-row" },
              h("span", { class: "bridge-topic" }, b.topicName),
              h("span", { class: "bridge-where" }, `${b.laneName} · ${b.unitName}`)
            )
          )
        )
      : null;

  return h(
    "div",
    { class: "unit-detail" },
    summary,
    topicGroup("Core topics", u.coreTopics, "core", open),
    topicGroup("Optional topics", u.optionalTopics, "optional", open),
    crossLane,
    lessons
  );
}
