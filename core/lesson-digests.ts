// The reading-back record of each lesson: the conclusions it reached and the
// sources it drew on. Written at commit (from the patch's lesson.keyPoints and
// lesson.sources) and, for lessons committed before these fields existed, by
// the backfill script. Never loaded into a lesson's packet — it exists for the
// learner reading a lesson back, not for the next tutor.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { LessonRecord, LessonSource } from "./types.js";

export const KEY_POINTS_MIN = 3;
export const KEY_POINTS_MAX = 6;
export const KEY_POINT_MAX_CHARS = 300;

export interface LessonDigest {
  keyPoints: string[];
  sources: LessonSource[];
  /** "commit": the teaching tutor wrote it; "backfill": written afterwards from the transcript. */
  origin: "commit" | "backfill";
}

export interface LessonDigestsFile {
  version: 1;
  lessons: Record<string, LessonDigest>;
}

export const DIGESTS_VERSION = 1;

export function emptyDigests(): LessonDigestsFile {
  return { version: DIGESTS_VERSION, lessons: {} };
}

/** A missing or unreadable file reads as empty: the reader then falls back to the history entry. */
export function loadDigests(path: string): LessonDigestsFile {
  if (!existsSync(path)) return emptyDigests();
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as Partial<LessonDigestsFile>;
    if (f?.version !== DIGESTS_VERSION || typeof f.lessons !== "object" || f.lessons === null) return emptyDigests();
    return { version: DIGESTS_VERSION, lessons: f.lessons };
  } catch {
    return emptyDigests();
  }
}

export function saveDigests(path: string, file: LessonDigestsFile): void {
  // Numeric key order, so the committed diff shows only the lesson that changed.
  const lessons = Object.fromEntries(Object.entries(file.lessons).sort(([a], [b]) => Number(a) - Number(b)));
  writeFileSync(path, JSON.stringify({ version: file.version, lessons }, null, 2) + "\n", "utf8");
}

export function digestFor(file: LessonDigestsFile, lessonNumber: number): LessonDigest | null {
  return file.lessons[String(lessonNumber)] ?? null;
}

/** Trimmed copies, with empty optional fields dropped. Assumes checkDigestFields passed. */
export function digestFromRecord(rec: Pick<LessonRecord, "keyPoints" | "sources">, origin: LessonDigest["origin"]): LessonDigest {
  return {
    keyPoints: rec.keyPoints.map((p) => p.trim()),
    sources: rec.sources.map((s) => ({
      title: s.title.trim(),
      ...(s.url?.trim() ? { url: s.url.trim() } : {}),
      ...(s.usedFor?.trim() ? { usedFor: s.usedFor.trim() } : {}),
      checked: s.checked,
    })),
    origin,
  };
}

/**
 * Errors in a lesson's keyPoints and sources, worded for the tutor that has to
 * fix them. `prefix` names where the fields sit ("lesson.").
 */
export function checkDigestFields(rec: Partial<Pick<LessonRecord, "keyPoints" | "sources">>, prefix = "lesson."): string[] {
  const errors: string[] = [];
  const kp = rec.keyPoints;
  if (!Array.isArray(kp)) {
    errors.push(`${prefix}keyPoints is required: ${KEY_POINTS_MIN}–${KEY_POINTS_MAX} conclusions the lesson reached`);
  } else {
    const real = kp.filter((p) => typeof p === "string" && p.trim());
    if (real.length !== kp.length) errors.push(`${prefix}keyPoints has an empty or non-text line`);
    if (kp.length < KEY_POINTS_MIN || kp.length > KEY_POINTS_MAX) {
      errors.push(`${prefix}keyPoints must list ${KEY_POINTS_MIN}–${KEY_POINTS_MAX} conclusions (got ${kp.length})`);
    }
    kp.forEach((p, i) => {
      if (typeof p === "string" && p.trim().length > KEY_POINT_MAX_CHARS) {
        errors.push(`${prefix}keyPoints[${i}] is over ${KEY_POINT_MAX_CHARS} characters: one conclusion per line`);
      }
    });
  }

  const src = rec.sources;
  if (!Array.isArray(src)) {
    errors.push(`${prefix}sources is required: a list of the works the lesson drew on, or [] when none were named`);
  } else {
    src.forEach((s, i) => {
      if (!s || typeof s !== "object") {
        errors.push(`${prefix}sources[${i}] must be an object {title, url?, usedFor?, checked}`);
        return;
      }
      if (typeof s.title !== "string" || !s.title.trim()) errors.push(`${prefix}sources[${i}] needs a title`);
      if (s.url !== undefined && s.url !== "" && !/^https?:\/\/\S+$/.test(String(s.url).trim())) {
        errors.push(`${prefix}sources[${i}].url is not an http(s) link`);
      }
      if (typeof s.checked !== "boolean") errors.push(`${prefix}sources[${i}] needs checked: true or false`);
    });
  }
  return errors;
}
