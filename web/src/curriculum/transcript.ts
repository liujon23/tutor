// The transcript reader: an archived lesson, laid out for reading back.
//
// Top to bottom: what the lesson was, its key points (or, for a lesson without
// them, the history's "What happened"), its sources, how it went, the
// bookkeeping, then the conversation as bubbles and a way to the lessons either
// side. The transcript file is the source of the conversation; the key points,
// sources, history entry, ratings and cost come from /api/lessons/:n, and the
// reader still works without them (the demo build has none).
import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { LessonDetail } from "../api.js";
import { renderInto } from "../markdown.js";
import { parseTranscript, transcriptLinks, type ParsedTranscript, type TranscriptLink } from "./transcript-parse.js";

/**
 * Archived images are written relative to the transcripts directory
 * (`assets/lesson-018/…`), but the app is always served from `/`, so a relative
 * src would 404. Rewrite them to the static route that actually serves them.
 *
 * In a demo build the transcript lives under `demo/transcripts/`, so its assets
 * resolve there instead. Both prefixes are allow-listed in markdown.ts — without
 * that, DOMPurify strips the src and every lesson image vanishes.
 */
export function rewriteAssetPaths(markdown: string, base: string): string {
  return markdown.replace(/(!\[[^\]]*\]\()\s*(assets\/)/g, (_m, open: string, rel: string) => `${open}${base}${rel}`);
}

// Demo: a RELATIVE prefix, matching how the recording's own images are written.
// The app never changes its URL (no router), so this resolves against the
// deploy base — and it's the form the markdown allowlist matches, which an
// absolute "/tutor/demo/..." would not be.
const assetBase = (): string => (__DEMO__ ? "demo/transcripts/" : "/transcripts/");

export interface TranscriptOptions {
  /** Open scrolled to this turn (a search hit), briefly marked. */
  turn?: number;
  /** Search words to mark inside that turn; the view centres on the first. */
  terms?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wrap each term (at a word start, as search matches) in <mark>. Returns the marks. */
function markTerms(el: HTMLElement, terms: string[]): HTMLElement[] {
  if (terms.length === 0) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "giu");
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.data;
    const found = [...text.matchAll(re)];
    if (found.length === 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of found) {
      frag.append(text.slice(last, m.index));
      const mark = h("mark", { class: "reader-hit" }, m[0]);
      marks.push(mark);
      frag.append(mark);
      last = m.index! + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return marks;
}

const RATING_MARK: Record<string, string> = { "2": "⏫", "1": "👍", "-1": "👎", "-2": "⏬" };

/** "2026-11-12" → "12 Nov 2026". */
export function readableDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The history fields and the summary are plain prose the tutor wrote at
 * commit, not message markdown: "~$17M … ~$13M" must not turn into maths.
 */
function proseBlock(src: string): HTMLElement {
  return h("div", { class: "reader-prose" }, src);
}

/** A button that copies `text` and says so for a moment. */
function copyButton(label: string, text: () => string): HTMLButtonElement {
  const btn = h("button", { class: "reader-copy", type: "button" }, label) as HTMLButtonElement;
  btn.addEventListener("click", () => {
    void navigator.clipboard
      ?.writeText(text())
      .then(() => {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = label), 1500);
      })
      .catch(() => {
        btn.textContent = "Couldn't copy";
        setTimeout(() => (btn.textContent = label), 1500);
      });
  });
  return btn;
}

function section(title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h("details", { class: "reader-section" }, h("summary", {}, title), ...body);
}

function field(label: string, value: string | undefined | null): HTMLElement | null {
  if (!value) return null;
  return h("div", { class: "reader-field" }, h("div", { class: "detail-label" }, label), proseBlock(value));
}

type Digest = NonNullable<LessonDetail["digest"]>;

