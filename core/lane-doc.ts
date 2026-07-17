// Deterministic export of a curriculum lane to a shareable document — Markdown
// and self-contained HTML (the HTML is the print source for the PDF exporter in
// scripts/export-lane.ts). No AI, no network: the output is a pure function of
// the lane.
//
// What a reader sees vs. what stays behind: this deliberately drops everything
// that is state/bookkeeping — topic and unit `state`, `lastTouched`, `nextUp`,
// `currentUnit`/`currentTopic`, the prerequisite/buildsToward graph, internal
// ids, and lane `weight`. It keeps the human-written content verbatim: the
// lane `direction`, unit `notes`, topic `notes`, and curated links (assets).
// Notes are passed through as authored — no softening or rephrasing.
//
// The `notes` option (default true) drops the authored prose — the direction,
// unit/topic notes, and link annotations — leaving only the structural skeleton
// (title, units, topics, link titles + urls). That prose is written in the
// tutoring voice and often names the learner directly; since a deterministic pass can't
// safely rewrite it out sentence by sentence, the outsider-safe mode omits it
// wholesale, yielding a clean syllabus / reading-list view.

import type { Lane, Topic, TopicAsset, Unit } from "./types.js";

// ---------------------------------------------------------------------------
// Intermediate model — the single source of truth for *what is included*. Both
// the Markdown and HTML renderers walk this, so the two can never drift on which
// fields make it into the document.
// ---------------------------------------------------------------------------

export interface DocLink {
  title: string;
  url: string;
  note?: string;
}

export interface DocItem {
  name: string;
  notes?: string;
  links: DocLink[];
}

export interface DocUnit {
  name: string;
  notes?: string;
  core: DocItem[];
  optional: DocItem[];
}

export interface LaneDoc {
  title: string;
  intro?: string;
  units: DocUnit[];
}

/** Collapse authored whitespace (YAML folds already turn newlines into spaces)
 *  without altering wording. Empty/whitespace-only becomes undefined. */
function clean(s: string | undefined | null): string | undefined {
  const out = (s ?? "").replace(/\s+/g, " ").trim();
  return out.length ? out : undefined;
}

function linkOf(a: TopicAsset): DocLink {
  return { title: a.title, url: a.url, note: clean(a.note) };
}

function itemOf(t: Topic): DocItem {
  return { name: t.name, notes: clean(t.notes), links: (t.assets ?? []).map(linkOf) };
}

function unitOf(u: Unit): DocUnit {
  return {
    name: u.name,
    notes: clean(u.notes),
    core: u.coreTopics.map(itemOf),
    optional: u.optionalTopics.map(itemOf),
  };
}

export interface LaneDocOptions {
  /** Include the authored prose (direction, unit/topic notes, link annotations).
   *  Default true. Set false for the outsider-safe skeleton — see the file header. */
  notes?: boolean;
}

export function buildLaneDoc(lane: Lane, opts: LaneDocOptions = {}): LaneDoc {
  const notes = opts.notes ?? true;
  // "Lane" is the system's internal word for a track — drop the trailing suffix
  // so the shared title reads naturally (e.g. "AI Lane" → "AI").
  const title = lane.name.replace(/\s+Lane$/i, "");
  const intro = notes ? clean(lane.direction) : undefined;
  const units = lane.units.map((u) => {
    const unit = unitOf(u);
    return notes ? unit : stripUnitNotes(unit);
  });
  return { title, intro, units };
}

/** Remove all authored prose from a unit: its notes, its topics' notes, and any
 *  link annotations — keeping names and link titles/urls. */
