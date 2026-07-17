import { readFileSync, writeFileSync } from "node:fs";
import type { BulletEdits, ProfilePatch } from "./types.js";

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

interface Section {
  start: number; // index of heading line
  end: number; // exclusive — index of next "## " heading or EOF
}

function findSection(lines: string[], headingPrefix: string): Section | null {
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

function applyBulletEdits(lines: string[], headingPrefix: string, edits: BulletEdits): string[] {
  const sec = findSection(lines, headingPrefix);
  if (!sec) throw new Error(`profile.md: section starting with '${headingPrefix}' not found`);

  let work = [...lines];

  // Removals first (indices shift otherwise)
  for (const needle of edits.removeContaining ?? []) {
    const s = findSection(work, headingPrefix)!;
    const blocks = bulletBlocks(work, s);
    const hit = blocks.find(([a, b]) => work.slice(a, b).join(" ").includes(needle));
    if (!hit) {
      throw new Error(
        `profile.md: no bullet containing '${needle}' in section '${headingPrefix}' — nothing removed (patch aborted)`
      );
    }
    work.splice(hit[0], hit[1] - hit[0]);
  }

  // Additions at the end of the section (after the last bullet or comment)
  for (const text of edits.add ?? []) {
    const s = findSection(work, headingPrefix)!;
    let insertAt = s.end;
    while (insertAt > s.start + 1 && work[insertAt - 1].trim() === "") insertAt--;
    work.splice(insertAt, 0, ...formatBullet(text));
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
