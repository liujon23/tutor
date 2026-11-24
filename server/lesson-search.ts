// Full-text search across archived transcripts, for the Curriculum screen's
// By date view. Zero AI tokens: the transcripts are a few MB of markdown, read
// once and cached by modification time.
//
// A lesson matches when its title, or one of its turns, contains every word
// of the query. A matching turn is one that contains every word of the query, each matched at the
// start of a word ("gate" finds "gatekeeper", not "delegate"), ignoring case.
// Turn indexes come from the same parser the reader uses, so the reader can
// open a hit at its turn.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../web/src/curriculum/transcript-parse.js";
import { PATHS } from "../scripts/lib.js";
import { loadDigests } from "../core/lesson-digests.js";

export interface SearchSnippet {
  turn: number;
  role: "tutor" | "learner";
  text: string;
}

export interface SearchHit {
  lessonNumber: number;
  /** Every word of the query is in the lesson's title. */
  titleMatched: boolean;
  /** How many turns of this lesson match. */
  turnsMatched: number;
  /** The first few, in order. */
  snippets: SearchSnippet[];
}

export interface SearchResult {
  query: string;
  /** The words matched, lower-cased, for the client to mark. */
  terms: string[];
  hits: SearchHit[];
  /** More lessons matched than are returned. */
  truncated: boolean;
}

/** One searchable document: a lesson's turns as plain text. */
export interface SearchDoc {
  lessonNumber: number;
  /** The lesson's title, when it has one. */
  title?: string;
  turns: { role: "tutor" | "learner"; plain: string }[];
}

const MAX_TERMS = 8;
const MAX_HITS = 100;
const SNIPPETS_PER_HIT = 3;
const BEFORE = 60;
const AFTER = 120;

/** Markdown → the words a reader sees: no image or link targets, no emphasis marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a term at the start of a word. Exported so tests pin the rule. */
export function termPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}`, "iu");
}

/** ~180 characters around the first matched term, cut at spaces. */
export function snippetAround(plain: string, patterns: RegExp[]): string {
  let at = plain.length;
  for (const re of patterns) {
    const m = re.exec(plain);
    if (m && m.index < at) at = m.index;
  }
  if (at === plain.length) at = 0;
  let start = Math.max(0, at - BEFORE);
  let end = Math.min(plain.length, at + AFTER);
  if (start > 0) {
    const space = plain.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  return (start > 0 ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
}

/** Pure search over prepared documents. Newest lesson first. */
export function searchDocs(docs: SearchDoc[], query: string): SearchResult {
  const terms = queryTerms(query);
  if (terms.length === 0) return { query, terms, hits: [], truncated: false };
  const patterns = terms.map(termPattern);
  const hits: SearchHit[] = [];
  for (const doc of [...docs].sort((a, b) => b.lessonNumber - a.lessonNumber)) {
    const snippets: SearchSnippet[] = [];
    let turnsMatched = 0;
    doc.turns.forEach((t, i) => {
      if (!patterns.every((re) => re.test(t.plain))) return;
      turnsMatched++;
      if (snippets.length < SNIPPETS_PER_HIT) {
        snippets.push({ turn: i, role: t.role, text: snippetAround(t.plain, patterns) });
      }
    });
    const titleMatched = !!doc.title && patterns.every((re) => re.test(doc.title!));
    if (turnsMatched > 0 || titleMatched) hits.push({ lessonNumber: doc.lessonNumber, titleMatched, turnsMatched, snippets });
  }
  return { query, terms, hits: hits.slice(0, MAX_HITS), truncated: hits.length > MAX_HITS };
}

// --- The transcripts on disk, cached --------------------------------------------

const cache = new Map<string, { mtimeMs: number; size: number; doc: SearchDoc }>();

export function docFromMarkdown(lessonNumber: number, markdown: string): SearchDoc {
  return {
    lessonNumber,
    turns: parseTranscript(markdown).turns.map((t) => ({ role: t.role, plain: plainText(t.text) })),
  };
}

export function loadSearchDocs(dir: string = PATHS.transcriptsDir): SearchDoc[] {
  if (!existsSync(dir)) return [];
  const docs: SearchDoc[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^lesson-(\d+)\.md$/.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    const st = statSync(file);
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = { mtimeMs: st.mtimeMs, size: st.size, doc: docFromMarkdown(Number(m[1]), readFileSync(file, "utf8")) };
      cache.set(file, entry);
    }
    docs.push(entry.doc);
  }
  return docs;
}

export function searchTranscripts(
  query: string,
  dir: string = PATHS.transcriptsDir,
  digestsPath: string = PATHS.lessonDigests
): SearchResult {
  const digests = loadDigests(digestsPath);
  const docs = loadSearchDocs(dir).map((d) => {
    const title = digests.lessons[String(d.lessonNumber)]?.title;
    return title ? { ...d, title } : d;
  });
  return searchDocs(docs, query);
}
