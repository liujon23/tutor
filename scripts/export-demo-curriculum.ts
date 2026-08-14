/**
 * Freeze a slice of the real curriculum into the public demo.
 *
 * The Pages demo builds from a clean checkout with no access to the data repo,
 * so the snapshot has to be a committed static file rather than a build step.
 * Run this yourself, review the diff, commit it.
 *
 * What ships is deliberately narrow: the art lane only, and the transcript of
 * the single lesson the demo already replays. Every other lesson row is marked
 * hasTranscript:false and renders inert — the viewer's own "no transcript"
 * treatment, reused so the demo needs no special-casing.
 *
 * Usage:
 *   TUTOR_DATA_DIR=../personal-tutor npm run demo:snapshot
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCurriculumView } from "../server/curriculum-view.js";
import { PATHS, ROOT, parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2), {} as { lane?: string; lesson?: string });
const LANE_ID = args.lane ?? "art";
/** The lesson web/public/demo/lesson.json replays — the only transcript we ship. */
const KEEP_LESSON = Number(args.lesson ?? 13);

/**
 * Archived lesson images are full-resolution originals — the two in lesson 13
 * are 6 MB and 12 MB. That's fine in the private data repo; it is not fine in a
 * public Pages artifact. Anything over this cap is left for a hand-placed
 * downscaled copy at the same path, which re-runs then preserve.
 */
const ASSET_MAX_BYTES = 1_500_000;

const DEMO_DIR = join(ROOT, "web", "public", "demo");
const DEMO_TRANSCRIPTS = join(DEMO_DIR, "transcripts");

const view = buildCurriculumView();
const lane = view.lanes.find((l) => l.id === LANE_ID);
if (!lane) {
  console.error(`No lane '${LANE_ID}' in the curriculum at ${PATHS.curriculum}`);
  process.exit(1);
}

// Gate every transcript entry point to the one lesson we bundle. Two of them:
// the unit's lesson rows, and each topic's "last touched in L<n>" link.
let linkable = 0;
for (const unit of lane.units) {
  for (const lesson of unit.lessons) {
    lesson.hasTranscript = lesson.lessonNumber === KEEP_LESSON;
    if (lesson.hasTranscript) linkable++;
  }
  for (const topic of [...unit.coreTopics, ...unit.optionalTopics]) {
    topic.lastLessonHasTranscript = topic.lastLesson === KEEP_LESSON;
  }
}

const snapshot = { today: view.today, lanes: [lane] };

const pad = String(KEEP_LESSON).padStart(3, "0");
const assetDest = join(DEMO_TRANSCRIPTS, "assets", `lesson-${pad}`);

mkdirSync(DEMO_DIR, { recursive: true });
// Drop transcripts for any lesson no longer in the snapshot, so a dropped
// lesson can't linger in the published demo. The kept lesson's asset folder is
// preserved — it may hold hand-placed downscaled images (see below).
if (existsSync(DEMO_TRANSCRIPTS)) {
  for (const name of readdirSync(DEMO_TRANSCRIPTS)) {
    if (name === "assets" || name === `lesson-${pad}.md`) continue;
    rmSync(join(DEMO_TRANSCRIPTS, name), { recursive: true, force: true });
  }
  const assetsRoot = join(DEMO_TRANSCRIPTS, "assets");
  if (existsSync(assetsRoot)) {
    for (const name of readdirSync(assetsRoot)) {
      if (name !== `lesson-${pad}`) rmSync(join(assetsRoot, name), { recursive: true, force: true });
    }
  }
}
mkdirSync(DEMO_TRANSCRIPTS, { recursive: true });

writeFileSync(join(DEMO_DIR, "curriculum.json"), JSON.stringify(snapshot, null, 2) + "\n", "utf8");

const transcriptSrc = join(PATHS.transcriptsDir, `lesson-${pad}.md`);
if (!existsSync(transcriptSrc)) {
  console.error(`No transcript at ${transcriptSrc} — nothing to bundle for lesson ${KEEP_LESSON}.`);
  process.exit(1);
}
copyFileSync(transcriptSrc, join(DEMO_TRANSCRIPTS, `lesson-${pad}.md`));

// Its archived images ride along at the same relative path the markdown uses —
// but only if they're small enough to publish. An oversized original is skipped
// in favour of whatever downscaled copy already sits at the destination.
const assetSrc = join(PATHS.transcriptsDir, "assets", `lesson-${pad}`);
let copied = 0;
const kept: string[] = [];
const missing: string[] = [];
if (existsSync(assetSrc)) {
  mkdirSync(assetDest, { recursive: true });
  for (const name of readdirSync(assetSrc)) {
    const from = join(assetSrc, name);
    const to = join(assetDest, name);
    if (statSync(from).size <= ASSET_MAX_BYTES) {
      copyFileSync(from, to);
      copied++;
    } else if (existsSync(to) && statSync(to).size <= ASSET_MAX_BYTES) {
      kept.push(name); // a downscaled stand-in is already in place
    } else {
      missing.push(name);
    }
  }
}

const units = lane.units.length;
const lessons = lane.units.reduce((n, u) => n + u.lessons.length, 0);
console.log(`web/public/demo/curriculum.json — lane '${lane.id}', ${units} units, ${lessons} lesson rows`);
console.log(`web/public/demo/transcripts/lesson-${pad}.md`);
console.log(`  ${copied} image(s) copied, ${kept.length} downscaled stand-in(s) kept`);
console.log(`${linkable} lesson row(s) openable in the demo; the rest render inert.`);

if (missing.length > 0) {
  console.warn(
    `\nWARNING: ${missing.length} image(s) exceed ${(ASSET_MAX_BYTES / 1e6).toFixed(1)} MB and were NOT copied.\n` +
      `They'll render as "image unavailable" links in the demo. To include them, put a\n` +
      `downscaled copy at web/public/demo/transcripts/assets/lesson-${pad}/<name> —\n` +
      `re-runs preserve it. Credit any new artwork in web/public/demo/CREDITS.md.\n` +
      missing.map((n) => `  - ${n}`).join("\n")
  );
}

console.log("\nReview the diff and commit these files to the code repo.");
