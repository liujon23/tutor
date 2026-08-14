/**
 * One-time migration: give already-finished units a `completedAt` date.
 *
 * The patcher stamps `completedAt` when a unit first reaches
 * core-complete/complete, but units that finished before that field existed
 * have nothing. This fills them from the lesson record — the date of the last
 * lesson taught in the unit — so the curriculum viewer can show a "when" for
 * every completed unit instead of only the ones finished from here on.
 *
 * Idempotent: only ever fills nulls, never overwrites a real stamp. Safe to
 * re-run, and safe to run on a curriculum that needs no migration at all.
 *
 * Usage:
 *   npm run backfill-completed-at -- --dry-run   # show what would change
 *   npm run backfill-completed-at                # write + git-commit
 */
import { loadCurriculum, saveCurriculum } from "../core/curriculum.js";
import { validateCurriculum } from "../core/validator.js";
import { buildLessonIndex, lessonsForUnit } from "../server/lesson-index.js";
import { DATA_PATHS, gitCommit, parseArgs } from "./lib.js";
import type { UnitState } from "../core/types.js";

const COMPLETED_STATES: UnitState[] = ["core-complete", "complete"];

const args = parseArgs(process.argv.slice(2), { "dry-run": undefined } as {
  "dry-run"?: string;
});
const dryRun = args["dry-run"] === "true";

const c = loadCurriculum(DATA_PATHS.curriculum);
const index = buildLessonIndex();

const filled: { unitId: string; state: string; date: string; lessons: number[] }[] = [];
const skipped: { unitId: string; reason: string }[] = [];

for (const lane of c.lanes) {
  for (const unit of lane.units) {
    if (!COMPLETED_STATES.includes(unit.state)) continue;
    if (unit.completedAt) continue; // already stamped — never overwrite

    const lessons = lessonsForUnit(index, unit.id);
    if (lessons.length === 0) {
      // A unit marked complete with no lesson on record: hand-authored, or its
      // lessons predate every source. Nothing truthful to put here, so leave it
      // null and let the viewer show a state badge with no date.
      skipped.push({ unitId: unit.id, reason: "no lessons on record" });
      continue;
    }
    const date = lessons.reduce((max, e) => (e.date > max ? e.date : max), lessons[0].date);
    unit.completedAt = date;
    filled.push({ unitId: unit.id, state: unit.state, date, lessons: lessons.map((e) => e.lessonNumber) });
  }
}

for (const s of skipped) console.log(`skip  ${s.unitId} — ${s.reason}`);
for (const f of filled) {
  console.log(`fill  ${f.unitId} (${f.state}) → ${f.date}   [lessons ${f.lessons.join(", ")}]`);
}

if (filled.length === 0) {
  console.log("\nNothing to backfill — every completed unit already has a date.");
  process.exit(0);
}

const errors = validateCurriculum(c);
if (errors.length > 0) {
  console.error("\nRefusing to write — curriculum would be invalid:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (dryRun) {
  console.log(`\n--dry-run: ${filled.length} unit(s) would be stamped. Nothing written.`);
  process.exit(0);
}

saveCurriculum(DATA_PATHS.curriculum, c);
console.log(`\ncurriculum.yaml written — ${filled.length} unit(s) stamped.`);
console.log(gitCommit(`Backfill completedAt for ${filled.length} finished unit(s)`));
