import { readFileSync, writeFileSync } from "node:fs";
import type { BulletAdd, BulletEdits, ProfilePatch } from "./types.js";

/**
 * profile.md is prose and stays markdown. We edit it *surgically*: bullets are
 * added to / removed from named sections; nothing else is touched. A bullet is
 * a "- " line plus any following indented continuation lines.
 */

export const SECTIONS = {
  confirmedPatterns: "## How I learn best",
  broaderPrerequisites: "## Broader prerequisites",
  settledQuestions: "## Settled questions",
  workingNotes: "## Working notes",
} as const;

/** Learner display name from the profile's H1 ("# Learner Profile — <name>");
 *  "Learner" when the title carries no name. */
export function learnerName(profileMarkdown: string): string {
  const m = profileMarkdown.match(/^# Learner Profile [—-] (.+?)\s*$/m);
  return m ? m[1].trim() : "Learner";
}

export interface Section {
  start: number; // index of heading line
  end: number; // exclusive — index of next "## " heading or EOF
}

/** Locate one `## ` section by heading prefix. Line-anchored on purpose: a prose
 *  mention of a heading inside a bullet must not be mistaken for the heading. */
export function findSection(lines: string[], headingPrefix: string): Section | null {
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Wrap text into a "- ..." bullet with two-space continuation indent at ~92 cols. */
export function formatBullet(text: string): string[] {
  const words = text.trim().replace(/\s+/g, " ").split(" ");
  const out: string[] = [];
  let line = "-";
  for (const w of words) {
    const prefixLen = out.length === 0 ? 0 : 2;
    if ((line + " " + w).length > 92 && line !== "-" && line.trim() !== "") {
      out.push(line);
      line = "  " + w;
      continue;
    }
    line = line === "-" ? "- " + w : line + " " + w;
    void prefixLen;
  }
  if (line.trim()) out.push(line);
  return out;
}

/** Bullet blocks within a section: each block is [startLine, endLineExclusive]. */
function bulletBlocks(lines: string[], sec: Section): [number, number][] {
  const blocks: [number, number][] = [];
  let i = sec.start + 1;
  while (i < sec.end) {
    if (lines[i].startsWith("- ")) {
      let j = i + 1;
      while (j < sec.end && /^\s{2,}\S/.test(lines[j])) j++;
      blocks.push([i, j]);
      i = j;
    } else i++;
  }
  return blocks;
}

/**
 * Text as a removal needle is matched against it: runs of whitespace — a
 * bullet's line wraps and two-space continuation indent included — count as
 * one space, and curly quotes as straight ones. Bullets are wrapped at ~92
 * columns on disk but quoted on one line by the model, so a phrase that
 * crossed a wrap never matched: three rejected commit_session calls (each
 * re-sending a ~20k-char patch) before Lesson 32 committed, two before 29.
 */
function matchText(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/** How each bullet in a section begins — told to the model on a miss, so its retry quotes real text. */
function bulletOpenings(work: string[], s: Section): string {
  const openings = bulletBlocks(work, s).map(([a, b]) => {
    const t = matchText(work.slice(a, b).join(" ")).replace(/^- /, "");
    return `"${t.length > 70 ? `${t.slice(0, 70)}…` : t}"`;
  });
  if (!openings.length) return " The section has no bullets.";
  const shown = openings.slice(0, 30);
  return ` Its bullets begin: ${shown.join(" | ")}${openings.length > shown.length ? ` | …and ${openings.length - shown.length} more` : ""}.`;
}

/** A theme line inside a section: a bold phrase alone on its line (`**Lanes**`). */
const THEME_RE = /^\*\*(.+?)\*\*\s*$/;

/** The themes of a section, in order, with the line each sits on. */
function themesOf(work: string[], s: Section): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  for (let i = s.start + 1; i < s.end; i++) {
    const m = work[i].match(THEME_RE);
    if (m) out.push({ name: m[1].trim(), line: i });
  }
  return out;
}

/** The themes a section is grouped under (empty when it is a flat list). */
export function sectionThemes(profileMarkdown: string, headingPrefix: string): string[] {
  const lines = profileMarkdown.split("\n");
  const s = findSection(lines, headingPrefix);
  return s ? themesOf(lines, s).map((t) => t.name) : [];
}

/**
 * Where an added bullet goes. Plain text: the end of the section. Under a
 * theme: after that theme's last bullet (or straight after the theme line if
 * it has none), so a themed section stays grouped — appended at the end,
 * thirteen notes in a row landed under the last theme, "Tooling", whatever
 * they were about (Lessons 44–50).
 */
function insertionPoint(work: string[], s: Section, headingPrefix: string, add: BulletAdd): number {
  let from = s.start;
  let to = s.end;
  if (typeof add !== "string") {
    const themes = themesOf(work, s);
    const want = add.under.replace(/\*/g, "").trim().toLowerCase();
    const at = themes.findIndex((t) => t.name.toLowerCase() === want);
    if (at === -1) {
      const known = themes.length
        ? `Its themes: ${themes.map((t) => `"${t.name}"`).join(" | ")}.`
        : "The section has no themes — add the note as plain text.";
      throw new Error(`profile.md: no theme '${add.under}' in section '${headingPrefix}' — nothing added (patch aborted). ${known}`);
    }
    from = themes[at].line;
    to = at + 1 < themes.length ? themes[at + 1].line : s.end;
  }
  let insertAt = to;
  while (insertAt > from + 1 && work[insertAt - 1].trim() === "") insertAt--;
  return insertAt;
}

function applyBulletEdits(lines: string[], headingPrefix: string, edits: BulletEdits): string[] {
  const sec = findSection(lines, headingPrefix);
  if (!sec) throw new Error(`profile.md: section starting with '${headingPrefix}' not found`);

  let work = [...lines];

  // Removals first (indices shift otherwise)
  for (const needle of edits.removeContaining ?? []) {
    const s = findSection(work, headingPrefix)!;
    const want = matchText(needle);
    // An empty needle is contained in every bullet: it would silently remove the first.
    if (!want) throw new Error(`profile.md: empty removeContaining in section '${headingPrefix}' (patch aborted)`);
    const hit = bulletBlocks(work, s).find(([a, b]) => matchText(work.slice(a, b).join(" ")).includes(want));
    if (!hit) {
      throw new Error(
        `profile.md: no bullet containing '${needle}' in section '${headingPrefix}' — nothing removed (patch aborted).` +
          bulletOpenings(work, s)
      );
    }
    work.splice(hit[0], hit[1] - hit[0]);
  }

  // Additions: under their theme, or at the end of the section (after the last bullet or comment)
  for (const add of edits.add ?? []) {
    const s = findSection(work, headingPrefix)!;
    const text = typeof add === "string" ? add : add.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`profile.md: empty bullet added to section '${headingPrefix}' (patch aborted)`);
    }
    work.splice(insertionPoint(work, s, headingPrefix, add), 0, ...formatBullet(text));
  }

  return work;
}