/** The sources the tutor listed at commit, each linked to where it came up when the transcript has its link. */
function listedSources(
  sources: Digest["sources"],
  links: TranscriptLink[],
  prose: string | undefined,
  proseLabel: string,
  jump: (turn: number) => void
): HTMLElement {
  const turnOf = new Map(links.map((l) => [l.url, l.turn]));
  const list = h(
    "ul",
    { class: "source-list" },
    ...sources.map((s) => {
      const turn = s.url ? turnOf.get(s.url) : undefined;
      return h(
        "li",
        {},
        s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title) : h("span", { class: "source-title" }, s.title),
        s.url ? h("span", { class: "source-host" }, hostOf(s.url)) : null,
        s.checked ? null : h("span", { class: "source-unchecked", title: "Named from memory; not looked up in this lesson" }, "not checked"),
        s.usedFor ? h("div", { class: "source-use" }, s.usedFor) : null,
        turn !== undefined
          ? h("button", { class: "source-jump", type: "button", onclick: () => jump(turn) }, "where it came up")
          : null
      );
    })
  );
  const copyText = () =>
    [
      sources
        .map((s) => `- ${s.title}${s.url ? `: ${s.url}` : ""}${s.usedFor ? ` (${s.usedFor})` : ""}${s.checked ? "" : " [not checked]"}`)
        .join("\n"),
      prose ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
  return section(
    `Sources (${sources.length})`,
    list,
    field(proseLabel, prose),
    h("div", { class: "reader-actions" }, copyButton("Copy all", copyText))
  );
}

function sourcesSection(
  digest: Digest | null,
  links: TranscriptLink[],
  prose: string | undefined,
  jump: (turn: number) => void
): HTMLElement | null {
  // A backfilled lesson's "Sources used" is the old prose list, not a note on handling.
  if (digest && digest.sources.length > 0)
    return listedSources(digest.sources, links, prose, digest.origin === "commit" ? "How they were handled" : "Also named", jump);
  if (links.length === 0 && !prose) return null;
  const list = links.length
    ? h(
        "ul",
        { class: "source-list" },
        ...links.map((l) =>
          h(
            "li",
            {},
            h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label),
            h("span", { class: "source-host" }, hostOf(l.url)),
            h("button", { class: "source-jump", type: "button", onclick: () => jump(l.turn) }, "where it came up")
          )
        )
      )
    : null;
  const copyText = () =>
    [links.map((l) => `- ${l.label}: ${l.url}`).join("\n"), prose ?? ""].filter(Boolean).join("\n\n");
  const title = links.length ? `Sources (${links.length} link${links.length === 1 ? "" : "s"})` : "Sources";
  return section(
    title,
    list,
    field(links.length ? "Also named" : "Named in the lesson", prose),
    h("div", { class: "reader-actions" }, copyButton("Copy all", copyText))
  );
}

function howItWent(detail: LessonDetail | null): HTMLElement | null {
  const hist = detail?.history;
  const ratings = detail?.ratings ?? [];
  if (!hist && ratings.length === 0) return null;
  // With key points at the top, the full account moves down here.
  const whatHappened = detail?.digest ? hist?.whatHappened : undefined;
  const ratingList = ratings.length
    ? h(
        "div",
        { class: "reader-field" },
        h("div", { class: "detail-label" }, `Your ratings (${ratings.length})`),
        h(
          "ul",
          { class: "rating-list" },
          ...ratings.map((r) =>
            h(
              "li",
              {},
              h("span", { class: "rating-mark" }, RATING_MARK[String(r.level)] ?? String(r.level)),
              h("span", {}, r.takeaway || r.context)
            )
          )
        )
      )
    : null;
  return section(
    "How it went",
    field("What happened", whatHappened),
    field("Performance", hist?.performanceSketch),
    field("What you asked for", hist?.askedAbout),
    ratingList,
    field("Feedback noted", hist?.feedbackCaptured)
  );
}

function detailsSection(parsed: ParsedTranscript, detail: LessonDetail | null): HTMLElement {
  const f = parsed.fields;
  const rows: [string, string | undefined | null][] = [
    ["Size / model", f["Size / model"]],
    ["Spoken", f["Spoken"]],
    ["Usage", detail?.usage ?? f["Usage"]],
    ["Commit timing", f["Commit timing"]],
    ["Committed", f["Committed"]],
  ];
  return section(
    "Details",
    h(
      "dl",
      { class: "reader-meta" },
      ...rows.filter(([, v]) => v).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v!)])
    )
  );
}