function stripUnitNotes(unit: DocUnit): DocUnit {
  const strip = (item: DocItem): DocItem => ({
    name: item.name,
    links: item.links.map((l) => ({ title: l.title, url: l.url })),
  });
  return { name: unit.name, core: unit.core.map(strip), optional: unit.optional.map(strip) };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function itemMarkdown(item: DocItem): string {
  const lines = [`- **${item.name}**`];
  if (item.notes) lines.push(`  ${item.notes}`);
  for (const l of item.links) {
    lines.push(`  - [${l.title}](${l.url})${l.note ? ` — ${l.note}` : ""}`);
  }
  return lines.join("\n");
}

export function docToMarkdown(doc: LaneDoc): string {
  const out: string[] = [`# ${doc.title}`];
  if (doc.intro) out.push(`*${doc.intro}*`);

  for (const unit of doc.units) {
    out.push(`## ${unit.name}`);
    if (unit.notes) out.push(unit.notes);
    if (unit.core.length) {
      out.push("**Core topics**");
      out.push(unit.core.map(itemMarkdown).join("\n"));
    }
    if (unit.optional.length) {
      out.push("**Optional topics**");
      out.push(unit.optional.map(itemMarkdown).join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

export function renderLaneMarkdown(lane: Lane, opts?: LaneDocOptions): string {
  return docToMarkdown(buildLaneDoc(lane, opts));
}

// ---------------------------------------------------------------------------
// HTML (self-contained; the print source for the PDF)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape, then honor the light markdown emphasis the authored notes use so the
 *  PDF matches the .md: `**bold**` and `*italic*` (the latter is how book titles
 *  are written in the notes). Applied to prose only, never to names/urls. */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function itemHtml(item: DocItem): string {
  const parts = [`<strong>${esc(item.name)}</strong>`];
  if (item.notes) parts.push(`<span class="note">${inline(item.notes)}</span>`);
  let html = `<li>${parts.join("<br>")}`;
  if (item.links.length) {
    const links = item.links
      .map(
        (l) =>
          `<li><a href="${esc(l.url)}">${esc(l.title)}</a>${
            l.note ? ` — <span class="linknote">${inline(l.note)}</span>` : ""
          }</li>`
      )
      .join("");
    html += `<ul class="links">${links}</ul>`;
  }
  return html + "</li>";
}

const CSS = `
  :root { color-scheme: light; }
  body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.3rem; margin: 2rem 0 .4rem; padding-bottom: .25rem;
       border-bottom: 1px solid #ddd; }
  .intro { font-style: italic; color: #444; margin: 0 0 1rem; }
  .unit-notes { color: #333; margin: .3rem 0 .6rem; }
  h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em;
       color: #666; margin: 1rem 0 .3rem; }
  ul { margin: .3rem 0; padding-left: 1.4rem; }
  li { margin: .5rem 0; }
  .note { color: #333; }
  ul.links { margin: .25rem 0 .5rem; padding-left: 1.2rem; }
  ul.links li { margin: .2rem 0; font-size: .92em; }
  a { color: #1a5db8; text-decoration: none; }
  .linknote { color: #666; }
  @media print { body { margin: 0 auto; } h2 { break-after: avoid; } li { break-inside: avoid; } }
`;

export function docToHtml(doc: LaneDoc): string {
  const body: string[] = [`<h1>${esc(doc.title)}</h1>`];
  if (doc.intro) body.push(`<p class="intro">${inline(doc.intro)}</p>`);

  for (const unit of doc.units) {
    body.push(`<h2>${esc(unit.name)}</h2>`);
    if (unit.notes) body.push(`<p class="unit-notes">${inline(unit.notes)}</p>`);
    if (unit.core.length) {
      body.push(`<h3>Core topics</h3>`);
      body.push(`<ul>${unit.core.map(itemHtml).join("")}</ul>`);
    }
    if (unit.optional.length) {
      body.push(`<h3>Optional topics</h3>`);
      body.push(`<ul>${unit.optional.map(itemHtml).join("")}</ul>`);
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(doc.title)}</title>
<style>${CSS}</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

export function renderLaneHtml(lane: Lane, opts?: LaneDocOptions): string {
  return docToHtml(buildLaneDoc(lane, opts));
}