export interface ProfileApplyResult {
  proposedConfirmedPatterns: string[]; // surfaced, never applied
  changed: boolean;
}

/**
 * Pure text transform — no file I/O. Applies a ProfilePatch's bullet edits to
 * an in-memory line array and reports whether anything changed. Throws the
 * same errors `applyProfilePatch` used to (e.g. a `removeContaining` needle
 * that matches nothing) so callers can validate a patch before touching disk.
 */
export function applyProfilePatchToLines(
  lines: string[],
  patch: ProfilePatch
): { lines: string[]; changed: boolean } {
  let work = lines;
  let changed = false;

  const pairs: [keyof typeof SECTIONS, BulletEdits | undefined][] = [
    ["workingNotes", patch.workingNotes],
    ["broaderPrerequisites", patch.broaderPrerequisites],
    ["settledQuestions", patch.settledQuestions],
  ];
  for (const [key, edits] of pairs) {
    if (edits && ((edits.add?.length ?? 0) > 0 || (edits.removeContaining?.length ?? 0) > 0)) {
      work = applyBulletEdits(work, SECTIONS[key], edits);
      changed = true;
    }
  }

  // Confirmed patterns: gated. Only 'approvedConfirmedPatterns' is ever applied.
  if (
    patch.approvedConfirmedPatterns &&
    ((patch.approvedConfirmedPatterns.add?.length ?? 0) > 0 ||
      (patch.approvedConfirmedPatterns.removeContaining?.length ?? 0) > 0)
  ) {
    work = applyBulletEdits(work, SECTIONS.confirmedPatterns, patch.approvedConfirmedPatterns);
    changed = true;
  }

  return { lines: work, changed };
}

export function applyProfilePatch(path: string, patch: ProfilePatch): ProfileApplyResult {
  const lines = readFileSync(path, "utf8").split("\n");
  const { lines: work, changed } = applyProfilePatchToLines(lines, patch);
  if (changed) writeFileSync(path, work.join("\n"), "utf8");
  return { proposedConfirmedPatterns: patch.proposedConfirmedPatterns ?? [], changed };
}

/**
 * Validate a profile patch against the file on disk WITHOUT writing anything.
 * Returns human-readable errors; empty = safe to apply.
 */
export function checkProfilePatch(path: string, patch: ProfilePatch): string[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    applyProfilePatchToLines(lines, patch);
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

export function readProfile(path: string): string {
  return readFileSync(path, "utf8");
}