function conversation(parsed: ParsedTranscript): { el: HTMLElement; turns: HTMLElement[] } {
  const turns = parsed.turns.map((t) => {
    const bubble = h("div", { class: `bubble ${t.role === "tutor" ? "assistant" : "user"}` });
    renderInto(bubble, rewriteAssetPaths(t.text, assetBase()));
    const foot =
      t.role === "tutor"
        ? h("div", { class: "turn-foot" }, copyButton("Copy", () => t.text))
        : t.spoken
          ? h("div", { class: "turn-foot" }, h("span", { class: "turn-spoken" }, "spoken"))
          : null;
    return h("div", { class: `turn ${t.role}` }, bubble, foot);
  });
  return { el: h("div", { class: "reader-turns" }, ...turns), turns };
}

export async function showTranscript(
  root: HTMLElement,
  lessonNumber: number,
  onBack: () => void,
  opts: TranscriptOptions = {}
): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading transcript…"));

  const header = () =>
    h(
      "header",
      { class: "app-header" },
      h("button", { class: "back", onclick: () => onBack() }, "‹"),
      h("h1", {}, `Lesson ${lessonNumber}`)
    );

  let markdown: string;
  let detail: LessonDetail | null;
  try {
    [markdown, detail] = await Promise.all([
      api.transcript(lessonNumber),
      api.lessonDetail(lessonNumber).catch(() => null),
    ]);
  } catch (e) {
    clear(root);
    root.append(
      h("div", { class: "screen transcript" }, header(), h("div", { class: "error-box" }, (e as Error).message))
    );
    return;
  }
  clear(root);

  const parsed = parseTranscript(markdown);
  const links = transcriptLinks(parsed.turns);
  const screen = h("div", { class: "screen transcript" });
  const { el: turnsEl, turns } = conversation(parsed);

  const jump = (turn: number, behavior: ScrollBehavior = "smooth") => {
    const el = turns[turn];
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation on a repeat jump
    el.classList.add("flash");
  };

  const date = detail?.date ?? parsed.date;
  const where = detail ? `${detail.laneName.replace(/\s+Lane$/, "")} · ${detail.unitName}` : parsed.fields["Lane / Unit"];
  const topics = detail?.topics || parsed.fields["Topics"];
  const digest = detail?.digest ?? null;
  const summary = detail?.history?.whatHappened || parsed.summary;
  const top = digest?.keyPoints.length
    ? h(
        "div",
        { class: "reader-summary" },
        h("div", { class: "detail-label" }, "Key points"),
        h("ul", { class: "reader-keypoints" }, ...digest.keyPoints.map((p) => h("li", {}, p)))
      )
    : summary
      ? h("div", { class: "reader-summary" }, h("div", { class: "detail-label" }, "What happened"), proseBlock(summary))
      : null;

  const nav =
    detail && (detail.prev || detail.next)
      ? h(
          "nav",
          { class: "reader-nav" },
          detail.prev
            ? h("button", { class: "chip", onclick: () => void showTranscript(root, detail!.prev!, onBack) }, `‹ Lesson ${detail.prev}`)
            : h("span", {}),
          detail.next
            ? h("button", { class: "chip", onclick: () => void showTranscript(root, detail!.next!, onBack) }, `Lesson ${detail.next} ›`)
            : h("span", {})
        )
      : null;

  const parts: (HTMLElement | null)[] = [
    header(),
    h(
      "div",
      { class: "reader-title" },
      date ? h("div", { class: "reader-date" }, readableDate(date)) : null,
      where ? h("div", { class: "reader-where" }, where) : null,
      topics ? h("div", { class: "reader-topics" }, topics) : null
    ),
    top,
    h(
      "div",
      { class: "reader-sections" },
      sourcesSection(digest, links, detail?.history?.sourcesUsed, jump),
      howItWent(detail),
      detailsSection(parsed, detail)
    ),
    h("div", { class: "detail-label reader-conv-label" }, "The conversation"),
    turnsEl,
    nav,
  ];
  screen.append(...parts.filter((p): p is HTMLElement => p !== null));
  root.append(screen);

  // Long transcripts: start at the top, never wherever the last screen was —
  // unless a search hit asked for a turn.
  screen.scrollTop = 0;
  if (opts.turn !== undefined) {
    const target = turns[opts.turn];
    const first = target ? markTerms(target, opts.terms ?? [])[0] : undefined;
    requestAnimationFrame(() => {
      jump(opts.turn!, "auto");
      // A long message can hold the match well below its first line.
      first?.scrollIntoView({ block: "center" });
    });
  }
}
