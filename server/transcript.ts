// Render a lesson transcript to markdown and archive it under transcripts/.
// The distilled patch is the machine record; this is the human one — the full
// conversation, committed alongside the data files so it's durable and greppable.
// Embedded images whose proxy cache entry exists are copied into
// transcripts/assets/lesson-NNN/ and the archived markdown points at those
// copies (the original URL is kept as the wrapping link) — .app/ is ephemeral,
// the commit is the record.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { learnerName } from "../core/profile.js";
import { PATHS } from "../scripts/lib.js";
import { ASSETS_DIR, cachedAssetFile } from "./assets.js";
import { usageHeadline } from "./usage.js";
import type { SessionPatch } from "../core/types.js";
import type { LessonUsage, StoredSession } from "./types.js";

const TRANSCRIPTS_DIR = PATHS.transcriptsDir;

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * Per-phase wall-clock cost of the commit, from the learner's "go ahead" onward. Only the
 * phases knowable before the transcript is written land here — the transcript's
 * own write and the git commit that seals it are reported by the caller instead
 * (a step can't record its own duration inside the file it produces).
 */
export interface CommitTimings {
  composeMs: number; // the learner's last message → the commit_session call (model building the patch)
  validateMs: number;
  writeMs: number; // curriculum / history / profile
  archiveMs: number; // usage + feedback ledgers
}

/** Compact human duration: seconds past 1s, else milliseconds. */
export function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** transcripts/lesson-007.md — repo-relative path returned for the git message. */
export function transcriptRelPath(lessonNumber: number): string {
  return `transcripts/lesson-${pad(lessonNumber)}.md`;
}

// Markdown images with an absolute URL (optionally with a "title").
const IMG_RE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Rewrite embedded images to their archived copies. `assetMap` maps original
 * URL → transcript-relative path; unmapped images are left untouched. The
 * archived copy is wrapped in a link to the original URL so provenance stays.
 */
export function rewriteArchivedImages(text: string, assetMap: Map<string, string>): string {
  if (assetMap.size === 0) return text;
  return text.replace(IMG_RE, (whole, alt: string, url: string) => {
    const rel = assetMap.get(url);
    return rel ? `[![${alt}](${rel})](${url})` : whole;
  });
}

/** Pure render — separated from the file write so it's unit-testable. */
export function renderTranscript(
  session: StoredSession,
  patch: SessionPatch,
  lessonNumber: number,
  assetMap: Map<string, string> = new Map(),
  usage?: LessonUsage,
  timings?: CommitTimings,
  learner: string = "Learner"
): string {
  const L = patch.lesson;
  const timingLine = timings
    ? `compose ${fmtDuration(timings.composeMs)} · validate ${fmtDuration(
        timings.validateMs
      )} · write ${fmtDuration(timings.writeMs)} · archive ${fmtDuration(
        timings.archiveMs
      )} (through archive ${fmtDuration(
        timings.composeMs + timings.validateMs + timings.writeMs + timings.archiveMs
      )})`
    : "";
  const header = [
    `# Lesson ${lessonNumber} — ${L.date}`,
    ``,
    `- **Lane / Unit:** ${L.laneId} / ${L.unitId}`,
    `- **Topics:** ${L.topicsFreeform ?? L.topicIds.join(", ")}`,
    `- **Size / model:** ${session.params.size} / ${session.params.model}`,
    ...(usage ? [`- **Usage:** ${usageHeadline(usage)}`] : []),
    ...(timingLine ? [`- **Commit timing:** ${timingLine}`] : []),
    `- **Committed:** ${new Date().toISOString()}`,
    ``,
    `> ${L.whatHappened.replace(/\n/g, " ")}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  // Double-thumbs-down flags that fired live reshaped the conversation — mark
  // them under the flagged message so the tutor's course-correction reads
  // coherently. Other ratings leave no transcript trace (the distilled ledger
  // is their record).
  const flaggedById = new Map(
    (session.feedback ?? []).filter((f) => f.flagged).map((f) => [f.messageId, f])
  );

  const body = session.transcript
    .filter((t) => !t.hidden)
    .map((t) => {
      // Photos the learner sent ride above the message text, pointing at their
      // archived copies (or the live asset route if the copy is missing).
      const photos = (t.images ?? [])
        .map(
          (name) =>
            `![photo from ${learner}](${assetMap.get(name) ?? `/api/assets/local/${name}`})\n\n`
        )
        .join("");
      const flag = t.id ? flaggedById.get(t.id) : undefined;
      const flagNote = flag ? `\n\n> *⏬ ${learner} flagged this: "${flag.note}"*` : "";
      return (
        `### ${t.role === "user" ? learner : "Tutor"}\n\n` +
        photos +
        rewriteArchivedImages(t.text.trim(), assetMap) +
        flagNote
      );
    })
    .join("\n\n");

  return header + body + "\n";
}

/**
 * Copy every embedded image with a proxy-cache hit — and every inbound photo
 * the learner sent — into the lesson's archive dir. Returns original URL (or inbound
 * filename) → transcript-relative path for the rewrite.
 */
function archiveAssets(session: StoredSession, lessonNumber: number): Map<string, string> {
  const map = new Map<string, string>();
  const dirRel = `assets/lesson-${pad(lessonNumber)}`;
  const archive = (sourceFile: string, key: string) => {
    mkdirSync(join(TRANSCRIPTS_DIR, dirRel), { recursive: true });
    const name = basename(sourceFile);
    copyFileSync(sourceFile, join(TRANSCRIPTS_DIR, dirRel, name));
    map.set(key, `${dirRel}/${name}`);
  };
  for (const t of session.transcript) {
    if (t.hidden) continue;
    for (const m of t.text.matchAll(IMG_RE)) {
      const url = m[2];
      if (map.has(url)) continue;
      const cached = cachedAssetFile(url);
      if (cached) archive(cached, url); // no cache hit → leave the URL as-is
    }
    for (const name of t.images ?? []) {
      if (map.has(name)) continue;
      const file = join(ASSETS_DIR, name);
      if (existsSync(file)) archive(file, name);
    }
  }
  return map;
}

export function writeTranscript(
  session: StoredSession,
  patch: SessionPatch,
  lessonNumber: number,
  usage?: LessonUsage,
  timings?: CommitTimings
): string {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const assetMap = archiveAssets(session, lessonNumber);
  const rel = transcriptRelPath(lessonNumber);
  let learner = "Learner";
  try {
    learner = learnerName(readFileSync(PATHS.profile, "utf8"));
  } catch {
    /* no profile — keep the neutral label */
  }
  writeFileSync(
    join(PATHS.dataRoot, rel),
    renderTranscript(session, patch, lessonNumber, assetMap, usage, timings, learner),
    "utf8"
  );
  return rel;
}
