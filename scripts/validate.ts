/**
 * Validate data/curriculum.yaml (graph rules, pointers, states) and check that
 * profile.md and lesson-history.md parse. Run after any hand-edit.
 *
 * Usage: npm run validate
 */
import { loadCurriculum } from "../core/curriculum.js";
import { validateCurriculum } from "../core/validator.js";
import { loadHistory } from "../core/history.js";
import { readProfile, SECTIONS } from "../core/profile.js";
import { DATA_PATHS, ensureDataRoot } from "./lib.js";

ensureDataRoot();

let failed = false;

try {
  const c = loadCurriculum(DATA_PATHS.curriculum);
  const errors = validateCurriculum(c);
  if (errors.length) {
    failed = true;
    console.error(`curriculum.yaml: ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    const nUnits = c.lanes.reduce((n, l) => n + l.units.length, 0);
    const nTopics = c.lanes.reduce(
      (n, l) => n + l.units.reduce((m, u) => m + u.coreTopics.length + u.optionalTopics.length, 0),
      0
    );
    console.log(`curriculum.yaml OK — ${c.lanes.length} lanes, ${nUnits} units, ${nTopics} topics`);
  }
} catch (e) {
  failed = true;
  console.error(`curriculum.yaml failed to load: ${(e as Error).message}`);
}

try {
  const profile = readProfile(DATA_PATHS.profile);
  const missing = Object.values(SECTIONS).filter((h) => !profile.includes(h));
  if (missing.length) {
    failed = true;
    console.error(`profile.md missing expected section(s): ${missing.join("; ")}`);
  } else console.log("profile.md OK — all expected sections present");
} catch (e) {
  failed = true;
  console.error(`profile.md failed to load: ${(e as Error).message}`);
}

try {
  const { entries } = loadHistory(DATA_PATHS.history);
  console.log(`lesson-history.md OK — ${entries.length} entries, newest = Lesson ${entries[0]?.number ?? "n/a"}`);
} catch (e) {
  failed = true;
  console.error(`lesson-history.md failed to load: ${(e as Error).message}`);
}

process.exit(failed ? 1 : 0);
