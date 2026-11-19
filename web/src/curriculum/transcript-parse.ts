// Split an archived transcript (server/transcript.ts renderTranscript) back into
// its parts: the header fields, the summary quote, and the turns. Pure and
// dependency-free: the reader uses it in the browser, and server search
// imports it so a search hit's turn index means the same turn the reader shows.
//
// The format it reads:
//
//   # Lesson 50 — 2026-11-12
//   - **Lane / Unit:** aisoc / aisoc-education      (header fields, any number)
//   > the lesson's "what happened" summary
//   ---
//   ### Tutor | ### <learner> | ### <learner> (spoken)
//
// Tutor messages contain their own markdown headings, so a "### " line only
// starts a turn when it names the tutor or the learner. The learner's name is
// whichever other "### " label appears most, which in a real transcript is
// every one of them.

export interface TranscriptTurn {
  role: "tutor" | "learner";
  /** The learner's answer came through speech recognition. */
  spoken: boolean;
  /** Markdown of the message, trimmed. */
  text: string;
}

export interface ParsedTranscript {
  lessonNumber: number | null;
  date: string | null;
  /** Header bullet fields by label, e.g. "Lane / Unit" → "aisoc / aisoc-education". */
  fields: Record<string, string>;
  summary: string;
  learner: string;
  turns: TranscriptTurn[];
}

export interface TranscriptLink {
  label: string;
  url: string;
  /** Index into `turns` of the first turn that gave it. */
  turn: number;
}

const TITLE_RE = /^#\s+Lesson\s+(\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/;
const FIELD_RE = /^-\s+\*\*([^*]+?):\*\*\s*(.*)$/;
const TURN_RE = /^###\s+(.+?)\s*$/;
const SPOKEN_SUFFIX = " (spoken)";

function learnerName(lines: string[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const m = TURN_RE.exec(line);
    if (!m || m[1] === "Tutor") continue;
    const name = m[1].endsWith(SPOKEN_SUFFIX) ? m[1].slice(0, -SPOKEN_SUFFIX.length) : m[1];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = "Learner";
  let most = 0;
  for (const [name, n] of counts) if (n > most) [best, most] = [name, n];
  return best;
}

export function parseTranscript(markdown: string): ParsedTranscript {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const rule = lines.findIndex((l) => l.trim() === "---");
  const headLines = rule < 0 ? [] : lines.slice(0, rule);
  const bodyLines = rule < 0 ? lines : lines.slice(rule + 1);

  let lessonNumber: number | null = null;
  let date: string | null = null;
  const fields: Record<string, string> = {};
  const summary: string[] = [];
  for (const line of headLines) {
    const title = TITLE_RE.exec(line);
    if (title) {
      lessonNumber = Number(title[1]);
      date = title[2];
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (field) {
      fields[field[1].trim()] = field[2].trim();
      continue;
    }
    if (line.startsWith(">")) summary.push(line.replace(/^>\s?/, ""));
  }

  const learner = learnerName(bodyLines);
  const turns: TranscriptTurn[] = [];
  let current: { role: TranscriptTurn["role"]; spoken: boolean; lines: string[] } | null = null;
  const flush = () => {
    if (current) turns.push({ role: current.role, spoken: current.spoken, text: current.lines.join("\n").trim() });
  };
  for (const line of bodyLines) {
    const m = TURN_RE.exec(line);
    const label = m?.[1];
    const role =
      label === "Tutor"
        ? "tutor"
        : label === learner || label === learner + SPOKEN_SUFFIX
          ? "learner"
          : null;
    if (role) {
      flush();
      current = { role, spoken: label === learner + SPOKEN_SUFFIX, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return { lessonNumber, date, fields, summary: summary.join(" ").trim(), learner, turns };
}

// A markdown link to a web page. Not an image (`![…](…)`), and not the link
// that wraps an archived image (`[![alt](assets/…)](original)`): that is the
// picture's provenance, not a source.
const LINK_RE = /(?<!!)\[([^\][]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Every web link the tutor gave, first sighting only, in order. */
export function transcriptLinks(turns: TranscriptTurn[]): TranscriptLink[] {
  const seen = new Set<string>();
  const out: TranscriptLink[] = [];
  turns.forEach((t, i) => {
    if (t.role !== "tutor") return;
    for (const m of t.text.matchAll(LINK_RE)) {
      const url = m[2];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ label: m[1].trim(), url, turn: i });
    }
  });
  return out;
}
